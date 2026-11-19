"""Sales History: the bills of the counter, one tab at a time (posted sales, sale returns, pending entries,
medicine return requests), with the totals the Sales Register reports for the same days.
Ported from DocAssist's sales history; saving, cancelling and approving stay in DocAssist."""
import csv
import io
from datetime import date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from .auth import User, current_user
from .common import Choice
from .db import transaction
from .sql import like

router = APIRouter(prefix="/api/sales", tags=["sales"])

Tab = Literal["sales", "returns", "pending", "return_requests"]
# a tab is the bill types it lists, the statuses it keeps to, and the statuses it leaves out
TABS: dict[str, tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]] = {
    "sales": (("SALE", "QUICK_SALE"), (), ("DRAFT", "PENDING")),
    "returns": (("SALE_RETURN",), (), ()),
    "pending": (("SALE", "QUICK_SALE", "PENDING_SALE"), ("DRAFT", "PENDING"), ()),
    "return_requests": (("MEDICINE_RETURN_REQUEST",), (), ()),
}
STATUSES = ("DRAFT", "PENDING", "CONFIRMED", "CONVERTED", "CANCELLED", "RETURN_REQUESTED", "RETURNED", "PARTIAL", "PAID", "WRITTEN_OFF")
MONEY = ("gross", "discount", "tax", "net", "rounded", "paid", "refunded", "balance")
# the stored column behind each money total
_COLUMN = {name: f"{name}_amount_cents" for name in MONEY} | {"refunded": "return_amount_cents"}
EXPORT_MAX = 5000
Flag = Literal["all", "only", "exclude"]


class HistoryFilters(BaseModel):
    tab: Tab = "sales"
    date_preset: Literal["today", "yesterday", "last_7_days", "last_30_days", "this_month", "all", "custom"] = "last_30_days"
    date_from: date | None = None
    date_to: date | None = None
    location_id: Annotated[int | None, Field(ge=1)] = None
    status: Annotated[str, Field(max_length=200, pattern="^[A-Z_,]*$")] = ""
    visit_type: Literal["", "OP", "IP", "RETAIL", "WALK_IN", "OTHER"] = ""
    quick_sale: Flag = "all"
    landed_cost: Flag = "all"
    discounted: Flag = "all"
    cancelled: Literal["exclude", "all", "only"] = "exclude"
    q: Annotated[str, Field(max_length=60)] = ""

    @model_validator(mode="after")
    def check(self):
        if any(code not in STATUSES for code in self.statuses):
            raise ValueError("Unknown status.")
        start, end = self.days
        if start and end and start > end:
            raise ValueError("From date is after To date.")
        return self

    @property
    def statuses(self) -> list[str]:
        return [code for code in self.status.split(",") if code]

    @property
    def days(self) -> tuple[date | None, date | None]:
        """Typed dates win; otherwise the preset is counted back from today, as DocAssist does."""
        if self.date_from or self.date_to:
            return self.date_from, self.date_to
        today = date.today()
        return {
            "today": (today, today),
            "yesterday": (today - timedelta(days=1),) * 2,
            "last_7_days": (today - timedelta(days=6), today),
            "last_30_days": (today - timedelta(days=29), today),
            "this_month": (today.replace(day=1), today),
        }.get(self.date_preset, (None, None))

    @property
    def comparable(self) -> bool:
        """The Sales Register knows only days and location and leaves cancelled bills out; with any other
        filter set the two would not be about the same bills, so no comparison is offered."""
        return not (self.statuses or self.visit_type or self.q.strip() or self.cancelled != "exclude"
                    or "all" != self.quick_sale or "all" != self.landed_cost or "all" != self.discounted)


class SaleRow(BaseModel):
    sales_document_id: int
    sales_number: str | None
    sales_type: str
    status: str
    payment_status: str | None
    document_date: date | None
    billed_at: datetime | None
    patient_name: str | None
    mrn: str | None
    gender: str | None
    contact_number: str | None
    visit_number: str | None
    visit_type: str | None
    doctor_name: str | None
    is_discounted: bool
    is_landed_cost_sale: bool
    is_free_bill: bool
    has_prescription: bool
    location_name: str | None
    billed_by_name: str | None
    product_count: int
    quantity_total: str
    returned_quantity_total: str
    original_sales_number: str | None
    notes: str | None
    gross: int
    discount: int
    tax: int
    net: int
    rounded: int
    paid: int
    refunded: int
    balance: int


class Money(BaseModel):
    count: int
    gross: int
    discount: int
    tax: int
    net: int
    rounded: int
    paid: int
    refunded: int
    balance: int


class RegisterMoney(Money):
    sales_count: int
    returns_count: int


class SalesPermissions(BaseModel):
    create: bool
    confirm: bool
    pay: bool
    print: bool
    credit: bool
    writeoff: bool
    cancel: bool


class SalesHistory(BaseModel):
    rows: list[SaleRow]
    total: int
    totals: Money
    tab_counts: dict[str, int]
    register_totals: RegisterMoney | None  # only when the filters can be read against the Sales Register
    date_from: date | None
    date_to: date | None
    locations: list[Choice]
    permissions: SalesPermissions


def _shared(f: HistoryFilters) -> tuple[list[str], list]:
    """The filters every tab shares."""
    where, params = [], []
    start, end = f.days
    if start:
        where.append("d.document_date >= %s")
        params.append(start)
    if end:
        where.append("d.document_date <= %s")
        params.append(end)
    if f.location_id:
        where.append("d.location_id = %s")
        params.append(f.location_id)
    if f.statuses:
        where.append(f"d.status IN ({', '.join(['%s'] * len(f.statuses))})")
        params += f.statuses
    if f.visit_type:
        where.append("d.visit_type = %s")
        params.append(f.visit_type)
    for flag, test in ((f.quick_sale, "d.sales_type = 'QUICK_SALE'"), (f.landed_cost, "d.is_landed_cost_sale = 1"), (f.discounted, "d.is_discounted = 1")):
        if flag != "all":
            where.append(test if flag == "only" else f"NOT ({test})")
    if f.cancelled != "all":
        where.append("d.status = 'CANCELLED'" if f.cancelled == "only" else "d.status <> 'CANCELLED'")
    if f.q.strip():
        # a sale return is also found by the number of the bill it reverses
        where.append("(" + " OR ".join(f"{c} LIKE %s ESCAPE '\\\\'" for c in (
            "d.sales_number", "d.patient_name_snapshot", "d.mrn", "d.visit_number", "d.contact_number_snapshot", "o.sales_number")) + ")")
        params += [like(f.q)] * 6
    return where, params


def _in_tab(tab: str) -> tuple[str, list]:
    types, only, never = TABS[tab]
    sql = f"d.sales_type IN ({', '.join(['%s'] * len(types))})"
    params = list(types)
    if only:
        sql += f" AND d.status IN ({', '.join(['%s'] * len(only))})"
        params += only
    if never:
        sql += f" AND d.status NOT IN ({', '.join(['%s'] * len(never))})"
        params += never
    return sql, params


_FROM = (" FROM sales_documents d LEFT JOIN sales_documents o ON o.sales_document_id = d.original_sales_document_id"
         " WHERE d.source_module = 'PHARMACY' AND d.hospital_id = %s")
_SUMS = ", ".join(f"COALESCE(SUM(d.{_COLUMN[m]}) OVER (), 0) AS all_{m}" for m in MONEY)
_ROW = """
SELECT p.*, l.location_name,
       COALESCE(NULLIF(CONCAT_WS(' ', doc.First_Name, doc.Last_Name), ''),
                NULLIF(CONCAT_WS(' ', adm.First_Name, adm.Last_Name), ''), CONCAT('User ', p.billed_by)) AS billed_by_name,
       (SELECT COUNT(*) FROM sales_document_items i WHERE i.sales_document_id = p.sales_document_id) AS product_count,
       (SELECT COALESCE(SUM(i.quantity), 0) FROM sales_document_items i WHERE i.sales_document_id = p.sales_document_id) AS quantity_total,
       -- how much of the bill has already come back
       (SELECT COALESCE(SUM(r.quantity), 0) FROM sales_document_items r JOIN sales_documents rd ON rd.sales_document_id = r.sales_document_id
         WHERE rd.sales_type = 'SALE_RETURN' AND rd.status <> 'CANCELLED' AND rd.original_sales_document_id = p.sales_document_id) AS returned_quantity_total
  FROM ({page}) p
  LEFT JOIN stock_locations l ON l.location_id = p.location_id
  LEFT JOIN Doctor doc ON doc.Doctor_ID = p.billed_by
  LEFT JOIN Admin adm ON adm.Admin_ID = p.billed_by
 ORDER BY p.document_date DESC, p.sales_document_id DESC
"""


def _row(r: dict) -> SaleRow:
    return SaleRow(
        sales_document_id=r["sales_document_id"], sales_number=r["sales_number"], sales_type=r["sales_type"], status=r["status"],
        payment_status=r["payment_status"], document_date=r["document_date"], billed_at=r["billed_at"],
        patient_name=r["patient_name_snapshot"], mrn=r["mrn"], gender=r["gender_snapshot"], contact_number=r["contact_number_snapshot"],
        visit_number=r["visit_number"], visit_type=r["visit_type"], doctor_name=r["doctor_name_snapshot"],
        is_discounted=bool(r["is_discounted"]), is_landed_cost_sale=bool(r["is_landed_cost_sale"]), is_free_bill=bool(r["is_free_bill"]),
        has_prescription=bool(r["prescription_reference_id"]), location_name=r["location_name"], billed_by_name=r["billed_by_name"],
        product_count=r["product_count"], quantity_total=str(r["quantity_total"]), returned_quantity_total=str(r["returned_quantity_total"]),
        original_sales_number=r["original_sales_number"], notes=r["notes"], **{m: int(r[_COLUMN[m]] or 0) for m in MONEY},
    )


def sales_permissions(cur, user: User) -> SalesPermissions:
    """What this login may do on the sales screens, as DocAssist decides it: an admin, or a doctor with the
    Pharmacy module, may do everything; otherwise the PHARMACY_SALES role grants decide, and a hospital that
    never granted any keeps everything allowed."""
    allowed = dict.fromkeys(SalesPermissions.model_fields, True)
    if user.is_admin:
        return SalesPermissions(**allowed)
    cur.execute(
        "SELECT 1 FROM Doctor d JOIN Doctor_Hospital dh ON dh.doctor_id = d.Doctor_ID JOIN hospitals h ON h.hospital_id = dh.hospital_id"
        " JOIN Doctor_Module_Access a ON a.doctor_id = d.Doctor_ID JOIN Modules m ON m.module_id = a.module_id"
        " WHERE d.Doctor_ID = %s AND d.is_active = 1 AND h.hospital_id = %s AND h.is_active = 1 AND dh.association_started <= CURDATE()"
        " AND (dh.association_ended IS NULL OR dh.association_ended > CURDATE()) AND a.enabled = 1 AND m.is_active = 1"
        " AND m.module_name = 'Pharmacy' LIMIT 1",
        (user.actor_id, user.hospital_id),
    )
    if cur.fetchone():
        return SalesPermissions(**allowed)
    cur.execute(
        "SELECT p.action_code, p.is_allowed, p.conditions_json FROM his_role_assignments a"
        " JOIN his_role_resource_permissions p ON p.hospital_id = a.hospital_id AND p.role_code = a.role_code"
        " JOIN his_menu_resources r ON r.resource_id = p.resource_id AND r.hospital_id = a.hospital_id"
        " WHERE a.hospital_id = %s AND a.principal_type = 'DOCTOR' AND a.principal_id = %s AND a.is_active = 1"
        " AND (a.scope_module IS NULL OR a.scope_module = '' OR a.scope_module = 'PHARMACY' OR a.scope_module IN"
        "   (SELECT v.reference_code FROM his_reference_values v WHERE v.hospital_id = a.hospital_id"
        "    AND v.reference_type = 'PHARMACY_APPLICATION' AND v.is_active = 1))"
        " AND (a.starts_at IS NULL OR a.starts_at <= NOW()) AND (a.ends_at IS NULL OR a.ends_at > NOW())"
        " AND r.module_code = 'PHARMACY' AND r.is_active = 1 AND r.resource_code = 'PHARMACY_SALES'",
        (user.hospital_id, user.actor_id),
    )
    grants = cur.fetchall()
    actions = {"create": "CREATE", "confirm": "CONFIRM", "pay": "UPDATE", "print": "PRINT", "credit": "APPROVE", "writeoff": "APPROVE", "cancel": "CANCEL"}
    for name, action in actions.items():
        matches = [g for g in grants if g["action_code"] == action]
        if matches:
            allowed[name] = all(g["is_allowed"] and g["conditions_json"] in (None, "", "{}", "[]") for g in matches)
    return SalesPermissions(**allowed)


@router.get("/history", response_model=SalesHistory)
def history(
    user: Annotated[User, Depends(current_user)],
    filters: Annotated[HistoryFilters, Query()],
    limit: Annotated[int, Query()] = 25,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    output: Literal["page", "csv"] = "page",
):
    if limit not in (10, 25, 50, 100):
        raise HTTPException(422, "Rows per page must be 10, 25, 50 or 100.")
    shared, shared_params = _shared(filters)
    tab_sql, tab_params = _in_tab(filters.tab)
    where = " AND ".join([tab_sql, *shared]) if shared else tab_sql
    params = [user.hospital_id, *tab_params, *shared_params]
    if output == "csv":
        limit, offset = EXPORT_MAX, 0
    page = (f"SELECT d.*, o.sales_number AS original_sales_number, COUNT(*) OVER () AS total, {_SUMS}{_FROM} AND {where}"
            " ORDER BY d.document_date DESC, d.sales_document_id DESC LIMIT %s OFFSET %s")
    with transaction() as cur:
        cur.execute(_ROW.format(page=page), (*params, limit, offset))
        found = cur.fetchall()
        if output == "csv":
            return _csv([_row(r) for r in found])
        first = found[0] if found else None
        if not first and offset:  # a page past the end: count the tab again for its totals
            cur.execute(f"SELECT COUNT(*) AS total, {_SUMS.replace(' OVER ()', '')}{_FROM} AND {where}", params)
            first = cur.fetchone()
        # how many rows each tab holds under the same filters, in one trip
        counts = ", ".join(f"COALESCE(SUM({_in_tab(tab)[0]}), 0) AS {tab}" for tab in TABS)
        count_params = [p for tab in TABS for p in _in_tab(tab)[1]]
        cur.execute(f"SELECT {counts}{_FROM}" + (f" AND {' AND '.join(shared)}" if shared else ""), (*count_params, user.hospital_id, *shared_params))
        tab_counts = {tab: int(n) for tab, n in cur.fetchone().items()}
        register = _register(cur, user, filters) if filters.comparable else None
        cur.execute("SELECT location_id, location_name FROM stock_locations WHERE hospital_id = %s AND is_active = 1 ORDER BY location_name", (user.hospital_id,))
        locations = [Choice(value=str(r["location_id"]), label=r["location_name"]) for r in cur.fetchall()]
        permissions = sales_permissions(cur, user)
    start, end = filters.days
    return SalesHistory(
        rows=[_row(r) for r in found], total=int(first["total"]) if first else 0,
        totals=Money(count=int(first["total"]) if first else 0, **{m: int(first[f"all_{m}"]) if first else 0 for m in MONEY}),
        tab_counts=tab_counts, register_totals=register, date_from=start, date_to=end, locations=locations, permissions=permissions,
    )


def _register(cur, user: User, f: HistoryFilters) -> RegisterMoney:
    """What the Sales Register reports for the same days and location: posted bills and quick sales less
    sale returns, with the two counted apart."""
    where, params = ["d.source_module = 'PHARMACY'", "d.hospital_id = %s", "d.status NOT IN ('DRAFT', 'CANCELLED')",
                     "d.sales_type IN ('SALE', 'QUICK_SALE', 'SALE_RETURN')"], [user.hospital_id]
    start, end = f.days
    for test, value in (("d.document_date >= %s", start), ("d.document_date <= %s", end), ("d.location_id = %s", f.location_id)):
        if value:
            where.append(test)
            params.append(value)
    sums = ", ".join(f"COALESCE(SUM(CASE WHEN d.sales_type = 'SALE_RETURN' THEN -d.{c} ELSE d.{c} END), 0) AS {m}"
                     for m, c in _COLUMN.items())
    cur.execute("SELECT COALESCE(SUM(d.sales_type <> 'SALE_RETURN'), 0) AS sales_count, COALESCE(SUM(d.sales_type = 'SALE_RETURN'), 0) AS returns_count,"
                f" {sums} FROM sales_documents d WHERE {' AND '.join(where)}", params)
    r = cur.fetchone()
    sales, returns = int(r["sales_count"]), int(r["returns_count"])
    return RegisterMoney(count=sales + returns, sales_count=sales, returns_count=returns, **{m: int(r[m]) for m in MONEY})


def _csv(rows: list[SaleRow]) -> Response:
    out = io.StringIO()
    sheet = csv.writer(out)
    sheet.writerow(["Bill no.", "Date", "Patient", "MRN", "Visit", "Type", "Status", "Gross", "Discount", "Tax", "Net", "Rounded", "Paid", "Balance due", "Billed by"])
    rupees = lambda cents: f"{cents / 100:.2f}"  # noqa: E731
    for r in rows:
        sheet.writerow([r.sales_number, r.billed_at or r.document_date, r.patient_name, r.mrn, r.visit_number, r.sales_type, r.status,
                        rupees(r.gross), rupees(r.discount), rupees(r.tax), rupees(r.net), rupees(r.rounded), rupees(r.paid), rupees(r.balance), r.billed_by_name])
    return Response(out.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="sales-history.csv"'})


# ---- one bill -------------------------------------------------------------------------------------------------------

PAYMENT_MODES = {
    "CASH": "Cash", "CREDIT_CARD": "Credit card", "DEBIT_CARD": "Debit card", "UPI": "UPI", "INSURANCE": "Insurance",
    "BANK_TRANSFER": "Bank transfer", "CHEQUE": "Cheque", "EFT": "EFT", "RTGS": "RTGS", "NEFT": "NEFT", "IMPS": "IMPS",
    "CREDIT": "Credit", "OTHER": "Other",
}


class PaymentMode(BaseModel):
    code: str
    label: str
    configured: bool


class BillLine(BaseModel):
    sales_item_id: int
    line_number: int | None
    description: str | None
    packing: str | None
    prescribed: bool
    batch_number: str | None
    expiry_date: date | None
    hsn_code: str | None
    rack: str | None
    bin: str | None
    quantity: str
    returned_quantity: str
    unit_mrp_cents: int | None
    unit_price_cents: int | None
    discount_amount_cents: int | None
    tax_amount_cents: int | None
    net_amount_cents: int | None
    line_status: str | None


class Tender(BaseModel):
    line_number: int | None
    payment_mode: str
    amount_cents: int
    return_amount_cents: int
    transaction_reference: str | None
    authorized_by_name: str | None
    authorization_reason: str | None
    remarks: str | None


class Refund(BaseModel):
    account_number: str | None
    account_type: str
    payment_mode: str | None
    net_amount_cents: int


class ReturnInfo(BaseModel):
    reasons: list[str]
    received_by_name: str | None
    refund_handling: str | None
    refunds: list[Refund]
    balance_cut_cents: int  # what was not handed back came off what the bill owes
    waiting_for_approval: bool


class PrintDevices(BaseModel):
    """The printers set up for the bill's location, by name; None when there is none."""
    bill: str | None
    label: str | None


class Bill(BaseModel):
    sales_document_id: int
    sales_number: str | None
    sales_type: str
    status: str
    payment_status: str | None
    document_date: date | None
    billed_at: datetime | None
    created_at: datetime | None
    patient_name: str | None
    gender: str | None
    mrn: str | None
    visit_number: str | None
    visit_type: str | None
    visit_status: str | None
    billed_by_name: str | None
    location_name: str | None
    customer: list[Choice]  # the customer details kept with the bill, only those with a value
    gross: int
    discount: int
    tax: int
    net: int
    rounded: int
    paid: int
    balance: int
    change: int
    added_value: int
    primary_payment_mode: str | None
    lines: list[BillLine]
    tenders: list[Tender]
    return_info: ReturnInfo | None
    payment_modes: list[PaymentMode]
    print_devices: PrintDevices
    permissions: SalesPermissions


def _prescription_number(reference: int | None) -> str | None:
    """The reference keeps the financial year in front of the count (26000001 is PRX/26-27/000001).
    ponytail: worked out instead of read from the prescription store, which this app does not reach."""
    if not reference:
        return None
    year, count = divmod(int(reference), 1_000_000)
    return f"PRX/{year:02d}-{(year + 1) % 100:02d}/{count:06d}" if year and count else str(reference)


_LINES = """
SELECT i.sales_item_id, i.line_number, i.description, i.quantity, i.unit_price_cents, i.discount_amount_cents,
       i.tax_amount_cents, i.net_amount_cents, i.line_status, i.source_prescription_id IS NOT NULL AS prescribed,
       -- an estimate keeps the batch it quoted by its id only
       COALESCE(p.batch_number, quoted.batch_number) AS batch_number, COALESCE(p.expiry_date, quoted.expiry_date) AS expiry_date,
       p.hsn_code, p.unit_mrp_cents, p.rack, p.bin, p.packing,
       COALESCE((SELECT SUM(r.quantity) FROM sales_document_items r JOIN sales_documents rd ON rd.sales_document_id = r.sales_document_id
                  WHERE rd.sales_type = 'SALE_RETURN' AND rd.status <> 'CANCELLED' AND r.original_sales_item_id = i.sales_item_id), 0) AS returned_quantity
  FROM sales_document_items i
  LEFT JOIN sales_item_pharmacy_details p ON p.sales_item_id = i.sales_item_id
  LEFT JOIN inventory_batches quoted ON quoted.batch_id = p.batch_id
 WHERE i.sales_document_id = %s ORDER BY i.line_number
"""
_TENDERS = """
SELECT t.line_number, t.payment_mode, t.amount_cents, COALESCE(t.return_amount_cents, 0) AS return_amount_cents,
       t.transaction_reference, t.authorization_reason, t.remarks,
       CASE WHEN t.authorized_by IS NULL THEN NULL ELSE
            COALESCE(NULLIF(CONCAT_WS(' ', doc.First_Name, doc.Last_Name), ''), NULLIF(CONCAT_WS(' ', adm.First_Name, adm.Last_Name), ''),
                     CONCAT('User ', t.authorized_by)) END AS authorized_by_name
  FROM sales_payment_tenders t
  LEFT JOIN Doctor doc ON doc.Doctor_ID = t.authorized_by
  LEFT JOIN Admin adm ON adm.Admin_ID = t.authorized_by
 WHERE t.sales_document_id = %s ORDER BY t.line_number
"""


@router.get("/bills/{sales_document_id}")
def bill(sales_document_id: int, user: Annotated[User, Depends(current_user)]) -> Bill:
    with transaction() as cur:
        cur.execute(
            "SELECT d.*, l.location_name FROM sales_documents d LEFT JOIN stock_locations l ON l.location_id = d.location_id"
            " WHERE d.sales_document_id = %s AND d.source_module = 'PHARMACY' AND d.hospital_id = %s",
            (sales_document_id, user.hospital_id),
        )
        d = cur.fetchone()
        if not d:
            raise HTTPException(404, "Bill not found.")
        cur.execute(_LINES, (sales_document_id,))
        lines = [BillLine(**{**r, "prescribed": bool(r["prescribed"]), "quantity": str(r["quantity"]), "returned_quantity": str(r["returned_quantity"])})
                 for r in cur.fetchall()]
        cur.execute(_TENDERS, (sales_document_id,))
        tenders = [Tender(**r) for r in cur.fetchall()]
        info = _return_info(cur, d) if d["sales_type"] == "SALE_RETURN" else None
        cur.execute("SELECT reference_code FROM his_reference_values WHERE hospital_id = %s AND reference_type = 'PAYMENT_MODE' AND is_active = 1"
                    " ORDER BY sort_order, reference_value_id", (user.hospital_id,))
        configured = [c for c in dict.fromkeys(str(r["reference_code"] or "").upper() for r in cur.fetchall()) if c in PAYMENT_MODES]
        cur.execute(
            "SELECT UPPER(ld.device_role) AS role, COALESCE(dv.device_name, dv.device_code) AS name FROM his_location_devices ld"
            " JOIN his_devices dv ON dv.device_id = ld.device_id WHERE ld.hospital_id = %s AND ld.is_active = 1 AND dv.is_active = 1"
            " AND (%s IS NULL OR ld.location_id = %s) ORDER BY ld.is_default DESC, ld.location_device_id",
            (user.hospital_id, d["location_id"], d["location_id"]),
        )
        devices: dict[str, str] = {}
        for r in cur.fetchall():
            devices.setdefault(r["role"], r["name"])
        permissions = sales_permissions(cur, user)
    # configured modes first, then the rest of the modes the payment ledger can hold
    modes = [PaymentMode(code=c, label=PAYMENT_MODES[c], configured=c in configured) for c in configured + [c for c in PAYMENT_MODES if c not in configured]]
    customer = [Choice(label=label, value=str(value)) for label, value in (
        ("Phone", d.get("contact_number_snapshot")), ("Consultant", d.get("doctor_name_snapshot")), ("Referral doctor", d.get("referral_doctor_snapshot")),
        ("GST number", d.get("gst_number_snapshot")), ("State code", d.get("state_code_snapshot")), ("Address", d.get("address_snapshot")),
        ("Country", d.get("country_snapshot")), ("State", d.get("state_snapshot")), ("District", d.get("district_snapshot")),
        ("Village", d.get("village_snapshot")), ("Pincode", d.get("pincode_snapshot")), ("Packed by", d.get("packed_by_name_snapshot")),
        ("Prescription", _prescription_number(d.get("prescription_reference_id"))),
    ) if value]
    return Bill(
        sales_document_id=d["sales_document_id"], sales_number=d["sales_number"], sales_type=d["sales_type"], status=d["status"],
        payment_status=d["payment_status"], document_date=d["document_date"], billed_at=d["billed_at"], created_at=d["created_at"],
        patient_name=d["patient_name_snapshot"], gender=d["gender_snapshot"], mrn=d["mrn"], visit_number=d["visit_number"],
        visit_type=d["visit_type"], visit_status=d.get("visit_status_snapshot"),
        billed_by_name=d.get("billed_by_name_snapshot") or (f"User {d['billed_by']}" if d["billed_by"] else None),
        location_name=d["location_name"] or (f"Location {d['location_id']}" if d["location_id"] else None), customer=customer,
        gross=d["gross_amount_cents"] or 0, discount=d["discount_amount_cents"] or 0, tax=d["tax_amount_cents"] or 0, net=d["net_amount_cents"] or 0,
        rounded=d["rounded_amount_cents"] or d["net_amount_cents"] or 0, paid=d["paid_amount_cents"] or 0, balance=d["balance_amount_cents"] or 0,
        change=d["return_amount_cents"] or 0, added_value=d.get("added_value_cents") or 0, primary_payment_mode=d["primary_payment_mode"],
        lines=lines, tenders=tenders, return_info=info, payment_modes=modes,
        print_devices=PrintDevices(bill=devices.get("BILL_PRINT"), label=devices.get("OP_LABEL_PRINT")), permissions=permissions,
    )


def _return_info(cur, d: dict) -> ReturnInfo:
    """What the counter recorded on a sale return: why it came back, who took it in and where the money went."""
    cur.execute(
        "SELECT sd.stock_document_id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', dr.First_Name, dr.Last_Name)), ''),"
        " NULLIF(TRIM(CONCAT_WS(' ', adm.First_Name, adm.Last_Name)), ''), CONCAT('User ', sd.received_by)) AS received_by_name"
        " FROM stock_documents sd LEFT JOIN Doctor dr ON dr.Doctor_ID = sd.received_by LEFT JOIN Admin adm ON adm.Admin_ID = sd.received_by"
        " WHERE sd.source_entity_type = 'PHARMACY_SALE_RETURN' AND sd.source_entity_id = %s ORDER BY sd.stock_document_id LIMIT 1",
        (d["sales_document_id"],),
    )
    receipt = cur.fetchone()
    reasons: list[str] = []
    if receipt:
        cur.execute("SELECT reason FROM stock_document_items WHERE stock_document_id = %s ORDER BY line_number", (receipt["stock_document_id"],))
        reasons = list(dict.fromkeys(r["reason"] for r in cur.fetchall() if r["reason"]))
    cur.execute(
        "SELECT account_number, account_type, payment_mode, COALESCE(net_amount_cents, 0) AS net_amount_cents FROM account_documents"
        " WHERE source_entity_type IN ('SALES_RETURN', 'PHARMACY_SALE_RETURN') AND source_entity_id = %s"
        " AND account_type IN ('CUSTOMER_REFUND', 'CUSTOMER_ADVANCE') AND status <> 'CANCELLED' ORDER BY account_document_id",
        (d["sales_document_id"],),
    )
    refunds = [Refund(**r) for r in cur.fetchall()]
    waiting = d["status"] == "PENDING"
    return ReturnInfo(
        reasons=reasons, received_by_name=receipt["received_by_name"] if receipt else None, refund_handling=d.get("refund_handling"),
        refunds=refunds, waiting_for_approval=waiting,
        balance_cut_cents=0 if waiting else max((d["net_amount_cents"] or 0) - sum(r.net_amount_cents for r in refunds), 0),
    )


# ---- the counter's live list (Sales Register) and the estimate book (Estimates) ------------------------------------

# Estimates: every estimate of one state, however old; an open estimate is a draft or a confirmed quote
ESTIMATE_STATES = {"ESTIMATES_PENDING": ("DRAFT", "CONFIRMED"), "ESTIMATES_CONVERTED": ("CONVERTED",),
                   "ESTIMATES_CANCELLED": ("CANCELLED",), "ESTIMATES_ALL": ()}


class RegisterRow(BaseModel):
    sales_document_id: int
    sales_number: str | None
    sales_type: str
    status: str
    document_date: date | None
    patient_name: str | None
    patient_id: int | None
    mrn: str | None
    visit_number: str | None
    visit_type: str | None
    visit_status: str | None
    product_count: int
    quantity_total: str
    returned_quantity_total: str
    gross: int | None
    discount: int | None
    tax: int | None
    net: int | None
    rounded: int | None
    paid: int | None
    balance: int | None
    converted_sales_number: str | None  # an estimate that became a bill names it
    estimate_number: str | None  # and a bill made from an estimate names the estimate
    cancelled_at: datetime | None
    cancelled_by_name: str | None
    cancel_reason: str | None


class CounterSummary(BaseModel):
    today_sales_cents: int
    today_tax_cents: int
    outstanding_cents: int
    pending_sale_count: int
    return_request_count: int


class SalesRegister(BaseModel):
    summary: CounterSummary
    rows: list[RegisterRow]
    permissions: SalesPermissions


_REGISTER = """
SELECT d.sales_document_id, d.sales_number, d.sales_type, d.status, d.document_date, d.patient_name_snapshot, d.patient_id, d.mrn,
       d.visit_number, d.visit_type, d.visit_status_snapshot, d.gross_amount_cents, d.discount_amount_cents, d.tax_amount_cents,
       d.net_amount_cents, d.rounded_amount_cents, d.paid_amount_cents, d.balance_amount_cents, d.cancelled_at, d.cancelled_by,
       converted.sales_number AS converted_sales_number, origin.sales_number AS estimate_number,
       -- products, not lines: one product taken from two batches is one
       (SELECT COUNT(DISTINCT COALESCE(i.source_item_id, -i.sales_item_id)) FROM sales_document_items i WHERE i.sales_document_id = d.sales_document_id) AS product_count,
       (SELECT COALESCE(SUM(i.quantity), 0) FROM sales_document_items i WHERE i.sales_document_id = d.sales_document_id) AS quantity_total,
       (SELECT COALESCE(SUM(r.quantity), 0) FROM sales_document_items r JOIN sales_documents rd ON rd.sales_document_id = r.sales_document_id
         WHERE rd.sales_type = 'SALE_RETURN' AND rd.status <> 'CANCELLED' AND rd.original_sales_document_id = d.sales_document_id) AS returned_quantity_total,
       -- a cancelled estimate keeps the reason and the kind of login that cancelled it
       JSON_UNQUOTE(JSON_EXTRACT(cancel.metadata_json, '$.reason')) AS cancel_reason,
       CASE UPPER(JSON_UNQUOTE(JSON_EXTRACT(cancel.metadata_json, '$.actor_type')))
         WHEN 'ADMIN' THEN NULLIF(TRIM(CONCAT_WS(' ', adm.First_Name, adm.Last_Name)), '')
         WHEN 'DOCTOR' THEN NULLIF(TRIM(CONCAT_WS(' ', doc.First_Name, doc.Last_Name)), '') END AS cancelled_by_known
  FROM sales_documents d
  LEFT JOIN sales_documents converted ON converted.sales_document_id = d.converted_sales_document_id
  LEFT JOIN sales_documents origin ON origin.sales_document_id = d.original_sales_document_id AND origin.sales_type = 'ESTIMATE'
  -- the latest cancellation entry only, so a document is never listed twice
  LEFT JOIN LATERAL (SELECT a.metadata_json FROM pharmacy_audit_events a
                      WHERE d.sales_type = 'ESTIMATE' AND d.status = 'CANCELLED' AND a.hospital_id = d.hospital_id
                        AND a.entity_type = 'SALES_DOCUMENT' AND a.event_type = 'ESTIMATE_CANCELLED' AND a.entity_id = d.sales_document_id
                      ORDER BY a.audit_event_id DESC LIMIT 1) cancel ON TRUE
  LEFT JOIN Admin adm ON adm.Admin_ID = d.cancelled_by
  LEFT JOIN Doctor doc ON doc.Doctor_ID = d.cancelled_by
 WHERE d.source_module = 'PHARMACY' AND d.hospital_id = %s {where}
 ORDER BY d.document_date DESC, d.sales_document_id DESC
 LIMIT {limit}
"""


@router.get("/register")
def register(
    user: Annotated[User, Depends(current_user)],
    show: Literal["", "ESTIMATES_PENDING", "ESTIMATES_CONVERTED", "ESTIMATES_CANCELLED", "ESTIMATES_ALL"] = "",
) -> SalesRegister:
    """The ten newest sale documents, or with `show` every estimate of one state (up to 50)."""
    where, limit = "", 10
    if show:
        states = ESTIMATE_STATES[show]
        where = "AND d.sales_type = 'ESTIMATE'" + (f" AND d.status IN ({', '.join(repr(s) for s in states)})" if states else "")
        limit = 50
    with transaction() as cur:
        cur.execute(
            """SELECT
                 COALESCE(SUM(CASE WHEN document_date = CURDATE() AND sales_type NOT IN ('ESTIMATE','PENDING_SALE') THEN net_amount_cents END), 0) AS today_sales_cents,
                 COALESCE(SUM(CASE WHEN document_date = CURDATE() AND sales_type NOT IN ('ESTIMATE','PENDING_SALE') THEN tax_amount_cents END), 0) AS today_tax_cents,
                 COALESCE(SUM(CASE WHEN status IN ('CONFIRMED','PARTIAL','PENDING') AND sales_type NOT IN ('ESTIMATE','PENDING_SALE') THEN balance_amount_cents END), 0) AS outstanding_cents,
                 COALESCE(SUM(sales_type IN ('SALE_RETURN','MEDICINE_RETURN_REQUEST') AND status IN ('PENDING','RETURN_REQUESTED')), 0) AS return_request_count,
                 COALESCE(SUM(sales_type IN ('SALE','QUICK_SALE') AND status IN ('DRAFT','PENDING')), 0) AS pending_sale_count
               FROM sales_documents WHERE source_module = 'PHARMACY' AND hospital_id = %s""",
            (user.hospital_id,),
        )
        summary = CounterSummary(**{k: int(v) for k, v in cur.fetchone().items()})
        cur.execute(_REGISTER.format(where=where, limit=limit), (user.hospital_id,))
        found = cur.fetchall()
        permissions = sales_permissions(cur, user)
    money = lambda v: None if v is None else int(v)  # noqa: E731
    rows = [RegisterRow(
        sales_document_id=r["sales_document_id"], sales_number=r["sales_number"], sales_type=r["sales_type"], status=r["status"],
        document_date=r["document_date"], patient_name=r["patient_name_snapshot"], patient_id=r["patient_id"], mrn=r["mrn"],
        visit_number=r["visit_number"], visit_type=r["visit_type"], visit_status=r["visit_status_snapshot"], product_count=r["product_count"],
        quantity_total=str(r["quantity_total"]), returned_quantity_total=str(r["returned_quantity_total"]),
        gross=money(r["gross_amount_cents"]), discount=money(r["discount_amount_cents"]), tax=money(r["tax_amount_cents"]),
        net=money(r["net_amount_cents"]), rounded=money(r["rounded_amount_cents"]), paid=money(r["paid_amount_cents"]),
        balance=money(r["balance_amount_cents"]), converted_sales_number=r["converted_sales_number"], estimate_number=r["estimate_number"],
        cancelled_at=r["cancelled_at"], cancel_reason=r["cancel_reason"] if r["cancel_reason"] not in (None, "null") else None,
        # a name only for the kind of login kept with the cancellation; otherwise the number, never the other person sharing it
        cancelled_by_name=r["cancelled_by_known"] or (f"User {r['cancelled_by']}" if r["cancelled_by"] else None),
    ) for r in found]
    return SalesRegister(summary=summary, rows=rows, permissions=permissions)


# ---- the New Sale counter: what it may do, the products it sells and their batches, at the working location ---------

class Counter(BaseModel):
    permissions: SalesPermissions
    payment_modes: list[PaymentMode]
    print_devices: PrintDevices


class SaleProduct(BaseModel):
    item_id: int
    item_name: str
    generic_name: str | None
    unit_of_measure: str | None
    tax_percent: str
    hsn_code: str | None
    product_category_code: str | None
    manufacturer_code: str | None
    dispensable_stock: str
    selling_price_cents: int | None  # the MRP of the stock moved last, as DocAssist prices a sale; None: no batch price
    storage_bin: str | None  # rack / bin of the batch a sale takes first
    default_unit_mrp_cents: int | None
    last_purchase_unit_mrp_cents: int | None
    last_purchase_date: date | None
    last_purchase_packing: str | None


class SaleBatch(BaseModel):
    batch_id: int
    batch_number: str | None
    expiry_date: date | None
    quantity_on_hand: str
    unit_mrp_cents: int | None
    rack_code: str | None
    bin_code: str | None


def _stock_location(cur, user: User, location_id: int) -> int:
    """A sale takes stock from an active stock location of the login's hospital, never a place named as-is."""
    cur.execute("SELECT location_id FROM stock_locations WHERE location_id = %s AND hospital_id = %s AND is_active = 1 AND is_stock_location = 1",
                (location_id, user.hospital_id))
    if not cur.fetchone():
        raise HTTPException(422, "That is not an active pharmacy location of this hospital.")
    return location_id


def _payment_modes(cur, user: User) -> list[PaymentMode]:
    cur.execute("SELECT reference_code FROM his_reference_values WHERE hospital_id = %s AND reference_type = 'PAYMENT_MODE' AND is_active = 1"
                " ORDER BY sort_order, reference_value_id", (user.hospital_id,))
    configured = [c for c in dict.fromkeys(str(r["reference_code"] or "").upper() for r in cur.fetchall()) if c in PAYMENT_MODES]
    # configured modes first, then the rest of the modes the payment ledger can hold
    return [PaymentMode(code=c, label=PAYMENT_MODES[c], configured=c in configured) for c in configured + [c for c in PAYMENT_MODES if c not in configured]]


def _print_devices(cur, user: User, location_id: int | None) -> PrintDevices:
    cur.execute(
        "SELECT UPPER(ld.device_role) AS role, COALESCE(dv.device_name, dv.device_code) AS name FROM his_location_devices ld"
        " JOIN his_devices dv ON dv.device_id = ld.device_id WHERE ld.hospital_id = %s AND ld.is_active = 1 AND dv.is_active = 1"
        " AND (%s IS NULL OR ld.location_id = %s) ORDER BY ld.is_default DESC, ld.location_device_id",
        (user.hospital_id, location_id, location_id),
    )
    devices: dict[str, str] = {}
    for r in cur.fetchall():
        devices.setdefault(r["role"], r["name"])
    return PrintDevices(bill=devices.get("BILL_PRINT"), label=devices.get("OP_LABEL_PRINT"))


@router.get("/counter")
def counter(location_id: Annotated[int, Query(ge=1)], user: Annotated[User, Depends(current_user)]) -> Counter:
    with transaction() as cur:
        _stock_location(cur, user, location_id)
        return Counter(permissions=sales_permissions(cur, user), payment_modes=_payment_modes(cur, user), print_devices=_print_devices(cur, user, location_id))


_AT = ("FROM inventory_stock_balances b JOIN stock_locations l ON l.location_id = b.location_id"
       " WHERE b.source_module = 'PHARMACY' AND b.item_id = i.item_id AND b.quantity_on_hand > 0 AND b.is_active = 1"
       " AND l.hospital_id = %s AND b.location_id = %s")


def _last_purchase(column: str) -> str:
    return (f"(SELECT {column} FROM purchase_document_items pdi JOIN purchase_documents pd ON pd.purchase_document_id = pdi.purchase_document_id"
            " WHERE pd.source_module = 'PHARMACY' AND pd.hospital_id = %s AND pd.purchase_type IN ('GOODS_RECEIPT', 'SUPPLIER_INVOICE')"
            " AND pd.status NOT IN ('CANCELLED', 'REJECTED') AND pdi.source_item_type = 'PHARMACY_ITEM' AND pdi.source_item_id = i.item_id"
            + (" AND pdi.unit_mrp_cents > 0" if "mrp" in column else " AND pdi.packing <> ''" if "packing" in column else "") + " ORDER BY pd.document_date DESC, pdi.purchase_item_id DESC LIMIT 1)")


@router.get("/products")
def sale_products(
    location_id: Annotated[int, Query(ge=1)], user: Annotated[User, Depends(current_user)], q: Annotated[str, Query(max_length=100)] = "",
) -> list[SaleProduct]:
    """Up to 20 active products for the sale picker, with their stock, price and shelf at the working location."""
    with transaction() as cur:
        _stock_location(cur, user, location_id)
        pattern = like(q)
        here = (user.hospital_id, location_id)
        cur.execute(
            f"""SELECT i.item_id, i.item_name, i.generic_name, i.unit_of_measure, i.tax_percent, i.hsn_code, i.product_category_code,
                       i.manufacturer_code,
                       -- the price a row starts at: the last purchase MRP, else the MRP of the stock moved last anywhere in the hospital
                       COALESCE({_last_purchase('pdi.unit_mrp_cents')}, (SELECT b.unit_mrp_cents FROM inventory_stock_balances b
                         JOIN stock_locations l ON l.location_id = b.location_id WHERE b.source_module = 'PHARMACY' AND b.item_id = i.item_id
                         AND b.unit_mrp_cents > 0 AND b.is_active = 1 AND l.hospital_id = %s ORDER BY b.last_movement_at DESC, b.stock_balance_id DESC LIMIT 1))
                         AS default_unit_mrp_cents,
                       (SELECT COALESCE(SUM(b.quantity_on_hand), 0) {_AT}) AS dispensable_stock,
                       (SELECT b.unit_mrp_cents {_AT} AND b.unit_mrp_cents > 0 ORDER BY b.last_movement_at DESC, b.stock_balance_id DESC LIMIT 1) AS selling_price_cents,
                       -- the rack and bin of the batch a sale takes first: its own words, else those of its storage bin
                       (SELECT NULLIF(CONCAT_WS(' / ', NULLIF(COALESCE(NULLIF(b.rack_code, ''), sb.rack_code), ''),
                                                NULLIF(COALESCE(NULLIF(b.bin_code, ''), sb.bin_code), '')), '')
                          FROM inventory_stock_balances b JOIN stock_locations l ON l.location_id = b.location_id
                          LEFT JOIN inventory_batches ib ON ib.batch_id = b.batch_id LEFT JOIN stock_storage_bins sb ON sb.storage_bin_id = b.storage_bin_id
                         WHERE b.source_module = 'PHARMACY' AND b.item_id = i.item_id AND b.quantity_on_hand > 0 AND b.is_active = 1
                           AND l.hospital_id = %s AND b.location_id = %s AND (ib.expiry_date IS NULL OR ib.expiry_date >= CURDATE())
                         ORDER BY (ib.expiry_date IS NULL), ib.expiry_date ASC, b.batch_id ASC, b.stock_balance_id ASC LIMIT 1) AS storage_bin,
                       {_last_purchase('pdi.unit_mrp_cents')} AS last_purchase_unit_mrp_cents,
                       {_last_purchase('pd.document_date')} AS last_purchase_date,
                       {_last_purchase('pdi.packing')} AS last_purchase_packing
                  FROM pharmacy_items i
                 WHERE i.is_active = 1 AND (%s = '' OR i.item_name LIKE %s ESCAPE '\\\\' OR i.generic_name LIKE %s ESCAPE '\\\\'
                       OR i.brand_name LIKE %s ESCAPE '\\\\' OR i.product_code LIKE %s ESCAPE '\\\\')
                 ORDER BY i.item_name LIMIT 20""",
            (user.hospital_id, user.hospital_id, *here, *here, *here, user.hospital_id, user.hospital_id, user.hospital_id,
             q.strip(), pattern, pattern, pattern, pattern),
        )
        return [SaleProduct(**{**r, "tax_percent": str(r["tax_percent"] or 0), "dispensable_stock": str(r["dispensable_stock"])}) for r in cur.fetchall()]


@router.get("/products/{item_id}/batches")
def sale_batches(item_id: int, location_id: Annotated[int, Query(ge=1)], user: Annotated[User, Depends(current_user)]) -> list[SaleBatch]:
    """The unexpired batches of a product on the shelf at the working location, the one a sale takes first at the top."""
    with transaction() as cur:
        _stock_location(cur, user, location_id)
        cur.execute(
            """SELECT b.batch_id, ib.batch_number, ib.expiry_date, SUM(b.quantity_on_hand) AS quantity_on_hand, MAX(b.unit_mrp_cents) AS unit_mrp_cents,
                      GROUP_CONCAT(DISTINCT NULLIF(COALESCE(NULLIF(b.rack_code, ''), sb.rack_code), '') SEPARATOR ', ') AS rack_code,
                      GROUP_CONCAT(DISTINCT NULLIF(COALESCE(NULLIF(b.bin_code, ''), sb.bin_code), '') SEPARATOR ', ') AS bin_code
                 FROM inventory_stock_balances b JOIN stock_locations l ON l.location_id = b.location_id
                 LEFT JOIN inventory_batches ib ON ib.batch_id = b.batch_id LEFT JOIN stock_storage_bins sb ON sb.storage_bin_id = b.storage_bin_id
                WHERE b.source_module = 'PHARMACY' AND b.is_active = 1 AND b.quantity_on_hand > 0 AND b.item_id = %s AND l.hospital_id = %s
                  AND b.location_id = %s AND (ib.expiry_date IS NULL OR ib.expiry_date >= CURDATE())
                GROUP BY b.batch_id, ib.batch_number, ib.expiry_date
                ORDER BY (ib.expiry_date IS NULL), ib.expiry_date ASC, b.batch_id ASC""",
            (item_id, user.hospital_id, location_id),
        )
        return [SaleBatch(**{**r, "quantity_on_hand": str(r["quantity_on_hand"])}) for r in cur.fetchall()]
