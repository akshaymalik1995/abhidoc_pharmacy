"""Purchase lists: Purchase Orders, Goods Receipts, Purchase Returns and Wanted Lists are the same
list over purchase_documents, each showing its own document types. Also the read-only view of one document."""
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

router = APIRouter(prefix="/api/purchase", tags=["purchase"])

Kind = Literal["orders", "receipts", "returns", "wanted"]
TYPES: dict[str, tuple[str, ...]] = {
    "orders": ("PURCHASE_ORDER", "DIRECT_PO"),
    "receipts": ("GOODS_RECEIPT", "SUPPLIER_INVOICE"),
    "returns": ("PURCHASE_RETURN",),
    "wanted": ("REORDER_WANTED_LIST", "SALE_BASED_WANTED_LIST", "NEW_PRODUCT_WANTED_LIST"),
}
EXPORT_MAX = 5000


class DocumentRow(BaseModel):
    purchase_document_id: int
    purchase_number: str | None
    purchase_type: str
    status: str
    document_date: date | None
    supplier_name: str | None
    product_count: int | None
    quantity_total: Decimal | None
    received_quantity_total: Decimal
    returned_quantity_total: Decimal
    net_amount_cents: int | None
    outstanding_amount_cents: int | None


class PurchaseSummary(BaseModel):
    open_po_count: int
    wanted_line_count: int
    pending_receipt_count: int
    supplier_payable_cents: int


class DocumentPage(BaseModel):
    rows: list[DocumentRow]
    total: int
    summary: PurchaseSummary
    suppliers: list[Choice]
    statuses: list[str]  # the statuses documents of this list have, for the filter


class PurchaseFilters(BaseModel):
    from_date: date | None = None
    to_date: date | None = None
    supplier_id: int | None = None
    status: Annotated[str, Field(max_length=40, pattern="^[A-Za-z_]*$")] = ""
    q: Annotated[str, Field(max_length=60)] = ""

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.from_date and self.to_date and self.to_date < self.from_date:
            raise ValueError("From date is after To date.")
        return self


def words(code: str | None) -> str:
    """ "PARTIALLY_RECEIVED" -> "Partially received"."""
    if code == "DIRECT_PO":
        return "Direct PO"
    return (code or "").replace("_", " ").capitalize()


def _csv(kind: str, rows: list[dict]) -> Response:
    def guard(text: str) -> str:
        return "'" + text if text[:1] in ("=", "+", "-", "@") else text  # a sheet must not run a cell as a formula

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Number", "Date", "Supplier", "Type", "Status", "Quantity", "Received", "Net amount"])
    for r in rows:
        writer.writerow([
            guard(r["purchase_number"] or ""), r["document_date"] or "", guard(r["supplier_name"] or ""),
            words(r["purchase_type"]), words(r["status"]), r["quantity_total"] or 0, r["received_quantity_total"],
            f"{Decimal(r['net_amount_cents'] or 0) / 100:.2f}",
        ])
    return Response("﻿" + out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="purchase_{kind}.csv"'})


@router.get("/documents", response_model=DocumentPage)
def documents(
    kind: Kind,
    filters: Annotated[PurchaseFilters, Query()],
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    output: Literal["page", "all", "csv"] = "page",
    user: User = Depends(current_user),
):
    types = TYPES[kind]
    marks = ", ".join(["%s"] * len(types))
    where = [f"pd.source_module = 'PHARMACY' AND pd.hospital_id = %s AND pd.purchase_type IN ({marks})"]
    params: list = [user.hospital_id, *types]
    if filters.from_date:
        where.append("pd.document_date >= %s")
        params.append(filters.from_date)
    if filters.to_date:
        where.append("pd.document_date < DATE_ADD(%s, INTERVAL 1 DAY)")
        params.append(filters.to_date)
    if filters.supplier_id:
        where.append("pd.supplier_id = %s")
        params.append(filters.supplier_id)
    if filters.status.upper() == "ALL_OPEN":
        # every document not finished yet: the Open filter of the list and the Dashboard's open purchase orders
        where.append("pd.status IN ('DRAFT', 'OPEN', 'STAGED', 'ORDERED', 'PARTIALLY_RECEIVED', 'PENDING_APPROVAL')")
    elif filters.status:
        where.append("pd.status = %s")
        params.append(filters.status.upper())
    if filters.q.strip():
        where.append("pd.purchase_number LIKE %s ESCAPE '\\\\'")
        params.append(like(filters.q))
    if output != "page":
        limit, offset = EXPORT_MAX, 0

    with transaction() as cur:
        cur.execute(
            "SELECT pd.purchase_document_id, pd.purchase_number, pd.purchase_type, pd.status, pd.document_date,"
            " s.supplier_name, pd.product_count, pd.quantity_total, pd.net_amount_cents, pd.outstanding_amount_cents,"
            " COALESCE(pdi.received, 0) AS received_quantity_total, COALESCE(pdi.returned, 0) AS returned_quantity_total,"
            " COUNT(*) OVER () AS total"
            " FROM purchase_documents pd"
            " LEFT JOIN suppliers s ON s.supplier_id = pd.supplier_id"
            " LEFT JOIN (SELECT purchase_document_id, SUM(received_quantity) AS received, SUM(returned_quantity) AS returned"
            "   FROM purchase_document_items GROUP BY purchase_document_id) pdi"
            "   ON pdi.purchase_document_id = pd.purchase_document_id"
            f" WHERE {' AND '.join(where)}"
            " ORDER BY pd.document_date DESC, pd.purchase_document_id DESC LIMIT %s OFFSET %s",
            (*params, limit, offset),
        )
        rows = cur.fetchall()
        if output == "csv":
            return _csv(kind, rows)

        # the four figures above every purchase list, and what the filters can choose from, in one query each
        cur.execute(
            """
            SELECT CAST(COALESCE(SUM(purchase_type IN ('PURCHASE_ORDER', 'DIRECT_PO', 'PO_GENERATION')
                     AND status IN ('DRAFT', 'OPEN', 'STAGED', 'ORDERED', 'PARTIALLY_RECEIVED', 'PENDING_APPROVAL')), 0) AS SIGNED) AS open_po_count,
                   CAST(COALESCE(SUM(CASE WHEN purchase_type IN ('REORDER_WANTED_LIST', 'SALE_BASED_WANTED_LIST', 'NEW_PRODUCT_WANTED_LIST')
                     AND status IN ('DRAFT', 'OPEN', 'STAGED') THEN product_count ELSE 0 END), 0) AS SIGNED) AS wanted_line_count,
                   CAST(COALESCE(SUM(purchase_type IN ('GOODS_RECEIPT', 'SUPPLIER_INVOICE', 'PURCHASE_ORDER')
                     AND status IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED')), 0) AS SIGNED) AS pending_receipt_count,
                   CAST(COALESCE(SUM(GREATEST(outstanding_amount_cents, 0)), 0) AS SIGNED) AS supplier_payable_cents
              FROM purchase_documents WHERE source_module = 'PHARMACY' AND hospital_id = %s
            """,
            (user.hospital_id,),
        )
        summary = cur.fetchone()
        cur.execute(
            f"SELECT DISTINCT pd.status, pd.supplier_id, s.supplier_name FROM purchase_documents pd"
            f" LEFT JOIN suppliers s ON s.supplier_id = pd.supplier_id"
            f" WHERE pd.source_module = 'PHARMACY' AND pd.hospital_id = %s AND pd.purchase_type IN ({marks})",
            (user.hospital_id, *types),
        )
        seen = cur.fetchall()

    suppliers = {str(r["supplier_id"]): r["supplier_name"] for r in seen if r["supplier_id"] and r["supplier_name"]}
    return DocumentPage(
        rows=rows, total=rows[0]["total"] if rows else 0, summary=summary,
        suppliers=[Choice(value=k, label=v) for k, v in sorted(suppliers.items(), key=lambda kv: kv[1].lower())],
        statuses=sorted({r["status"] for r in seen}),
    )


class PurchaseLine(BaseModel):
    purchase_item_id: int
    description: str | None
    batch_number: str | None
    expiry_date: date | None
    ordered_quantity: Decimal | None
    received_quantity: Decimal | None
    returned_quantity: Decimal | None
    unit_cost_cents: int | None
    unit_mrp_cents: int | None
    gross_amount_cents: int | None
    discount_amount_cents: int | None
    tax_percent: Decimal | None
    tax_amount_cents: int | None
    net_amount_cents: int | None
    line_status: str | None
    purchase_order_reason: str | None


class Document(BaseModel):
    purchase_document_id: int
    purchase_number: str | None
    purchase_type: str
    status: str
    document_date: date | None
    expected_date: date | None
    supplier_name: str | None
    location_name: str | None
    supplier_invoice_number: str | None
    supplier_invoice_date: date | None
    original_purchase_number: str | None  # the receipt a return was sent back from
    notes: str | None
    received_at: datetime | None
    gross_amount_cents: int | None
    discount_amount_cents: int | None
    tax_amount_cents: int | None
    net_amount_cents: int | None
    paid_amount_cents: int | None
    outstanding_amount_cents: int | None
    lines: list[PurchaseLine]


@router.get("/documents/{purchase_document_id}")
def document(purchase_document_id: int, user: User = Depends(current_user)) -> Document:
    with transaction() as cur:
        cur.execute(
            """
            SELECT pd.purchase_document_id, pd.purchase_number, pd.purchase_type, pd.status, pd.document_date,
                   pd.expected_date, s.supplier_name, l.location_name, pd.supplier_invoice_number,
                   pd.supplier_invoice_date, pd.notes, pd.received_at, pd.gross_amount_cents,
                   pd.discount_amount_cents, pd.tax_amount_cents, pd.net_amount_cents, pd.paid_amount_cents,
                   pd.outstanding_amount_cents, src.purchase_number AS original_purchase_number
              FROM purchase_documents pd
              LEFT JOIN suppliers s ON s.supplier_id = pd.supplier_id
              LEFT JOIN stock_locations l ON l.location_id = pd.location_id
              LEFT JOIN purchase_documents src ON src.purchase_document_id = pd.original_purchase_document_id
                   AND src.hospital_id = pd.hospital_id AND src.source_module = 'PHARMACY'
                   AND src.purchase_type = 'GOODS_RECEIPT'
             WHERE pd.purchase_document_id = %s AND pd.source_module = 'PHARMACY' AND pd.hospital_id = %s
            """,
            (purchase_document_id, user.hospital_id),
        )
        found = cur.fetchone()
        if not found:
            raise HTTPException(404, "Purchase document not found.")
        cur.execute(
            """
            SELECT pdi.purchase_item_id, pdi.description, d.batch_number, d.expiry_date, pdi.ordered_quantity,
                   pdi.received_quantity, pdi.returned_quantity, pdi.unit_cost_cents, pdi.unit_mrp_cents,
                   pdi.gross_amount_cents, pdi.discount_amount_cents, pdi.tax_percent, pdi.tax_amount_cents,
                   pdi.net_amount_cents, pdi.line_status, d.purchase_order_reason
              FROM purchase_document_items pdi
              LEFT JOIN purchase_item_pharmacy_details d ON d.purchase_item_id = pdi.purchase_item_id
             WHERE pdi.purchase_document_id = %s
             ORDER BY pdi.line_number
            """,
            (purchase_document_id,),
        )
        lines = cur.fetchall()
    return Document(**found, lines=lines)


class OrderProduct(BaseModel):
    """A product offered on an order form, with what it last cost here so the row starts filled in."""
    item_id: int
    item_name: str
    unit_of_measure: str | None
    tax_percent: Decimal
    last_cost_cents: int | None
    last_mrp_cents: int | None


def _last(column: str) -> str:
    """What this hospital last paid (or was charged) for the product on a goods receipt."""
    return (
        f"(SELECT pdi.{column} FROM purchase_document_items pdi"
        " JOIN purchase_documents pd ON pd.purchase_document_id = pdi.purchase_document_id"
        " WHERE pd.source_module = 'PHARMACY' AND pd.hospital_id = %s"
        " AND pd.purchase_type IN ('GOODS_RECEIPT', 'SUPPLIER_INVOICE') AND pd.status NOT IN ('CANCELLED', 'REJECTED')"
        f" AND pdi.source_item_type = 'PHARMACY_ITEM' AND pdi.source_item_id = i.item_id AND pdi.{column} > 0"
        " ORDER BY pd.document_date DESC, pdi.purchase_item_id DESC LIMIT 1)"
    )


@router.get("/products")
def order_products(q: Annotated[str, Query(max_length=100)] = "", user: User = Depends(current_user)) -> list[OrderProduct]:
    """Up to 20 active products matching the search."""
    if not q.strip():
        return []
    pattern = like(q)
    with transaction() as cur:
        cur.execute(
            "SELECT i.item_id, i.item_name, i.unit_of_measure, i.tax_percent,"
            f" {_last('unit_cost_cents')} AS last_cost_cents, {_last('unit_mrp_cents')} AS last_mrp_cents"
            " FROM pharmacy_items i WHERE i.is_active = 1"
            " AND (i.item_name LIKE %s ESCAPE '\\\\' OR i.generic_name LIKE %s ESCAPE '\\\\' OR i.brand_name LIKE %s ESCAPE '\\\\')"
            " ORDER BY i.item_name LIMIT 20",
            (user.hospital_id, user.hospital_id, pattern, pattern, pattern),
        )
        return cur.fetchall()


@router.get("/suppliers")
def suppliers(user: User = Depends(current_user)) -> list[Choice]:
    """Every active supplier. Suppliers are shared between hospitals, as in DocAssist."""
    with transaction() as cur:
        cur.execute("SELECT CAST(supplier_id AS CHAR) AS value, supplier_name AS label FROM suppliers"
                    " WHERE is_active = 1 ORDER BY supplier_name")
        return cur.fetchall()


class WantedLine(BaseModel):
    purchase_item_id: int
    description: str | None
    manufacturer: str | None
    product_group: str | None
    product_category: str | None
    current_stock_quantity: Decimal | None
    reorder_level: Decimal | None
    sold_quantity: Decimal | None
    average_daily_sale: Decimal | None
    lead_time_days: int | None
    quantity_calculation: str | None  # how a sale-based quantity was worked out, in words
    requested_quantity: Decimal | None
    last_purchase_batch_number: str | None
    last_purchase_cost_cents: int | None
    last_purchase_expiry_date: date | None
    last_purchase_supplier_name: str | None
    supplier_id: int | None
    supplier_name: str | None
    line_status: str
    last_updated: datetime | None


class WantedList(BaseModel):
    purchase_document_id: int
    purchase_number: str | None
    purchase_type: str
    status: str
    document_date: date | None
    location_name: str | None
    lines: list[WantedLine]


class WantedScreen(BaseModel):
    wanted: WantedList | None  # the list asked for, else the hospital's open reorder list, else none
    lists: list[DocumentRow]  # the latest wanted lists of every kind
    suppliers: list[Choice]


def _reference_name(alias: str, reference_type: str, code: str) -> str:
    return (f" LEFT JOIN his_reference_values {alias} ON {alias}.hospital_id = pd.hospital_id"
            f" AND {alias}.reference_type = '{reference_type}' AND {alias}.reference_code = {code}")


@router.get("/wanted")
def wanted(wanted_document_id: int | None = None, user: User = Depends(current_user)) -> WantedScreen:
    """Everything the Wanted List screen shows, in one request."""
    marks = ", ".join(["%s"] * len(TYPES["wanted"]))
    head = (
        "SELECT pd.purchase_document_id, pd.purchase_number, pd.purchase_type, pd.status, pd.document_date,"
        " l.location_name FROM purchase_documents pd LEFT JOIN stock_locations l ON l.location_id = pd.location_id"
        f" WHERE pd.source_module = 'PHARMACY' AND pd.hospital_id = %s AND pd.purchase_type IN ({marks})"
    )
    with transaction() as cur:
        if wanted_document_id:
            cur.execute(head + " AND pd.purchase_document_id = %s", (user.hospital_id, *TYPES["wanted"], wanted_document_id))
            found = cur.fetchone()
            if not found:
                raise HTTPException(404, "Wanted list not found.")
        else:
            cur.execute(
                head + " AND pd.purchase_type = 'REORDER_WANTED_LIST' AND pd.status IN ('DRAFT', 'OPEN', 'STAGED')"
                " ORDER BY pd.purchase_document_id LIMIT 1",
                (user.hospital_id, *TYPES["wanted"]),
            )
            found = cur.fetchone()

        lines = []
        if found:
            group = "COALESCE(NULLIF(i.product_group_code, ''), d.product_group_code)"
            category = "COALESCE(NULLIF(i.product_category_code, ''), d.product_category_code)"
            cur.execute(
                "SELECT pdi.purchase_item_id, pdi.description, pdi.requested_quantity, pdi.line_status,"
                " pdi.supplier_id, s.supplier_name, pdi.updated_at AS last_updated,"
                " COALESCE(mf.display_name, i.manufacturer_code, d.manufacturer_name) AS manufacturer,"
                f" COALESCE(pg.display_name, {group}) AS product_group,"
                f" COALESCE(pc.display_name, {category}) AS product_category,"
                " d.current_stock_quantity, d.reorder_level, d.sold_quantity, d.average_daily_sale, d.lead_time_days,"
                " d.total_quantity_calculation AS quantity_calculation, d.last_purchase_batch_number,"
                " d.last_purchase_cost_cents, d.last_purchase_expiry_date, ls.supplier_name AS last_purchase_supplier_name"
                " FROM purchase_document_items pdi"
                " JOIN purchase_documents pd ON pd.purchase_document_id = pdi.purchase_document_id"
                " LEFT JOIN purchase_item_pharmacy_details d ON d.purchase_item_id = pdi.purchase_item_id"
                " LEFT JOIN pharmacy_items i ON i.item_id = pdi.source_item_id"
                " LEFT JOIN suppliers s ON s.supplier_id = pdi.supplier_id"
                " LEFT JOIN suppliers ls ON ls.supplier_id = d.last_purchase_supplier_id"
                + _reference_name("mf", "MANUFACTURER", "i.manufacturer_code")
                + _reference_name("pg", "PRODUCT_GROUP", group)
                + _reference_name("pc", "PRODUCT_CATEGORY", category)
                + " WHERE pdi.purchase_document_id = %s ORDER BY pdi.line_number",
                (found["purchase_document_id"],),
            )
            lines = cur.fetchall()

        cur.execute(
            "SELECT pd.purchase_document_id, pd.purchase_number, pd.purchase_type, pd.status, pd.document_date,"
            " NULL AS supplier_name, pd.product_count, pd.quantity_total, pd.net_amount_cents, pd.outstanding_amount_cents,"
            " 0 AS received_quantity_total, 0 AS returned_quantity_total FROM purchase_documents pd"
            f" WHERE pd.source_module = 'PHARMACY' AND pd.hospital_id = %s AND pd.purchase_type IN ({marks})"
            " ORDER BY pd.purchase_document_id DESC LIMIT 25",
            (user.hospital_id, *TYPES["wanted"]),
        )
        lists = cur.fetchall()
        cur.execute("SELECT CAST(supplier_id AS CHAR) AS value, supplier_name AS label FROM suppliers"
                    " WHERE is_active = 1 ORDER BY supplier_name")
        all_suppliers = cur.fetchall()
    return WantedScreen(wanted={**found, "lines": lines} if found else None, lists=lists, suppliers=all_suppliers)
