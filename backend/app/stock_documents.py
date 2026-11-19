"""Stock documents: the registers of stock issues, transfers, requests and internal issues are the
same list over stock_documents, each showing its own type. Also the read-only view of one document."""
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

StockType = Literal[
    "STOCK_ISSUE", "STOCK_TRANSFER", "STOCK_RECEIPT", "STOCK_INDENT", "INTERNAL_ISSUE", "INTERNAL_ISSUE_RETURN",
    "WRITE_OFF", "STOCK_ADJUSTMENT", "STOCK_RELOCATION", "PHYSICAL_COUNT",
]
# What a stock issue was made for; the Stock Issues register can show one kind.
IssueKind = Literal["", "PHARMACY_STOCK_ISSUE", "PHARMACY_SALE", "PHARMACY_PURCHASE_RETURN", "PHARMACY_DELIVERY"]
EXPORT_MAX = 10000

# Who made a document. Doctors and admins share id numbers, so the id alone can name the wrong person:
# the kind of login is read from the audit entry written when the document was made. With no kind
# kept, a transfer or a stock issue shows only "User <id>" (as DocAssist does), never a guess.
_PERSON = "NULLIF(TRIM(CONCAT({0}.First_Name, ' ', COALESCE({0}.Last_Name, ''))), '')"
_CREATOR = (
    "CASE who.kind"
    f" WHEN 'admin' THEN COALESCE({_PERSON.format('adm')}, CONCAT('User ', d.created_by))"
    f" WHEN 'doctor' THEN COALESCE({_PERSON.format('doc')}, CONCAT('User ', d.created_by))"
    " ELSE CASE WHEN d.stock_type = 'STOCK_TRANSFER' OR d.source_entity_type = 'PHARMACY_STOCK_ISSUE'"
    "   THEN CONCAT('User ', d.created_by)"
    f"   ELSE COALESCE({_PERSON.format('doc')}, {_PERSON.format('adm')}, CONCAT('User ', d.created_by)) END"
    " END"
)
# The names a document row is shown with. Joined to the rows of one page only, never to the whole register.
_NAMES = (
    " LEFT JOIN stock_locations fl ON fl.location_id = d.from_location_id"
    " LEFT JOIN stock_locations tl ON tl.location_id = d.to_location_id"
    " LEFT JOIN stock_locations il ON il.location_id = d.internal_issue_location_id"
    " LEFT JOIN his_reference_values dept ON dept.reference_value_id = d.department_id AND dept.hospital_id = d.hospital_id"
    " LEFT JOIN Doctor ref ON ref.Doctor_ID = d.referral_doctor_id"
    " LEFT JOIN Doctor doc ON doc.Doctor_ID = d.created_by"
    " LEFT JOIN Admin adm ON adm.Admin_ID = d.created_by"
    " LEFT JOIN LATERAL (SELECT JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.actor_type')) AS kind"
    "   FROM pharmacy_audit_events a WHERE a.hospital_id = d.hospital_id AND a.entity_type = 'STOCK_DOCUMENT'"
    "   AND a.entity_id = d.stock_document_id AND JSON_EXTRACT(a.metadata_json, '$.actor_type') IS NOT NULL"
    "   ORDER BY a.audit_event_id LIMIT 1) who ON TRUE"
)
_COLUMNS = (
    "d.stock_document_id, d.stock_number, d.stock_type, d.status, d.source_entity_type, d.document_date, d.created_at,"
    " d.issued_at, d.received_at, d.product_count, d.requested_quantity_total, d.quantity_total,"
    " d.issued_quantity_total, d.received_quantity_total, d.net_amount_cents, d.notes, d.reference_number,"
    # what came back from an internal issue is kept on its rows only
    " (SELECT COALESCE(SUM(ri.return_quantity), 0) FROM stock_document_items ri"
    "   WHERE ri.stock_document_id = d.stock_document_id) AS returned_quantity_total,"
    " d.from_location_id, d.to_location_id, fl.location_name AS from_location_name, tl.location_name AS to_location_name,"
    " il.location_name AS internal_issue_location_name, dept.display_name AS department_name,"
    " NULLIF(TRIM(CONCAT_WS(' ', ref.First_Name, ref.Last_Name)), '') AS referral_doctor_name,"
    f" {_CREATOR} AS creator_name"
)


class StockDocumentRow(BaseModel):
    stock_document_id: int
    stock_number: str | None
    stock_type: str
    status: str
    source_entity_type: str | None
    document_date: date | None
    created_at: datetime | None
    issued_at: datetime | None
    received_at: datetime | None
    product_count: int | None
    requested_quantity_total: Decimal | None
    quantity_total: Decimal | None
    issued_quantity_total: Decimal | None
    received_quantity_total: Decimal | None
    returned_quantity_total: Decimal | None = None
    net_amount_cents: int | None
    notes: str | None
    reference_number: str | None
    from_location_id: int | None
    to_location_id: int | None
    from_location_name: str | None
    to_location_name: str | None
    internal_issue_location_name: str | None
    department_name: str | None
    referral_doctor_name: str | None
    creator_name: str | None


class StockDocumentPage(BaseModel):
    rows: list[StockDocumentRow]
    total: int
    product_count_total: int
    quantity_total: Decimal
    locations: list[Choice]
    statuses: list[str]


class StockDocumentFilters(BaseModel):
    from_date: date | None = None
    to_date: date | None = None
    status: Annotated[str, Field(max_length=40, pattern="^[A-Za-z_]*$")] = ""
    q: Annotated[str, Field(max_length=60)] = ""
    from_location_id: int | None = None
    to_location_id: int | None = None
    location_id: int | None = None  # anywhere on the document: from, to or the issue location
    received_only: bool = False  # the Stock Receipts register: transfers that have arrived
    kind: IssueKind = ""

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.from_date and self.to_date and self.to_date < self.from_date:
            raise ValueError("From date is after To date.")
        return self


def _words(code: str | None) -> str:
    return (code or "").replace("_", " ").capitalize()


def _csv(rows: list[dict]) -> Response:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Number", "Type", "Status", "Date", "From", "To", "Products", "Requested qty", "Qty",
                     "Issued qty", "Received qty", "Net amount", "Created by", "Notes"])
    for r in rows:
        writer.writerow([
            r["stock_number"] or "", _words(r["stock_type"]), _words(r["status"]), r["document_date"] or "",
            r["from_location_name"] or "", r["to_location_name"] or r["internal_issue_location_name"] or "",
            r["product_count"] or 0, r["requested_quantity_total"] or 0, r["quantity_total"] or 0,
            r["issued_quantity_total"] or 0, r["received_quantity_total"] or 0,
            f"{Decimal(r['net_amount_cents'] or 0) / 100:.2f}", r["creator_name"] or "", r["notes"] or "",
        ])
    return Response("﻿" + out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="stock_register.csv"'})


@router.get("/documents", response_model=StockDocumentPage)
def documents(
    stock_type: StockType,
    filters: Annotated[StockDocumentFilters, Query()],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    output: Literal["page", "all", "csv"] = "page",
    user: User = Depends(current_user),
):
    scope = "d.source_module = 'PHARMACY' AND d.hospital_id = %s AND d.stock_type = %s"
    where, params = [scope], [user.hospital_id, stock_type]
    if filters.from_date:
        where.append("d.document_date >= %s")
        params.append(filters.from_date)
    if filters.to_date:
        where.append("d.document_date <= %s")
        params.append(filters.to_date)
    if filters.status:
        where.append("d.status = %s")
        params.append(filters.status.upper())
    if filters.received_only:
        where.append("d.status = 'RECEIVED'")
    if filters.kind:
        where.append("d.source_entity_type = %s")
        params.append(filters.kind)
    if filters.q.strip():
        where.append("d.stock_number LIKE %s ESCAPE '\\\\'")
        params.append(like(filters.q))
    if filters.from_location_id:
        where.append("d.from_location_id = %s")
        params.append(filters.from_location_id)
    if filters.to_location_id:
        where.append("d.to_location_id = %s")
        params.append(filters.to_location_id)
    if filters.location_id:
        where.append("%s IN (d.location_id, d.from_location_id, d.to_location_id, d.internal_issue_location_id)")
        params.append(filters.location_id)
    if output != "page":
        limit, offset = EXPORT_MAX, 0

    with transaction() as cur:
        cur.execute(
            f"SELECT {_COLUMNS}, d.total, d.product_count_total, d.all_quantity_total"
            " FROM (SELECT d.*, COUNT(*) OVER () AS total,"
            "   COALESCE(SUM(d.product_count) OVER (), 0) AS product_count_total,"
            "   COALESCE(SUM(d.quantity_total) OVER (), 0) AS all_quantity_total"
            f"   FROM stock_documents d WHERE {' AND '.join(where)}"
            "   ORDER BY d.stock_document_id DESC LIMIT %s OFFSET %s) d"
            f"{_NAMES} ORDER BY d.stock_document_id DESC",
            (*params, limit, offset),
        )
        rows = cur.fetchall()
        if output == "csv":
            return _csv(rows)
        cur.execute(f"SELECT DISTINCT d.status FROM stock_documents d WHERE {scope}", (user.hospital_id, stock_type))
        statuses = sorted(row["status"] for row in cur.fetchall())
        cur.execute(
            "SELECT CAST(location_id AS CHAR) AS value, location_name AS label FROM stock_locations"
            " WHERE hospital_id = %s AND is_active = 1 ORDER BY location_name",
            (user.hospital_id,),
        )
        locations = cur.fetchall()

    first = rows[0] if rows else {"total": 0, "product_count_total": 0, "all_quantity_total": 0}
    return StockDocumentPage(
        rows=rows, total=first["total"], product_count_total=first["product_count_total"],
        quantity_total=first["all_quantity_total"], locations=locations, statuses=statuses,
    )


class StockLine(BaseModel):
    stock_item_id: int
    description: str | None
    batch_number: str | None
    expiry_date: date | None
    unit_code: str | None
    requested_quantity: Decimal | None
    transfer_quantity: Decimal | None
    issued_quantity: Decimal | None
    received_quantity: Decimal | None
    return_quantity: Decimal | None
    available_quantity: Decimal | None
    unit_cost_cents: int | None
    unit_mrp_cents: int | None
    net_amount_cents: int | None
    line_status: str | None
    reason: str | None
    rack_code: str | None
    bin_code: str | None


class StockDocument(StockDocumentRow):
    lines: list[StockLine]


@router.get("/documents/{stock_document_id}")
def document(stock_document_id: int, user: User = Depends(current_user)) -> StockDocument:
    with transaction() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM stock_documents d{_NAMES}"
            " WHERE d.stock_document_id = %s AND d.source_module = 'PHARMACY' AND d.hospital_id = %s",
            (stock_document_id, user.hospital_id),
        )
        found = cur.fetchone()
        if not found:
            raise HTTPException(404, "Stock document not found.")
        cur.execute(
            "SELECT stock_item_id, description, batch_number, expiry_date, unit_code, requested_quantity,"
            " transfer_quantity, issued_quantity, received_quantity, return_quantity, available_quantity,"
            " unit_cost_cents, unit_mrp_cents, net_amount_cents, line_status, reason,"
            " from_rack_code AS rack_code, from_bin_code AS bin_code"
            " FROM stock_document_items WHERE stock_document_id = %s ORDER BY line_number",
            (stock_document_id,),
        )
        lines = cur.fetchall()
    return StockDocument(**found, lines=lines)
