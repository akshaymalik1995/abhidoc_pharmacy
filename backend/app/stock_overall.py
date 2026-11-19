"""Overall Stocks: every shelf row (product, batch, location) with its quantity and worth."""
import csv
import io
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, StringConstraints

from .auth import User, current_user
from .common import Choice
from .db import transaction
from .sql import like

router = APIRouter(prefix="/api/stock", tags=["stock"])

EXPIRY_WINDOW_DAYS = 90  # "near expiry" means within this many days
EXPORT_MAX = 5000  # the most rows one export or print carries


class StockRow(BaseModel):
    stock_balance_id: int
    item_id: int
    batch_id: int | None
    location_id: int
    item_name: str
    generic_name: str | None
    location_name: str | None
    rack_code: str | None
    bin_code: str | None
    batch_number: str | None
    expiry_date: date | None
    quantity_on_hand: Decimal
    reserved_quantity: Decimal
    in_transit_quantity: Decimal
    damaged_quantity: Decimal
    consignment_quantity: Decimal
    reorder_level: Decimal
    unit_cost_cents: int
    landed_cost_cents: int
    unit_mrp_cents: int
    landed_value_cents: int
    mrp_value_cents: int
    tax_percent: Decimal | None
    is_active: bool
    statuses: list[str]


class LocationTotal(BaseModel):
    location_name: str | None  # None on the row that totals every location
    quantity: Decimal
    landed_value_cents: int
    mrp_value_cents: int
    in_transit_quantity: Decimal
    in_transit_landed_value_cents: int
    in_transit_mrp_value_cents: int


class OverallStock(BaseModel):
    items: list[StockRow]
    total: int
    location_totals: list[LocationTotal]
    grand_total: LocationTotal
    locations: list[Choice]


class OverallFilters(BaseModel):
    q: Annotated[str, Field(max_length=100)] = ""
    alert: Literal["", "low", "expiring"] = ""
    location_id: int | None = None
    expiry_to: date | None = None
    rack: Annotated[str, Field(max_length=64)] = ""
    bin: Annotated[str, Field(max_length=64)] = ""
    manufacturer: Annotated[str, Field(max_length=64)] = ""
    category: Annotated[str, Field(max_length=64)] = ""
    include_zero: bool = False


def _statuses(row: dict) -> list[str]:
    words = []
    if not row["is_active"]:
        words.append("Inactive")
    if row["quantity_on_hand"] <= row["reorder_level"]:
        words.append("Low")
    if row["expiring"]:
        words.append("Expiring")
    if row["consignment_quantity"] > 0 or row["is_consignment_product"]:
        words.append("Consignment")
    return words or ["In stock"]


def _source(filters: OverallFilters, hospital_id: int) -> tuple[str, list]:
    """FROM ... WHERE ... for the shelf rows the filters leave, with its parameters."""
    cutoff = date.today() + timedelta(days=EXPIRY_WINDOW_DAYS)
    where = ["b.source_module = 'PHARMACY'", "b.is_active = 1", "l.hospital_id = %s"]
    params: list = [hospital_id]
    if filters.q.strip():
        columns = ("i.item_name", "i.generic_name", "i.product_code", "i.hsn_code", "b.rack_code", "b.bin_code",
                   "l.location_name", "CAST(b.item_id AS CHAR)", "ib.batch_number")
        where.append("(" + " OR ".join(f"{column} LIKE %s ESCAPE '\\\\'" for column in columns) + ")")
        params += [like(filters.q)] * len(columns)
    for column, value in (
        ("b.location_id", filters.location_id), ("b.rack_code", filters.rack), ("b.bin_code", filters.bin),
        ("i.manufacturer_code", filters.manufacturer), ("i.product_category_code", filters.category),
    ):
        if value:
            where.append(f"{column} = %s")
            params.append(value)
    if filters.expiry_to:
        where.append("ib.expiry_date <= %s")
        params.append(filters.expiry_to)
    if not filters.include_zero:
        where.append("(b.quantity_on_hand > 0 OR b.reserved_quantity > 0 OR b.in_transit_quantity > 0"
                     " OR b.damaged_quantity > 0 OR b.consignment_quantity > 0)")
    if filters.alert == "low":
        where.append("b.quantity_on_hand <= b.reorder_level")
    elif filters.alert == "expiring":
        where.append("b.quantity_on_hand > 0 AND ib.expiry_date >= CURDATE() AND ib.expiry_date <= %s")
        params.append(cutoff)
    source = (
        " FROM inventory_stock_balances b"
        " JOIN stock_locations l ON l.location_id = b.location_id"
        " LEFT JOIN pharmacy_items i ON i.item_id = b.item_id"
        " LEFT JOIN inventory_batches ib ON ib.batch_id = b.batch_id"
        f" WHERE {' AND '.join(where)}"
    )
    return source, params


_ROW_COLUMNS = (
    "SELECT b.stock_balance_id, b.item_id, b.batch_id, b.location_id, COALESCE(i.item_name, CONCAT('Item #', b.item_id)) AS item_name, i.generic_name,"
    " l.location_name, b.rack_code, b.bin_code, ib.batch_number, ib.expiry_date,"
    " b.quantity_on_hand, b.reserved_quantity, b.in_transit_quantity, b.damaged_quantity, b.consignment_quantity,"
    " b.reorder_level, b.unit_cost_cents, b.landed_cost_cents, b.unit_mrp_cents, i.tax_percent, b.is_active,"
    " CAST(ROUND(b.quantity_on_hand * b.landed_cost_cents, 0) AS SIGNED) AS landed_value_cents,"
    " CAST(ROUND(b.quantity_on_hand * b.unit_mrp_cents, 0) AS SIGNED) AS mrp_value_cents,"
    " COALESCE(i.is_consignment_product, 0) AS is_consignment_product,"
    " (b.quantity_on_hand > 0 AND ib.expiry_date >= CURDATE() AND ib.expiry_date <= %s) AS expiring,"
    " COUNT(*) OVER () AS total"
)
# the order ends on the shelf row itself, so the screen's pages, the export and the print agree
_ROW_ORDER = " ORDER BY item_name, b.stock_balance_id LIMIT %s OFFSET %s"


def _rows(cur, filters: OverallFilters, hospital_id: int, limit: int, offset: int) -> tuple[list[dict], int]:
    source, params = _source(filters, hospital_id)
    cutoff = date.today() + timedelta(days=EXPIRY_WINDOW_DAYS)
    cur.execute(_ROW_COLUMNS + source + _ROW_ORDER, (cutoff, *params, limit, offset))
    rows = cur.fetchall()
    for row in rows:
        row["statuses"] = _statuses(row)
    return rows, (rows[0]["total"] if rows else 0)


def _csv(rows: list[dict], total: int) -> Response:
    def rupees(cents) -> str:
        return f"{Decimal(cents or 0) / 100:.2f}"

    def quantity(value) -> str:
        return format(Decimal(value or 0).normalize(), "f")

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Pharmacy item", "Location", "Rack", "Bin", "Batch", "Expiry", "Status", "Qty", "Unavailable",
                     "Landed total", "MRP total", "Unit cost", "MRP", "GST %", "Generic", "Reorder level", "In transit"])
    for r in rows:
        unavailable = r["reserved_quantity"] + r["in_transit_quantity"] + r["damaged_quantity"]
        writer.writerow([
            r["item_name"], r["location_name"] or "", r["rack_code"] or "", r["bin_code"] or "",
            r["batch_number"] or "", r["expiry_date"] or "", " / ".join(r["statuses"]),
            quantity(r["quantity_on_hand"]), quantity(unavailable), rupees(r["landed_value_cents"]),
            rupees(r["mrp_value_cents"]), rupees(r["unit_cost_cents"]), rupees(r["unit_mrp_cents"]),
            r["tax_percent"] or 0, r["generic_name"] or "", quantity(r["reorder_level"]),
            quantity(r["in_transit_quantity"]),
        ])
    if total > len(rows):
        writer.writerow([f"Only the first {len(rows)} of {total} rows are in this file."])
    # the byte-order mark makes Excel read the rupee figures and names as UTF-8
    return Response("﻿" + out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="overall_stocks.csv"'})


@router.get("/overall", response_model=OverallStock)
def overall(
    filters: Annotated[OverallFilters, Query()],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    output: Literal["page", "all", "csv"] = "page",  # all: every row, for print; csv: the same as a file
    user: User = Depends(current_user),
):
    with transaction() as cur:
        if output != "page":
            limit, offset = EXPORT_MAX, 0
        rows, total = _rows(cur, filters, user.hospital_id, limit, offset)
        if output == "csv":
            return _csv(rows, total)

        source, params = _source(filters, user.hospital_id)
        cur.execute(
            "SELECT l.location_name, GROUPING(l.location_id) AS is_grand_total,"
            " COALESCE(SUM(b.quantity_on_hand), 0) AS quantity,"
            " CAST(COALESCE(SUM(ROUND(b.quantity_on_hand * b.landed_cost_cents, 0)), 0) AS SIGNED) AS landed_value_cents,"
            " CAST(COALESCE(SUM(ROUND(b.quantity_on_hand * b.unit_mrp_cents, 0)), 0) AS SIGNED) AS mrp_value_cents,"
            " COALESCE(SUM(b.in_transit_quantity), 0) AS in_transit_quantity,"
            " CAST(COALESCE(SUM(ROUND(b.in_transit_quantity * b.landed_cost_cents, 0)), 0) AS SIGNED) AS in_transit_landed_value_cents,"
            " CAST(COALESCE(SUM(ROUND(b.in_transit_quantity * b.unit_mrp_cents, 0)), 0) AS SIGNED) AS in_transit_mrp_value_cents"
            + source + " GROUP BY l.location_id, l.location_name WITH ROLLUP"
            " HAVING GROUPING(l.location_id) = 1 OR GROUPING(l.location_name) = 0"
            " ORDER BY is_grand_total, landed_value_cents DESC, l.location_name",
            params,
        )
        totals = cur.fetchall()
        cur.execute(
            "SELECT CAST(location_id AS CHAR) AS value, location_name AS label FROM stock_locations"
            " WHERE hospital_id = %s AND is_active = 1 AND is_stock_location = 1 ORDER BY location_name",
            (user.hospital_id,),
        )
        locations = cur.fetchall()

    nothing = {"location_name": None, "quantity": 0, "landed_value_cents": 0, "mrp_value_cents": 0,
               "in_transit_quantity": 0, "in_transit_landed_value_cents": 0, "in_transit_mrp_value_cents": 0}
    grand = next((row for row in totals if row["is_grand_total"]), nothing)
    return OverallStock(
        items=rows, total=total, locations=locations, grand_total={**grand, "location_name": None},
        location_totals=[row for row in totals if not row["is_grand_total"]],
    )


Rupees = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]
ShelfCode = Annotated[str, StringConstraints(strip_whitespace=True, max_length=64)]


class ShelfEdit(BaseModel):
    """What can be corrected on a shelf row. Quantities are not here: they move only through counts and documents."""
    reorder_level: Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=3)]
    unit_cost: Rupees
    landed_cost: Rupees
    unit_mrp: Rupees
    rack_code: ShelfCode
    bin_code: ShelfCode
    is_active: bool


def _cents(rupees: Decimal) -> int:
    return int((rupees * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


@router.put("/balances/{stock_balance_id}", status_code=204)
def edit_shelf_row(stock_balance_id: int, edit: ShelfEdit, user: User = Depends(current_user)) -> None:
    with transaction() as cur:
        cur.execute(
            "SELECT b.quantity_on_hand FROM inventory_stock_balances b"
            " JOIN stock_locations l ON l.location_id = b.location_id"
            " WHERE b.stock_balance_id = %s AND b.source_module = 'PHARMACY' AND l.hospital_id = %s FOR UPDATE",
            (stock_balance_id, user.hospital_id),
        )
        shelf = cur.fetchone()
        if not shelf:
            raise HTTPException(404, "Batch not found. Reload the page and try again.")
        mrp_cents = _cents(edit.unit_mrp)
        mrp_amount = int((mrp_cents * shelf["quantity_on_hand"]).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        cur.execute(
            "UPDATE inventory_stock_balances SET reorder_level = %s, unit_cost_cents = %s, landed_cost_cents = %s,"
            " unit_mrp_cents = %s, mrp_amount_cents = %s, rack_code = %s, bin_code = %s, is_active = %s,"
            " last_movement_at = NOW() WHERE stock_balance_id = %s",
            (edit.reorder_level, _cents(edit.unit_cost), _cents(edit.landed_cost), mrp_cents, mrp_amount,
             edit.rack_code, edit.bin_code, int(edit.is_active), stock_balance_id),
        )
