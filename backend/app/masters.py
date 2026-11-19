"""Masters: the small lists the pharmacy keeps (product groups, locations, tax codes, ...).

Every master is the same screen over a different table, so each is one entry in MASTERS and
one set of endpoints serves them all. A value's limits (length, may it be empty) are read
from the table itself, once.
"""
from dataclasses import dataclass, field as dataclass_field
from datetime import date
from decimal import Decimal, InvalidOperation
from functools import cache
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from mysql.connector import IntegrityError
from pydantic import BaseModel

from .auth import User, current_user
from .db import transaction

router = APIRouter(prefix="/api/masters", tags=["masters"])

FieldType = Literal["text", "textarea", "email", "number", "date", "select", "checkbox"]


class Field(BaseModel):
    name: str
    label: str
    type: FieldType = "text"
    required: bool = False
    options: list[str] = []
    default: str | int | None = None


@dataclass(frozen=True)
class Master:
    label: str
    group: str
    table: str
    pk: str
    order: str
    search: tuple[str, ...]
    fields: tuple[Field, ...]
    columns: tuple[str, ...]  # shown in the list
    fixed: dict[str, str] = dataclass_field(default_factory=dict)  # values every record of this master has
    # WHERE clause tying a row to the hospital (one %s)
    scope: str = "hospital_id = %s"
    stamps: tuple[str, ...] = ("hospital_id", "created_by", "updated_by")  # set by the server, never the form


def f(name: str, label: str, type: FieldType = "text", *, required=False, options=(), default=None) -> Field:
    return Field(name=name, label=label, type=type, required=required, options=list(options), default=default)


ACTIVE = f("is_active", "Active", "checkbox", default=1)
LOCATION = f("location_id", "Location ID", "number", default=0)
MODULES = ("ACCOUNTS", "SALES", "PURCHASE", "STOCK", "PHARMACY", "LAB", "RADIOLOGY", "CLINICAL", "GENERAL")
SCOPES = ("GLOBAL", "HOSPITAL", "LOCATION", "PHARMACY", "LAB", "RADIOLOGY", "ACCOUNTS", "SALES", "PURCHASE", "STOCK")


def named_master(label: str, reference_type: str, *extra: Field) -> Master:
    """A product list kept in his_reference_values under one reference type."""
    return Master(
        label=label, group="Products", table="his_reference_values", pk="reference_value_id",
        order="sort_order DESC", search=("reference_type", "reference_code", "display_name", "description"),
        fixed={"reference_type": reference_type, "module_code": "PHARMACY"},
        fields=(
            f("reference_code", "Code", required=True), f("display_name", "Name", required=True), *extra,
            f("description", "Description", "textarea"), f("sort_order", "Sort Order", "number", default=0), ACTIVE,
        ),
        columns=("reference_code", "display_name", *(field.name for field in extra), "is_active"),
    )


MASTERS: dict[str, Master] = {
    "product_groups": named_master(
        "Product Groups", "PRODUCT_GROUP",
        f("boolean_value", "Molecule Needed", "checkbox", default=0), f("number_value", "Default Discount %", "number")),
    "product_categories": named_master(
        "Product Categories", "PRODUCT_CATEGORY",
        f("string_value", "Pharma / Non Pharma", "select", options=("Pharma", "Non Pharma"), default="Pharma")),
    "manufacturers": named_master("Manufacturers", "MANUFACTURER"),
    "marketers": named_master("Marketers", "MARKETER"),
    "divisions": named_master("Divisions", "DIVISION"),
    "routes_of_administration": named_master("Routes of Administration", "ROUTE_ADMINISTRATION"),
    "prescription_classifications": named_master(
        "Prescription Classifications", "PRESCRIPTION_CLASSIFICATION",
        f("boolean_value", "Prescription Needed", "checkbox", default=0)),
    "dosage_forms": named_master("Dosage Forms", "DOSAGE_FORM"),
    "drug_units": named_master("Drug Units", "DRUG_UNIT", f("string_value", "SNOMED Qualifier Value")),
    "stock_units": named_master("Stock Units", "STOCK_UNIT", f("boolean_value", "Base Unit", "checkbox", default=0)),
    "drug_classifications": named_master(
        "Drug Classifications", "DRUG_CLASSIFICATION",
        f("string_value", "Drug Instruction"), f("boolean_value", "Unskippable", "checkbox", default=0)),
    "stock_locations": Master(
        label="Stock Locations", group="Stock", table="stock_locations", pk="location_id",
        order="location_name DESC", search=("location_code", "location_name", "linked_entity_type"),
        stamps=("hospital_id", "created_by"),
        fields=(
            f("location_code", "Location Code", required=True), f("location_name", "Location Name", required=True),
            f("location_type", "Type", "select", required=True, default="PHARMACY", options=(
                "PHARMACY", "STORE", "WARD", "DEPARTMENT", "COUNTER", "LAB", "RADIOLOGY", "IN_TRANSIT", "CONSIGNMENT", "OTHER")),
            f("linked_entity_type", "Linked Entity Type"), f("linked_entity_id", "Linked Entity ID", "number"),
            f("is_stock_location", "Stock Location", "checkbox", default=1),
            f("is_internal_issue_location", "Internal Issue", "checkbox", default=0), ACTIVE,
        ),
        columns=("location_code", "location_name", "location_type", "is_stock_location", "is_internal_issue_location", "is_active"),
    ),
    "storage_bins": Master(
        label="Storage Bins", group="Stock", table="stock_storage_bins", pk="storage_bin_id",
        order="display_order DESC", search=("rack_code", "rack_name", "bin_code", "bin_name"),
        # a bin has no hospital of its own: it belongs to its location's hospital
        scope="location_id IN (SELECT location_id FROM stock_locations WHERE hospital_id = %s)",
        stamps=("created_by",),
        fields=(
            f("location_id", "Location ID", "number", required=True), f("rack_code", "Rack Code", default=""),
            f("rack_name", "Rack Name"), f("bin_code", "Bin Code", default=""), f("bin_name", "Bin Name"),
            f("display_order", "Display Order", "number", default=0), ACTIVE,
        ),
        columns=("location_id", "rack_code", "rack_name", "bin_code", "bin_name", "is_active"),
    ),
    "tax_codes": Master(
        label="Tax Codes", group="Finance", table="his_tax_codes", pk="tax_code_id",
        order="effective_from DESC", search=("tax_code", "tax_name", "hsn_code", "tax_type", "tax_subtype"),
        fields=(
            f("tax_code", "Tax Code", required=True), f("tax_name", "Tax Name", required=True), f("hsn_code", "HSN Code"),
            f("tax_type", "Tax Type"), f("tax_subtype", "Tax Subtype"), f("gst_percent", "GST %", "number", default=0),
            f("cgst_percent", "CGST %", "number", default=0), f("sgst_percent", "SGST %", "number", default=0),
            f("igst_percent", "IGST %", "number", default=0), f("effective_from", "Effective From", "date", required=True),
            f("effective_to", "Effective To", "date"), ACTIVE,
        ),
        columns=("tax_code", "tax_name", "hsn_code", "gst_percent", "effective_from", "is_active"),
    ),
    "banks": Master(
        label="Banks", group="Finance", table="his_banks", pk="bank_id",
        order="bank_name DESC", search=("bank_code", "bank_name", "branch_name", "account_name", "ifsc_code", "micr_code"),
        fields=(
            LOCATION, f("bank_code", "Bank Code", required=True), f("bank_name", "Bank Name", required=True),
            f("branch_name", "Branch"), f("account_name", "Account Name"), f("account_number_masked", "Masked Account"),
            f("ifsc_code", "IFSC"), f("micr_code", "MICR"), f("is_default", "Default", "checkbox", default=0), ACTIVE,
        ),
        columns=("bank_code", "bank_name", "branch_name", "ifsc_code", "is_default", "is_active"),
    ),
    "discount_rules": Master(
        label="Discount Rules", group="Finance", table="his_discount_rules", pk="discount_rule_id",
        order="valid_from DESC", search=("discount_code", "discount_name", "reference_type"),
        fields=(
            LOCATION, f("discount_code", "Discount Code", required=True), f("discount_name", "Discount Name", required=True),
            f("discount_scope", "Scope", "select", default="GENERAL", options=(
                "SALE", "PURCHASE", "PRODUCT", "PRODUCT_GROUP", "PRODUCT_CATEGORY", "PATIENT_TYPE", "PAYER", "GENERAL")),
            f("reference_type", "Reference Type"), f("reference_id", "Reference ID", "number"),
            f("discount_percent", "Discount %", "number", default=0),
            f("discount_amount_cents", "Discount Cents", "number", default=0),
            f("max_discount_amount_cents", "Max Discount Cents", "number"),
            f("valid_from", "Valid From", "date", required=True), f("valid_to", "Valid To", "date"),
            f("is_default", "Default", "checkbox", default=0),
            f("requires_approval", "Requires Approval", "checkbox", default=0), ACTIVE,
        ),
        columns=("discount_code", "discount_name", "discount_scope", "discount_percent", "valid_from", "is_active"),
    ),
    "feature_flags": Master(
        label="Feature Flags", group="Permissions", table="his_feature_flags", pk="feature_flag_id",
        order="updated_at DESC", search=("feature_code", "feature_name", "approval_role_code"),
        fields=(
            LOCATION, f("module_code", "Module", "select", required=True, default="PHARMACY", options=MODULES),
            f("feature_code", "Feature Code", required=True), f("feature_name", "Feature Name", required=True),
            f("is_enabled", "Enabled", "checkbox", default=0),
            f("requires_approval", "Requires Approval", "checkbox", default=0),
            f("approval_role_code", "Approval Role"), f("min_amount_cents", "Min Amount Cents", "number"),
            f("max_amount_cents", "Max Amount Cents", "number"), f("effective_from", "Effective From", "date"),
            f("effective_to", "Effective To", "date"),
        ),
        columns=("module_code", "feature_code", "feature_name", "is_enabled", "requires_approval", "approval_role_code"),
    ),
    "document_sequences": Master(
        label="Document Sequences", group="Settings", table="his_document_sequences", pk="document_sequence_id",
        order="updated_at DESC", search=("document_type", "prefix", "last_generated_number"),
        fields=(
            f("module_code", "Module", "select", required=True, default="PHARMACY", options=MODULES),
            f("document_type", "Document Type", required=True), LOCATION, f("payment_mode", "Payment Mode", default=""),
            f("financial_year", "Financial Year", default=""), f("prefix", "Prefix", default=""),
            f("suffix", "Suffix", default=""), f("current_sequence", "Current Sequence", "number", default=0),
            f("padding_length", "Padding Length", "number", default=0),
            f("reset_policy", "Reset Policy", "select", default="FINANCIAL_YEAR", options=("NEVER", "FINANCIAL_YEAR", "MONTH", "DAY")),
            ACTIVE,
        ),
        columns=("module_code", "document_type", "prefix", "current_sequence", "financial_year", "is_active"),
    ),
    "reference_values": Master(
        label="Reference Values", group="Settings", table="his_reference_values", pk="reference_value_id",
        order="sort_order DESC", search=("reference_type", "reference_code", "display_name", "description"),
        fields=(
            f("module_code", "Module", "select", required=True, default="PHARMACY", options=MODULES),
            f("reference_type", "Reference Type", required=True), f("reference_code", "Code", required=True),
            f("display_name", "Display Name", required=True), f("description", "Description", "textarea"),
            f("parent_reference_value_id", "Parent ID", "number"), f("string_value", "String Value"),
            f("number_value", "Number Value", "number"), f("boolean_value", "Boolean Value", "checkbox"),
            f("date_value", "Date Value", "date"), f("sort_order", "Sort Order", "number", default=0),
            f("is_system", "System", "checkbox", default=0), ACTIVE,
        ),
        columns=("reference_type", "reference_code", "display_name", "module_code", "sort_order", "is_active"),
    ),
    "org_settings": Master(
        label="Organization Settings", group="Settings", table="his_org_settings", pk="org_setting_id",
        order="updated_at DESC", search=("business_name", "branch_name", "gst_number", "drug_license_number", "financial_year"),
        fields=(
            f("setting_scope", "Scope", "select", required=True, default="PHARMACY", options=SCOPES), LOCATION,
            f("business_name", "Business Name"), f("branch_name", "Branch Name"), f("release_version", "Release Version"),
            f("primary_email", "Primary Email", "email"), f("phone_number", "Phone"), f("gst_number", "GST Number"),
            f("drug_license_number", "Drug License"), f("financial_year", "Financial Year"),
            f("financial_year_start", "FY Start", "date"), f("financial_year_end", "FY End", "date"),
            f("default_bank_id", "Default Bank ID", "number"), ACTIVE,
        ),
        columns=("setting_scope", "business_name", "branch_name", "financial_year", "gst_number", "is_active"),
    ),
}


class MasterInfo(BaseModel):
    key: str
    label: str
    group: str
    pk: str
    fields: list[Field]
    columns: list[str]
    count: int


class MasterPage(BaseModel):
    rows: list[dict[str, Any]]
    total: int


@cache
def _column_limits() -> dict[tuple[str, str], dict]:
    """(table, column) -> may it be NULL, longest text, and whether it holds whole numbers."""
    tables = sorted({master.table for master in MASTERS.values()})
    with transaction() as cur:
        cur.execute(
            "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, IS_NULLABLE = 'YES' AS nullable,"
            " CHARACTER_MAXIMUM_LENGTH AS max_length, DATA_TYPE AS kind"
            " FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()"
            f" AND TABLE_NAME IN ({', '.join(['%s'] * len(tables))})",
            tables,
        )
        return {(row["t"], row["c"]): row for row in cur.fetchall()}


def _master(key: str) -> Master:
    master = MASTERS.get(key)
    if not master:
        raise HTTPException(404, "This list does not exist.")
    return master


def _where(master: Master, hospital_id: int) -> tuple[str, list]:
    clauses, params = [master.scope], [hospital_id]
    for column, value in master.fixed.items():
        if column != "module_code":  # module_code is written on a new record, not required of old ones
            clauses.append(f"{column} = %s")
            params.append(value)
    return " AND ".join(clauses), params


@router.get("")
def list_masters(user: User = Depends(current_user)) -> list[MasterInfo]:
    """Every master with how many records it holds, counted in one query."""
    counts, params = [], []
    for key, master in MASTERS.items():
        where, values = _where(master, user.hospital_id)
        counts.append(f"SELECT %s AS k, COUNT(*) AS c FROM {master.table} WHERE {where}")
        params += [key, *values]
    with transaction() as cur:
        cur.execute(" UNION ALL ".join(counts), params)
        count_of = {row["k"]: row["c"] for row in cur.fetchall()}
    return [
        MasterInfo(key=key, label=m.label, group=m.group, pk=m.pk, fields=list(m.fields), columns=list(m.columns),
                   count=count_of.get(key, 0))
        for key, m in MASTERS.items()
    ]


@router.get("/{key}")
def list_records(
    key: str,
    q: Annotated[str, Query(max_length=100)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    user: User = Depends(current_user),
) -> MasterPage:
    master = _master(key)
    where, params = _where(master, user.hospital_id)
    if q.strip():
        where += " AND (" + " OR ".join(f"{column} LIKE %s" for column in master.search) + ")"
        params += [f"%{q.strip()}%"] * len(master.search)
    names = ", ".join((master.pk, *(field.name for field in master.fields)))
    with transaction() as cur:
        cur.execute(
            f"SELECT {names}, COUNT(*) OVER () AS _total FROM {master.table} WHERE {where}"
            f" ORDER BY {master.order}, {master.pk} DESC LIMIT %s OFFSET %s",
            (*params, limit, offset),
        )
        rows = cur.fetchall()
    total = rows[0]["_total"] if rows else 0
    for row in rows:
        del row["_total"]
    return MasterPage(rows=rows, total=total)


def _clean(master: Master, field: Field, raw: Any) -> Any:
    """One submitted value as the column takes it, or a 422 saying what is wrong with it."""
    limits = _column_limits()[(master.table, field.name)]

    def refuse(problem: str):
        raise HTTPException(422, f"{field.label}: {problem}")

    if field.type == "checkbox":
        return 1 if raw in (True, 1, "1", "true", "on", "yes") else 0
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        if field.required:
            refuse("enter a value.")
        if limits["nullable"]:
            return None
        return 0 if field.type == "number" else ""
    if isinstance(raw, bool) or not isinstance(raw, (str, int, float)):
        refuse("not a valid value.")
    if field.type == "number":
        try:
            number = Decimal(str(raw).strip())
        except InvalidOperation:
            refuse("enter a number.")
        if not number.is_finite() or abs(number) >= Decimal(10) ** 15:
            refuse("enter a number.")
        if limits["kind"] in ("int", "bigint", "smallint", "tinyint", "mediumint") and number != number.to_integral_value():
            refuse("enter a whole number.")
        return number
    text = str(raw).strip()
    if field.type == "date":
        try:
            return date.fromisoformat(text)
        except ValueError:
            refuse("enter a date.")
    if field.type == "select" and text not in field.options:
        refuse("choose one from the list.")
    if limits["max_length"] and len(text) > limits["max_length"]:
        refuse(f"at most {limits['max_length']} characters.")
    return text


def _values(master: Master, body: dict, creating: bool) -> dict:
    values = {}
    for field in master.fields:
        if field.name in body:
            values[field.name] = _clean(master, field, body[field.name])
        elif creating:
            values[field.name] = _clean(master, field, field.default)
    return values


def _refuse_twin(cur, master: Master, values: dict, record_id: int, hospital_id: int) -> None:
    """A named master holds each code once."""
    if "reference_type" not in master.fixed or "reference_code" not in values:
        return
    cur.execute(
        "SELECT 1 FROM his_reference_values WHERE hospital_id = %s AND reference_type = %s"
        " AND reference_code = %s AND reference_value_id <> %s LIMIT 1",
        (hospital_id, master.fixed["reference_type"], values["reference_code"], record_id),
    )
    if cur.fetchone():
        raise HTTPException(409, f"{master.label} already has the code {values['reference_code']}.")


def _refuse_foreign_location(cur, values: dict, hospital_id: int) -> None:
    """A bin can only be put in a location of this hospital."""
    cur.execute(
        "SELECT 1 FROM stock_locations WHERE location_id = %s AND hospital_id = %s",
        (values["location_id"], hospital_id),
    )
    if not cur.fetchone():
        raise HTTPException(422, "Location ID: there is no such location in this hospital.")


Record = Annotated[dict[str, Any], Body(max_length=64)]
_CLASH = "Could not save. Check that the code is not already used."


@router.post("/{key}", status_code=201)
def create_record(key: str, body: Record, user: User = Depends(current_user)) -> dict[str, int]:
    master = _master(key)
    values = _values(master, body, creating=True)
    stamps = {"hospital_id": user.hospital_id, "created_by": user.actor_id, "updated_by": user.actor_id}
    values |= master.fixed | {column: stamps[column] for column in master.stamps}
    with transaction() as cur:
        _refuse_twin(cur, master, values, 0, user.hospital_id)
        if key == "storage_bins":
            _refuse_foreign_location(cur, values, user.hospital_id)
        try:
            cur.execute(
                f"INSERT INTO {master.table} ({', '.join(values)}) VALUES ({', '.join(['%s'] * len(values))})",
                list(values.values()),
            )
        except IntegrityError:
            raise HTTPException(409, _CLASH) from None
        return {"id": cur.lastrowid}


@router.put("/{key}/{record_id}", status_code=204)
def update_record(key: str, record_id: int, body: Record, user: User = Depends(current_user)) -> None:
    master = _master(key)
    values = _values(master, body, creating=False)
    if "updated_by" in master.stamps:
        values["updated_by"] = user.actor_id
    where, params = _where(master, user.hospital_id)
    with transaction() as cur:
        # the record must be this hospital's, and of this master: an id alone proves neither
        cur.execute(f"SELECT 1 FROM {master.table} WHERE {master.pk} = %s AND {where} FOR UPDATE", (record_id, *params))
        if not cur.fetchone():
            raise HTTPException(404, "Record not found.")
        _refuse_twin(cur, master, values, record_id, user.hospital_id)
        if key == "storage_bins" and "location_id" in values:
            _refuse_foreign_location(cur, values, user.hospital_id)
        if not values:
            return
        try:
            cur.execute(
                f"UPDATE {master.table} SET {', '.join(f'{column} = %s' for column in values)} WHERE {master.pk} = %s",
                (*values.values(), record_id),
            )
        except IntegrityError:
            raise HTTPException(409, _CLASH) from None
