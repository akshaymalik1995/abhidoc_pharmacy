"""Stock Ledger: per product, the opening stock of a period, what came in, what went out, the closing stock.

Opening and closing are worked backwards from today's book (today's quantity minus every
movement since), so each figure reconciles to the stock movements.
"""
import csv
import io
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from .auth import User, current_user
from .common import Choice
from .db import transaction
from .sql import like

router = APIRouter(prefix="/api/stock", tags=["stock"])

EXPORT_MAX = 5000


class LedgerRow(BaseModel):
    item_id: int
    item_name: str
    generic_name: str | None
    product_code: str | None
    product_group: str | None
    product_category: str | None
    unit_of_measure: str | None
    opening_quantity: Decimal
    opening_value_cents: int
    in_quantity: Decimal
    in_value_cents: int
    out_quantity: Decimal
    out_value_cents: int
    closing_quantity: Decimal
    closing_value_cents: int


class LedgerTotals(BaseModel):
    opening_quantity: Decimal = Decimal(0)
    opening_value_cents: int = 0
    in_quantity: Decimal = Decimal(0)
    in_value_cents: int = 0
    out_quantity: Decimal = Decimal(0)
    out_value_cents: int = 0
    closing_quantity: Decimal = Decimal(0)
    closing_value_cents: int = 0
    in_transit_quantity: Decimal = Decimal(0)


class Ledger(BaseModel):
    items: list[LedgerRow]
    total: int
    totals: LedgerTotals
    locations: list[Choice]
    product_groups: list[Choice]
    product_categories: list[Choice]


class LedgerFilters(BaseModel):
    from_date: date | None = None
    to_date: date | None = None
    location_id: int | None = None
    product_group_code: Annotated[str, Field(max_length=64)] = ""
    product_category_code: Annotated[str, Field(max_length=64)] = ""
    q: Annotated[str, Field(max_length=128)] = ""

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.from_date and self.to_date and self.to_date < self.from_date:
            raise ValueError("From date is after To date.")
        return self


_SUMS = (
    "COALESCE(SUM(opening_quantity), 0) AS opening_quantity,"
    " CAST(COALESCE(SUM(opening_value_cents), 0) AS SIGNED) AS opening_value_cents,"
    " COALESCE(SUM(in_quantity), 0) AS in_quantity, CAST(COALESCE(SUM(in_value_cents), 0) AS SIGNED) AS in_value_cents,"
    " COALESCE(SUM(out_quantity), 0) AS out_quantity, CAST(COALESCE(SUM(out_value_cents), 0) AS SIGNED) AS out_value_cents,"
    " COALESCE(SUM(closing_quantity), 0) AS closing_quantity,"
    " CAST(COALESCE(SUM(closing_value_cents), 0) AS SIGNED) AS closing_value_cents,"
    " COALESCE(SUM(in_transit_quantity), 0) AS in_transit_quantity, COUNT(*) AS products"
)


def _ledger_sql(filters: LedgerFilters, hospital_id: int) -> tuple[str, list]:
    """One row per product, as a derived table the caller pages, sums or exports."""
    from_start = f"{filters.from_date or date(1970, 1, 1)} 00:00:00"
    to_end = f"{filters.to_date or date.today()} 23:59:59.999999"
    one_store = bool(filters.location_id)

    balance_where, balance_params = "", [hospital_id]
    movement_where, movement_params = "", [to_end] * 6 + [from_start, hospital_id]
    if one_store:
        balance_where = " AND b.location_id = %s"
        balance_params.append(filters.location_id)
        movement_where = " AND m.location_id = %s"
        movement_params.append(filters.location_id)

    # What counts as coming in or going out depends on the view.
    # One store: a transfer is outward for the store that sends and inward for the one that receives.
    # All stores: a transfer between two stores of the hospital changes nothing in the hospital's
    # stock, so it is in neither column; what is on its way still belongs to the hospital and is
    # counted in opening and closing.
    # A relocation between racks of one store is never inward or outward.
    if one_store:
        counted = "1 = 1"
        flow = ("NOT (m.movement_type = 'RELOCATION' AND COALESCE(m.from_location_id, m.location_id)"
                " = COALESCE(m.to_location_id, m.location_id))")
    else:
        counted = "m.movement_type NOT IN ('TRANSFER_OUT', 'TRANSFER_IN')"
        flow = counted + " AND m.movement_type <> 'RELOCATION'"

    # A dispense posts quantity only, so its cost is read off the shelf row it moved.
    cost = "COALESCE(NULLIF(m.unit_cost_cents, 0), bl.unit_cost_cents, 0)"

    transit_join, transit_params, transit_qty, transit_value = "", [], "0", "0"
    if not one_store:
        transit_join = (
            " LEFT JOIN (SELECT m.item_id, -SUM(m.quantity_change) AS in_transit_quantity,"
            f" -SUM(m.quantity_change * {cost}) AS in_transit_value_cents"
            " FROM inventory_stock_movements m"
            " LEFT JOIN inventory_stock_balances bl ON bl.stock_balance_id = m.stock_balance_id"
            " JOIN stock_locations l ON l.location_id = m.location_id"
            " WHERE m.stock_document_id IS NOT NULL AND l.hospital_id = %s"
            " AND m.movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN') GROUP BY m.item_id) tr ON tr.item_id = i.item_id"
        )
        transit_params = [hospital_id]
        transit_qty, transit_value = "COALESCE(tr.in_transit_quantity, 0)", "COALESCE(tr.in_transit_value_cents, 0)"

    # The catalog is shared, so a product is on this hospital's ledger only when it has a shelf
    # row here or a movement here in the period.
    where = ["(bal.item_id IS NOT NULL OR mv.item_id IS NOT NULL" + ("" if one_store else " OR tr.item_id IS NOT NULL") + ")"]
    params: list = []
    if filters.product_group_code:
        where.append("i.product_group_code = %s")
        params.append(filters.product_group_code)
    if filters.product_category_code:
        where.append("i.product_category_code = %s")
        params.append(filters.product_category_code)
    if filters.q.strip():
        columns = ("i.item_name", "i.generic_name", "i.product_code", "i.hsn_code", "CAST(i.item_id AS CHAR)")
        where.append("(" + " OR ".join(f"{column} LIKE %s ESCAPE '\\\\'" for column in columns) + ")")
        params += [like(filters.q)] * len(columns)

    def moved(condition: str, amount: str) -> str:
        return f"SUM(CASE WHEN {condition} THEN {amount} ELSE 0 END)"

    sql = (
        # The opening value of a product with no opening stock is 0, and closing value is
        # opening + inward - outward, so every row adds up in value as it does in quantity.
        "SELECT t0.*,"
        " CASE WHEN t0.opening_quantity = 0 THEN 0 ELSE t0.raw_opening_value_cents END AS opening_value_cents,"
        " (CASE WHEN t0.opening_quantity = 0 THEN 0 ELSE t0.raw_opening_value_cents END"
        "  + t0.in_value_cents - t0.out_value_cents) AS closing_value_cents"
        " FROM (SELECT i.item_id, COALESCE(i.item_name, CONCAT('Item #', i.item_id)) AS item_name,"
        " i.generic_name, i.product_code, i.unit_of_measure,"
        " COALESCE(pg.display_name, i.product_group_code) AS product_group,"
        " COALESCE(pc.display_name, i.product_category_code) AS product_category,"
        f" {transit_qty} AS in_transit_quantity,"
        f" (COALESCE(bal.current_quantity, 0) + {transit_qty} - COALESCE(mv.since_from_qty, 0)) AS opening_quantity,"
        f" (COALESCE(bal.current_quantity, 0) + {transit_qty} - COALESCE(mv.after_to_qty, 0)) AS closing_quantity,"
        f" CAST(ROUND(COALESCE(bal.current_value_cents, 0) + {transit_value}"
        "   - COALESCE(mv.since_from_value_cents, 0), 0) AS SIGNED) AS raw_opening_value_cents,"
        " COALESCE(mv.in_quantity, 0) AS in_quantity,"
        " CAST(ROUND(COALESCE(mv.in_value_cents, 0), 0) AS SIGNED) AS in_value_cents,"
        " COALESCE(mv.out_quantity, 0) AS out_quantity,"
        " CAST(ROUND(COALESCE(mv.out_value_cents, 0), 0) AS SIGNED) AS out_value_cents"
        " FROM pharmacy_items i"
        " LEFT JOIN (SELECT b.item_id, SUM(b.quantity_on_hand) AS current_quantity,"
        "   SUM(b.quantity_on_hand * b.unit_cost_cents) AS current_value_cents"
        "   FROM inventory_stock_balances b JOIN stock_locations l ON l.location_id = b.location_id"
        f"  WHERE b.source_module = 'PHARMACY' AND b.is_active = 1 AND l.hospital_id = %s{balance_where}"
        "   GROUP BY b.item_id) bal ON bal.item_id = i.item_id"
        " LEFT JOIN (SELECT m.item_id,"
        f" {moved(counted, 'm.quantity_change')} AS since_from_qty,"
        f" {moved('m.created_at >= %s AND ' + counted, 'm.quantity_change')} AS after_to_qty,"
        f" {moved(counted, 'm.quantity_change * ' + cost)} AS since_from_value_cents,"
        f" {moved('m.created_at >= %s AND ' + counted, 'm.quantity_change * ' + cost)} AS after_to_value_cents,"
        f" {moved('m.created_at <= %s AND m.quantity_change > 0 AND ' + flow, 'm.quantity_change')} AS in_quantity,"
        f" {moved('m.created_at <= %s AND m.quantity_change > 0 AND ' + flow, 'm.quantity_change * ' + cost)} AS in_value_cents,"
        f" {moved('m.created_at <= %s AND m.quantity_change < 0 AND ' + flow, '-m.quantity_change')} AS out_quantity,"
        f" {moved('m.created_at <= %s AND m.quantity_change < 0 AND ' + flow, '-m.quantity_change * ' + cost)} AS out_value_cents"
        " FROM inventory_stock_movements m"
        " LEFT JOIN inventory_stock_balances bl ON bl.stock_balance_id = m.stock_balance_id"
        " JOIN stock_locations l ON l.location_id = m.location_id"
        # bounded below by the period start: anything older only affects opening, which is derived
        f" WHERE m.stock_document_id IS NOT NULL AND m.created_at >= %s AND l.hospital_id = %s{movement_where}"
        " GROUP BY m.item_id) mv ON mv.item_id = i.item_id"
        + transit_join +
        " LEFT JOIN his_reference_values pg ON pg.hospital_id = %s AND pg.reference_type = 'PRODUCT_GROUP'"
        "   AND pg.reference_code = i.product_group_code"
        " LEFT JOIN his_reference_values pc ON pc.hospital_id = %s AND pc.reference_type = 'PRODUCT_CATEGORY'"
        "   AND pc.reference_code = i.product_category_code"
        f" WHERE {' AND '.join(where)}) t0"
    )
    return sql, [*balance_params, *movement_params, *transit_params, hospital_id, hospital_id, *params]


def _csv(rows: list[dict], totals: dict) -> Response:
    def rupees(cents) -> str:
        return f"{Decimal(cents or 0) / 100:.2f}"

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Product", "Generic", "Product Code", "Product Group", "Product Category", "Unit",
                     "Opening Qty", "Opening Value", "In Qty", "In Value", "Out Qty", "Out Value",
                     "Closing Qty", "Closing Value"])
    for r in (*rows, {**totals, "item_name": "TOTAL"}):
        writer.writerow([
            r["item_name"], r.get("generic_name") or "", r.get("product_code") or "", r.get("product_group") or "",
            r.get("product_category") or "", r.get("unit_of_measure") or "",
            r["opening_quantity"], rupees(r["opening_value_cents"]), r["in_quantity"], rupees(r["in_value_cents"]),
            r["out_quantity"], rupees(r["out_value_cents"]), r["closing_quantity"], rupees(r["closing_value_cents"]),
        ])
    return Response("﻿" + out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="stock_ledger.csv"'})


@router.get("/ledger", response_model=Ledger)
def ledger(
    filters: Annotated[LedgerFilters, Query()],
    limit: Annotated[int, Query(ge=1, le=200)] = 25,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    output: Literal["page", "all", "csv"] = "page",
    user: User = Depends(current_user),
):
    hospital = user.hospital_id
    sql, params = _ledger_sql(filters, hospital)
    with transaction() as cur:
        if filters.location_id:
            cur.execute(
                "SELECT 1 FROM stock_locations WHERE location_id = %s AND hospital_id = %s AND is_stock_location = 1",
                (filters.location_id, hospital),
            )
            if not cur.fetchone():
                raise HTTPException(422, "That store is not a stock location of this hospital.")

        cur.execute(f"SELECT {_SUMS} FROM ({sql}) t", params)
        totals = cur.fetchone()
        if output != "page":
            # never drop rows silently while the totals still count them
            if totals["products"] > EXPORT_MAX:
                raise HTTPException(422, f"The export has more than {EXPORT_MAX} products; narrow the filters.")
            limit, offset = EXPORT_MAX, 0
        cur.execute(f"{sql} ORDER BY item_name, item_id LIMIT %s OFFSET %s", (*params, limit, offset))
        rows = cur.fetchall()
        if output == "csv":
            return _csv(rows, totals)

        cur.execute(
            "SELECT CAST(location_id AS CHAR) AS value, location_name AS label FROM stock_locations"
            " WHERE hospital_id = %s AND is_active = 1 AND is_stock_location = 1 ORDER BY location_name",
            (hospital,),
        )
        locations = cur.fetchall()
        cur.execute(
            "SELECT reference_type, reference_code AS value, display_name AS label FROM his_reference_values"
            " WHERE hospital_id = %s AND is_active = 1 AND reference_type IN ('PRODUCT_GROUP', 'PRODUCT_CATEGORY')"
            " ORDER BY sort_order, reference_value_id",
            (hospital,),
        )
        choices = cur.fetchall()

    return Ledger(
        items=rows, total=totals["products"], totals=totals, locations=locations,
        product_groups=[c for c in choices if c["reference_type"] == "PRODUCT_GROUP"],
        product_categories=[c for c in choices if c["reference_type"] == "PRODUCT_CATEGORY"],
    )


class DiaryLine(BaseModel):
    created_at: datetime
    movement_type: str
    reference_type: str | None
    batch_number: str | None
    location_name: str | None
    stock_number: str | None
    notes: str | None
    quantity_change: Decimal
    running_quantity: Decimal


class Diary(BaseModel):
    item_name: str
    opening_quantity: Decimal
    in_quantity: Decimal
    out_quantity: Decimal
    closing_quantity: Decimal
    first_movement: date | None  # the day the recorded movements begin
    lines: list[DiaryLine]  # at most 500


class DiaryFilters(BaseModel):
    from_date: date | None = None
    to_date: date | None = None
    location_id: int | None = None

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.from_date and self.to_date and self.to_date < self.from_date:
            raise ValueError("From date is after To date.")
        return self


@router.get("/ledger/{item_id}/diary")
def diary(item_id: int, filters: Annotated[DiaryFilters, Query()], user: User = Depends(current_user)) -> Diary:
    """Every movement of one product in a period, with the quantity left after each."""
    from_start = f"{filters.from_date or date(1970, 1, 1)} 00:00:00"
    to_end = f"{filters.to_date or date.today()} 23:59:59.999999"
    store, store_params = ("", []) if not filters.location_id else (" AND {0}.location_id = %s", [filters.location_id])
    scope = [item_id, user.hospital_id, *store_params]
    movements = ("FROM inventory_stock_movements m JOIN stock_locations l ON l.location_id = m.location_id"
                 " WHERE m.item_id = %s AND m.stock_document_id IS NOT NULL AND l.hospital_id = %s" + store.format("m"))
    with transaction() as cur:
        cur.execute("SELECT item_name FROM pharmacy_items WHERE item_id = %s", (item_id,))
        item = cur.fetchone()
        if not item:
            raise HTTPException(404, "Product not found.")
        cur.execute(
            "SELECT COALESCE(SUM(b.quantity_on_hand), 0) AS quantity FROM inventory_stock_balances b"
            " JOIN stock_locations l ON l.location_id = b.location_id"
            " WHERE b.source_module = 'PHARMACY' AND b.is_active = 1 AND b.item_id = %s AND l.hospital_id = %s"
            + store.format("b"),
            scope,
        )
        today = cur.fetchone()["quantity"]
        cur.execute(
            "SELECT COALESCE(SUM(CASE WHEN m.created_at >= %s THEN m.quantity_change ELSE 0 END), 0) AS since_from,"
            " COALESCE(SUM(CASE WHEN m.created_at > %s THEN m.quantity_change ELSE 0 END), 0) AS after_to,"
            f" MIN(m.created_at) AS first_movement {movements}",
            (from_start, to_end, *scope),
        )
        sums = cur.fetchone()
        cur.execute(
            "SELECT m.created_at, m.movement_type, m.reference_type, ib.batch_number, l.location_name, d.stock_number, m.notes,"
            f" m.quantity_change {movements.replace(' WHERE ', ' LEFT JOIN stock_documents d ON d.stock_document_id = m.stock_document_id LEFT JOIN inventory_batches ib ON ib.batch_id = m.batch_id WHERE ', 1)}"
            " AND m.created_at >= %s AND m.created_at <= %s ORDER BY m.movement_id LIMIT 500",
            (*scope, from_start, to_end),
        )
        lines = cur.fetchall()

    # worked backwards from today's book, like the ledger itself
    opening = today - sums["since_from"]
    running, came_in, went_out = opening, Decimal(0), Decimal(0)
    for line in lines:
        running += line["quantity_change"]
        line["running_quantity"] = running
        if line["quantity_change"] > 0:
            came_in += line["quantity_change"]
        else:
            went_out -= line["quantity_change"]
    return Diary(
        item_name=item["item_name"], opening_quantity=opening, in_quantity=came_in, out_quantity=went_out,
        closing_quantity=today - sums["after_to"], lines=lines,
        first_movement=sums["first_movement"].date() if sums["first_movement"] else None,
    )
