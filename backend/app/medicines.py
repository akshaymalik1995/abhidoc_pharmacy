"""Medicines: the product catalog. The catalog is shared between hospitals; the dropdown
lists (manufacturer, product group, ...) belong to the hospital of the login."""
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints

from .auth import User, current_user
from .db import transaction

router = APIRouter(prefix="/api/medicines", tags=["medicines"])

# Form field -> (reference type of its dropdown list, plain name used in messages).
# A value chosen for one of these must be an active entry of the hospital's list.
REFERENCE_FIELDS = {
    "product_group_code": ("PRODUCT_GROUP", "product group"),
    "product_category_code": ("PRODUCT_CATEGORY", "product category"),
    "manufacturer_code": ("MANUFACTURER", "manufacturer"),
    "marketer_code": ("MARKETER", "marketer"),
    "division_code": ("DIVISION", "division"),
    "route_administration": ("ROUTE_ADMINISTRATION", "route of administration"),
    "prescription_classification": ("PRESCRIPTION_CLASSIFICATION", "prescription classification"),
    "drug_classification": ("DRUG_CLASSIFICATION", "drug classification"),
}
# Offered from a list but free text is accepted: older rows hold plain words here.
SUGGESTED_FIELDS = {"dosage_form": "DOSAGE_FORM", "unit_of_measure": "STOCK_UNIT"}
# The list can be narrowed by these columns only.
FILTER_FIELDS = (
    "product_group_code", "product_category_code", "manufacturer_code",
    "marketer_code", "prescription_classification",
)


def text(max_length: int):
    return Annotated[str, StringConstraints(strip_whitespace=True, max_length=max_length)]


def number(max_digits: int, decimal_places: int):
    return Annotated[Decimal, Field(ge=0, max_digits=max_digits, decimal_places=decimal_places)]


class MedicineForm(BaseModel):
    """Exactly the fields of the product form. Lengths and precisions match the table's columns."""
    item_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
    item_type: Literal["MEDICINE", "CONSUMABLE", "OTHER"] = "MEDICINE"
    unit_of_measure: text(50) = "unit"
    generic_name: text(255) = ""
    brand_name: text(255) = ""
    dosage_form: text(100) = ""
    strength: text(100) = ""
    product_code: text(64) = ""
    hsn_code: text(32) = ""
    product_group_code: text(64) = ""
    product_category_code: text(64) = ""
    manufacturer_code: text(64) = ""
    marketer_code: text(64) = ""
    division_code: text(64) = ""
    route_administration: text(128) = ""
    prescription_classification: text(128) = ""
    drug_classification: text(128) = ""
    storage_temperature: text(128) = ""
    snomed_branded_medicine_id: text(128) = ""
    snomed_generic_medicine_id: text(128) = ""
    tax_percent: number(5, 2) = Decimal(0)
    discount_percent: number(6, 3) = Decimal(0)
    minimum_margin_percent: number(6, 3) = Decimal(0)
    reorder_level: number(12, 3) = Decimal(0)
    reorder_quantity: number(12, 3) = Decimal(0)
    minimum_order_quantity: number(12, 3) = Decimal(0)
    is_expirable: bool = True
    is_claimable: bool = False
    is_non_returnable: bool = False
    is_non_discountable: bool = False
    is_high_risk_medicine: bool = False
    is_emergency_medicine: bool = False
    is_consignment_product: bool = False


class Medicine(MedicineForm):
    item_id: int
    is_active: bool


class MedicineRow(BaseModel):
    item_id: int
    item_name: str
    generic_name: str | None
    item_type: str
    strength: str | None
    dosage_form: str | None
    unit: str | None
    manufacturer: str | None
    tax_percent: Decimal
    reorder_level: Decimal
    is_active: bool


class MedicinePage(BaseModel):
    items: list[MedicineRow]
    total: int


class Option(BaseModel):
    code: str
    name: str


class SetActive(BaseModel):
    active: bool


_FORM_COLUMNS = tuple(MedicineForm.model_fields)
_NULL_WHEN_BLANK = {  # nullable text columns: a blank field is stored as NULL, as DocAssist does
    name for name, field in MedicineForm.model_fields.items()
    if field.annotation is str and name not in ("item_name", "unit_of_measure")
}


def _name(alias: str, reference_type: str, column: str) -> str:
    """LEFT JOIN that turns a stored code into the hospital's name for it."""
    return (
        f" LEFT JOIN his_reference_values {alias} ON {alias}.hospital_id = %s"
        f" AND {alias}.reference_type = '{reference_type}' AND {alias}.reference_code = i.{column}"
    )


@router.get("")
def list_medicines(
    q: Annotated[str, Query(max_length=100)] = "",
    status: Literal["active", "all"] = "active",
    consignment: bool | None = None,
    product_group_code: Annotated[str, Query(max_length=64)] = "",
    product_category_code: Annotated[str, Query(max_length=64)] = "",
    manufacturer_code: Annotated[str, Query(max_length=64)] = "",
    marketer_code: Annotated[str, Query(max_length=64)] = "",
    prescription_classification: Annotated[str, Query(max_length=128)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    user: User = Depends(current_user),
) -> MedicinePage:
    """One page of the catalog and the total, in one query."""
    chosen = dict(zip(FILTER_FIELDS, (
        product_group_code, product_category_code, manufacturer_code,
        marketer_code, prescription_classification,
    )))
    where, params = ["1 = 1"], []
    if status == "active":
        where.append("i.is_active = 1")
    if q.strip():
        where.append("(i.item_name LIKE %s OR i.generic_name LIKE %s OR i.brand_name LIKE %s)")
        params += [f"%{q.strip()}%"] * 3
    for column, value in chosen.items():
        if value:
            where.append(f"i.{column} = %s")
            params.append(value)
    if consignment is not None:
        where.append("i.is_consignment_product = %s")
        params.append(int(consignment))

    sql = (
        "SELECT i.item_id, i.item_name, i.generic_name, i.item_type, i.strength, i.tax_percent,"
        " i.reorder_level, i.is_active,"
        " COALESCE(df.display_name, i.dosage_form) AS dosage_form,"
        " COALESCE(su.display_name, i.unit_of_measure) AS unit,"
        " COALESCE(mf.display_name, i.manufacturer_code) AS manufacturer,"
        " COUNT(*) OVER () AS total"
        " FROM pharmacy_items i"
        + _name("df", "DOSAGE_FORM", "dosage_form")
        + _name("su", "STOCK_UNIT", "unit_of_measure")
        + _name("mf", "MANUFACTURER", "manufacturer_code")
        + f" WHERE {' AND '.join(where)}"
        " ORDER BY i.created_at DESC, i.item_id DESC LIMIT %s OFFSET %s"
    )
    with transaction() as cur:
        cur.execute(sql, (user.hospital_id,) * 3 + (*params, limit, offset))
        rows = cur.fetchall()
    return MedicinePage(items=rows, total=rows[0]["total"] if rows else 0)


@router.get("/options")
def options(user: User = Depends(current_user)) -> dict[str, list[Option]]:
    """The hospital's active choices for every dropdown of the form and the filters."""
    field_of = {ref_type: field for field, (ref_type, _) in REFERENCE_FIELDS.items()}
    field_of.update({ref_type: field for field, ref_type in SUGGESTED_FIELDS.items()})
    marks = ", ".join(["%s"] * len(field_of))
    with transaction() as cur:
        cur.execute(
            "SELECT reference_type, reference_code AS code, display_name AS name"
            " FROM his_reference_values WHERE hospital_id = %s AND is_active = 1"
            f" AND reference_type IN ({marks}) ORDER BY sort_order, display_name",
            (user.hospital_id, *field_of),
        )
        rows = cur.fetchall()
    result: dict[str, list] = {field: [] for field in field_of.values()}
    for row in rows:
        result[field_of[row["reference_type"]]].append(row)
    return result


def _load(cur, item_id: int, lock: bool = False) -> dict:
    columns = ", ".join(_FORM_COLUMNS)
    cur.execute(
        f"SELECT item_id, is_active, {columns} FROM pharmacy_items WHERE item_id = %s"
        + (" FOR UPDATE" if lock else ""),
        (item_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Product not found.")
    # nullable text columns come back as None; the form speaks in blanks
    return {key: "" if value is None and key in _NULL_WHEN_BLANK else value for key, value in row.items()}


def _refuse_clashes(cur, item_name: str, product_code: str, item_id: int) -> None:
    """An active product's name and product code are each its own (0 = a new product)."""
    cur.execute(
        "SELECT (LOWER(item_name) = LOWER(%s)) AS same_name FROM pharmacy_items"
        " WHERE is_active = 1 AND item_id <> %s"
        " AND (LOWER(item_name) = LOWER(%s) OR (%s <> '' AND product_code = %s)) LIMIT 1",
        (item_name, item_id, item_name, product_code, product_code),
    )
    clash = cur.fetchone()
    if clash and clash["same_name"]:
        raise HTTPException(409, f"A product named '{item_name}' already exists.")
    if clash:
        raise HTTPException(409, f"Product code '{product_code}' is already used by another product.")


def _refuse_unknown_choices(cur, form: MedicineForm, stored: dict | None, hospital_id: int) -> None:
    """A newly chosen dropdown value must be on the hospital's active list. A value left as it
    was is not checked: the catalog is shared, so an old row may hold another hospital's code."""
    changed = {
        field: getattr(form, field) for field in REFERENCE_FIELDS
        if getattr(form, field) and getattr(form, field) != (stored or {}).get(field)
    }
    if not changed:
        return
    types = [REFERENCE_FIELDS[field][0] for field in changed]
    cur.execute(
        "SELECT reference_type, reference_code FROM his_reference_values"
        f" WHERE hospital_id = %s AND is_active = 1 AND reference_type IN ({', '.join(['%s'] * len(types))})",
        (hospital_id, *types),
    )
    known = {(row["reference_type"], row["reference_code"]) for row in cur.fetchall()}
    for field, value in changed.items():
        reference_type, label = REFERENCE_FIELDS[field]
        if (reference_type, value) not in known:
            raise HTTPException(
                422, f"'{value}' is not a {label} of this hospital. Choose one from the list or add it in Masters.")


def _column_values(form: MedicineForm) -> list:
    values = form.model_dump()
    return [None if values[c] == "" and c in _NULL_WHEN_BLANK else values[c] for c in _FORM_COLUMNS]


@router.get("/{item_id}")
def get_medicine(item_id: int, user: User = Depends(current_user)) -> Medicine:
    with transaction() as cur:
        return Medicine(**_load(cur, item_id))


@router.post("", status_code=201)
def create_medicine(form: MedicineForm, user: User = Depends(current_user)) -> Medicine:
    with transaction() as cur:
        _refuse_clashes(cur, form.item_name, form.product_code, 0)
        _refuse_unknown_choices(cur, form, None, user.hospital_id)
        cur.execute(
            f"INSERT INTO pharmacy_items ({', '.join(_FORM_COLUMNS)})"
            f" VALUES ({', '.join(['%s'] * len(_FORM_COLUMNS))})",
            _column_values(form),
        )
        return Medicine(**_load(cur, cur.lastrowid))


@router.put("/{item_id}")
def update_medicine(item_id: int, form: MedicineForm, user: User = Depends(current_user)) -> Medicine:
    with transaction() as cur:
        stored = _load(cur, item_id, lock=True)
        _refuse_clashes(cur, form.item_name, form.product_code, item_id)
        _refuse_unknown_choices(cur, form, stored, user.hospital_id)
        cur.execute(
            f"UPDATE pharmacy_items SET {', '.join(f'{c} = %s' for c in _FORM_COLUMNS)} WHERE item_id = %s",
            (*_column_values(form), item_id),
        )
        return Medicine(**_load(cur, item_id))


@router.post("/{item_id}/active", status_code=204)
def set_active(item_id: int, body: SetActive, user: User = Depends(current_user)) -> None:
    with transaction() as cur:
        stored = _load(cur, item_id, lock=True)
        if body.active and not stored["is_active"]:
            # coming back must not create a second active product of the same name or code
            _refuse_clashes(cur, stored["item_name"], stored["product_code"], item_id)
        cur.execute("UPDATE pharmacy_items SET is_active = %s WHERE item_id = %s", (int(body.active), item_id))
