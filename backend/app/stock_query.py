"""Stock Query: everything about one product in this hospital, in one request."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .auth import User, current_user
from .db import transaction
from .sql import like

router = APIRouter(prefix="/api/stock/query", tags=["stock"])

SEARCH_MAX = 30  # the most products the search offers at once


class Product(BaseModel):
    item_id: int
    item_name: str
    is_active: bool


class ProductSearch(BaseModel):
    items: list[Product]
    more: bool


class StockSummary(BaseModel):
    on_hand: Decimal
    damaged: Decimal
    in_transit: Decimal
    value_cents: int


class Purchase(BaseModel):
    document_date: date | None
    supplier_name: str | None
    grn_number: str | None
    invoice_number: str | None
    batch_number: str | None
    expiry_date: date | None
    packing: str | None
    received_quantity: Decimal | None
    free_quantity: Decimal | None
    unit_cost_cents: int | None
    unit_mrp_cents: int | None
    discount_amount_cents: int | None
    override_discount_percent: Decimal | None
    tax_amount_cents: int | None
    net_amount_cents: int | None


class Sale(BaseModel):
    document_date: date | None
    sales_number: str | None
    patient_name: str | None
    referral_doctor: str | None
    batch_number: str | None
    expiry_date: date | None
    quantity: Decimal | None
    returned_quantity: Decimal
    net_amount_cents: int | None
    payment_modes: str | None


class Shelf(BaseModel):
    location_name: str
    batch_number: str | None
    expiry_date: date | None
    rack_code: str | None
    bin_code: str | None
    quantity_on_hand: Decimal
    damaged_quantity: Decimal


class Movement(BaseModel):
    created_at: datetime
    movement_type: str
    batch_number: str | None
    location_name: str | None
    quantity_change: Decimal
    reference_number: str | None


class Issue(BaseModel):
    document_date: date | None
    stock_number: str | None
    stock_type: str
    status: str
    from_location_name: str | None
    issue_location_name: str | None
    issued_quantity: Decimal | None
    return_quantity: Decimal | None


class StockQuery(BaseModel):
    item_id: int
    item_name: str
    generic_name: str | None
    unit_of_measure: str | None
    summary: StockSummary
    purchases: list[Purchase]  # last 10
    sales: list[Sale]  # last 30
    shelves: list[Shelf]
    movements: list[Movement]  # last 50
    issues: list[Issue]  # last 30


@router.get("/products")
def search_products(q: Annotated[str, Query(max_length=100)] = "", user: User = Depends(current_user)) -> ProductSearch:
    """Products this hospital has ever stocked, bought, sold or moved. The catalog is shared, so
    the rest are not offered; one that ran out or was made inactive stays findable."""
    if len(q.strip()) < 2:
        return ProductSearch(items=[], more=False)
    pattern = like(q)
    with transaction() as cur:
        cur.execute(
            """
            SELECT i.item_id, i.item_name, i.is_active
              FROM pharmacy_items i
             WHERE (i.item_name LIKE %s ESCAPE '\\\\' OR i.generic_name LIKE %s ESCAPE '\\\\'
                    OR i.product_code LIKE %s ESCAPE '\\\\')
               AND (EXISTS (SELECT 1 FROM inventory_stock_balances b
                              JOIN stock_locations l ON l.location_id = b.location_id
                             WHERE b.source_module = 'PHARMACY' AND b.item_id = i.item_id AND l.hospital_id = %s)
                    OR EXISTS (SELECT 1 FROM purchase_document_items pdi
                                 JOIN purchase_documents pd ON pd.purchase_document_id = pdi.purchase_document_id
                                WHERE pd.source_module = 'PHARMACY' AND pd.hospital_id = %s
                                  AND pdi.source_item_type = 'PHARMACY_ITEM' AND pdi.source_item_id = i.item_id)
                    OR EXISTS (SELECT 1 FROM sales_item_pharmacy_details d
                                 JOIN sales_document_items si ON si.sales_item_id = d.sales_item_id
                                 JOIN sales_documents sd ON sd.sales_document_id = si.sales_document_id
                                WHERE sd.source_module = 'PHARMACY' AND sd.hospital_id = %s
                                  AND d.pharmacy_item_id = i.item_id)
                    OR EXISTS (SELECT 1 FROM inventory_stock_movements m
                                 JOIN stock_locations ml ON ml.location_id = m.location_id
                                WHERE m.item_id = i.item_id AND m.stock_document_id IS NOT NULL
                                  AND ml.hospital_id = %s))
             ORDER BY i.item_name, i.item_id
             LIMIT %s
            """,
            (pattern, pattern, pattern, *[user.hospital_id] * 4, SEARCH_MAX + 1),
        )
        rows = cur.fetchall()
    return ProductSearch(items=rows[:SEARCH_MAX], more=len(rows) > SEARCH_MAX)


@router.get("/{item_id}")
def stock_query(item_id: int, user: User = Depends(current_user)) -> StockQuery:
    hospital = user.hospital_id
    with transaction() as cur:
        cur.execute(
            "SELECT item_id, item_name, generic_name, unit_of_measure FROM pharmacy_items WHERE item_id = %s",
            (item_id,),
        )
        item = cur.fetchone()
        if not item:
            raise HTTPException(404, "Product not found.")

        cur.execute(
            """
            SELECT COALESCE(SUM(b.quantity_on_hand), 0) AS on_hand, COALESCE(SUM(b.damaged_quantity), 0) AS damaged,
                   COALESCE(SUM(b.in_transit_quantity), 0) AS in_transit,
                   CAST(COALESCE(SUM(b.quantity_on_hand * b.unit_mrp_cents), 0) AS SIGNED) AS value_cents
              FROM inventory_stock_balances b
              JOIN stock_locations l ON l.location_id = b.location_id
             WHERE b.source_module = 'PHARMACY' AND b.is_active = 1 AND b.item_id = %s AND l.hospital_id = %s
            """,
            (item_id, hospital),
        )
        summary = cur.fetchone()

        cur.execute(
            """
            SELECT pd.document_date, pd.purchase_number AS grn_number, pd.supplier_invoice_number AS invoice_number,
                   COALESCE(sp.supplier_name, CONCAT('Supplier ', pdi.supplier_id)) AS supplier_name,
                   d.batch_number, d.expiry_date, d.packing, pdi.received_quantity, pdi.free_quantity,
                   pdi.unit_cost_cents, pdi.unit_mrp_cents, pdi.discount_amount_cents,
                   d.override_discount_percent, pdi.tax_amount_cents, pdi.net_amount_cents
              FROM purchase_document_items pdi
              JOIN purchase_documents pd ON pd.purchase_document_id = pdi.purchase_document_id
              LEFT JOIN purchase_item_pharmacy_details d ON d.purchase_item_id = pdi.purchase_item_id
              LEFT JOIN suppliers sp ON sp.supplier_id = pdi.supplier_id
             WHERE pd.source_module = 'PHARMACY' AND pd.hospital_id = %s
               AND pd.purchase_type IN ('GOODS_RECEIPT', 'SUPPLIER_INVOICE') AND pd.status <> 'CANCELLED'
               AND pdi.source_item_type = 'PHARMACY_ITEM' AND pdi.source_item_id = %s
             ORDER BY pd.document_date DESC, pdi.purchase_item_id DESC
             LIMIT 10
            """,
            (hospital, item_id),
        )
        purchases = cur.fetchall()

        cur.execute(
            """
            SELECT sd.document_date, sd.sales_number, sd.patient_name_snapshot AS patient_name,
                   sd.referral_doctor_snapshot AS referral_doctor, d.batch_number, d.expiry_date,
                   si.quantity, si.net_amount_cents,
                   COALESCE((SELECT GROUP_CONCAT(DISTINCT t.payment_mode ORDER BY t.payment_mode SEPARATOR ' + ')
                               FROM sales_payment_tenders t
                              WHERE t.sales_document_id = sd.sales_document_id AND t.line_status <> 'VOID'),
                            sd.primary_payment_mode) AS payment_modes,
                   COALESCE((SELECT SUM(r.quantity)
                               FROM sales_document_items r
                               JOIN sales_documents rd ON rd.sales_document_id = r.sales_document_id
                              WHERE rd.sales_type = 'SALE_RETURN' AND rd.status <> 'CANCELLED'
                                AND r.original_sales_item_id = si.sales_item_id), 0) AS returned_quantity
              FROM sales_document_items si
              JOIN sales_item_pharmacy_details d ON d.sales_item_id = si.sales_item_id
              JOIN sales_documents sd ON sd.sales_document_id = si.sales_document_id
             WHERE sd.source_module = 'PHARMACY' AND sd.hospital_id = %s
               AND sd.sales_type IN ('SALE', 'QUICK_SALE') AND sd.status NOT IN ('DRAFT', 'CANCELLED')
               AND d.pharmacy_item_id = %s
             ORDER BY sd.sales_document_id DESC, si.sales_item_id DESC
             LIMIT 30
            """,
            (hospital, item_id),
        )
        sales = cur.fetchall()

        cur.execute(
            """
            SELECT l.location_name, bt.batch_number, bt.expiry_date, sb.rack_code, sb.bin_code,
                   b.quantity_on_hand, b.damaged_quantity
              FROM inventory_stock_balances b
              JOIN stock_locations l ON l.location_id = b.location_id
              LEFT JOIN inventory_batches bt ON bt.batch_id = b.batch_id
              LEFT JOIN stock_storage_bins sb ON sb.storage_bin_id = b.storage_bin_id
             WHERE b.source_module = 'PHARMACY' AND b.is_active = 1 AND b.item_id = %s AND l.hospital_id = %s
               AND (b.quantity_on_hand > 0 OR b.damaged_quantity > 0)
             ORDER BY l.location_name, bt.expiry_date
            """,
            (item_id, hospital),
        )
        shelves = cur.fetchall()

        cur.execute(
            """
            SELECT m.created_at, m.movement_type, ib.batch_number, l.location_name, m.quantity_change,
                   COALESCE(rs.sales_number, rp.purchase_number, rd.stock_number) AS reference_number
              FROM inventory_stock_movements m
              JOIN stock_locations l ON l.location_id = m.location_id
              LEFT JOIN inventory_batches ib ON ib.batch_id = m.batch_id
              LEFT JOIN sales_documents rs ON rs.sales_document_id = m.reference_id
                   AND m.reference_type IN ('PHARMACY_SALE', 'PHARMACY_SALE_RETURN')
              LEFT JOIN purchase_documents rp ON rp.purchase_document_id = m.reference_id
                   AND m.reference_type IN ('PHARMACY_GRN', 'PHARMACY_PURCHASE_RETURN')
              LEFT JOIN stock_documents rd ON rd.stock_document_id = m.stock_document_id
             WHERE m.item_id = %s AND m.stock_document_id IS NOT NULL AND l.hospital_id = %s
             ORDER BY m.movement_id DESC
             LIMIT 50
            """,
            (item_id, hospital),
        )
        movements = cur.fetchall()

        cur.execute(
            """
            SELECT d.document_date, d.stock_number, d.stock_type, d.status,
                   fl.location_name AS from_location_name, il.location_name AS issue_location_name,
                   i.issued_quantity, i.return_quantity
              FROM stock_document_items i
              JOIN stock_documents d ON d.stock_document_id = i.stock_document_id
              LEFT JOIN stock_locations fl ON fl.location_id = d.from_location_id
              LEFT JOIN stock_locations il ON il.location_id = d.internal_issue_location_id
             WHERE d.source_module = 'PHARMACY' AND d.hospital_id = %s
               AND d.stock_type IN ('INTERNAL_ISSUE', 'INTERNAL_ISSUE_RETURN') AND d.status <> 'CANCELLED'
               AND i.item_id = %s
             ORDER BY d.stock_document_id DESC
             LIMIT 30
            """,
            (hospital, item_id),
        )
        issues = cur.fetchall()

    return StockQuery(**item, summary=summary, purchases=purchases, sales=sales, shelves=shelves,
                      movements=movements, issues=issues)
