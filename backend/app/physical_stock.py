"""Physical Stock screen: everything it shows in one request, quantities saved in one request.

Starting, finishing and cancelling a count change stock balances; those still go
to DocAssist's own endpoints so the stock rules exist in one place only.
"""
from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import User, current_user
from .db import transaction

router = APIRouter(prefix="/api/physical-stock", tags=["physical-stock"])

Quantity = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=3)]


class Location(BaseModel):
    location_id: int
    location_name: str
    location_type: str | None


class Count(BaseModel):
    stock_document_id: int
    stock_number: str
    status: str
    document_date: date | None
    location_id: int
    location_name: str | None
    creator_name: str | None


class Line(BaseModel):
    stock_item_id: int
    description: str | None
    batch_number: str | None
    expiry_date: date | None
    rack_code: str | None
    bin_code: str | None
    counted_quantity: Decimal | None
    line_status: str
    # Never sent while the count is open: the person counting must not see the book figure.
    system_quantity: Decimal | None = None
    variance_quantity: Decimal | None = None
    reason: str | None = None


class Screen(BaseModel):
    locations: list[Location]
    location_id: int | None
    count: Count | None
    lines: list[Line]


class CountedLine(BaseModel):
    stock_item_id: int = Field(gt=0)
    counted_quantity: Quantity


class SaveLines(BaseModel):
    lines: list[CountedLine] = Field(min_length=1, max_length=5000)


_COUNT_SQL = """
    SELECT d.stock_document_id, d.stock_number, d.status, d.document_date, d.location_id,
           l.location_name,
           COALESCE(NULLIF(TRIM(CONCAT(doc.First_Name, ' ', COALESCE(doc.Last_Name, ''))), ''),
                    NULLIF(TRIM(CONCAT(adm.First_Name, ' ', COALESCE(adm.Last_Name, ''))), '')) AS creator_name
      FROM stock_documents d
      LEFT JOIN stock_locations l ON l.location_id = d.location_id
      LEFT JOIN Doctor doc ON doc.Doctor_ID = d.created_by
      LEFT JOIN Admin adm ON adm.Admin_ID = d.created_by
     WHERE d.stock_type = 'PHYSICAL_COUNT' AND d.source_module = 'PHARMACY' AND d.hospital_id = %s
"""
_LINE_COLUMNS = (
    "stock_item_id, description, batch_number, expiry_date, from_rack_code AS rack_code,"
    " from_bin_code AS bin_code, counted_quantity, line_status"
)
_BOOK_COLUMNS = ", system_quantity, variance_quantity, reason"


@router.get("")
def screen(
    location_id: int | None = None,
    count_id: int | None = None,
    user: User = Depends(current_user),
) -> Screen:
    """Locations, plus one count with its lines: the one asked for, else the open one at the location."""
    with transaction() as cur:
        cur.execute(
            "SELECT location_id, location_name, location_type FROM stock_locations"
            " WHERE hospital_id = %s AND is_active = 1 AND is_stock_location = 1"
            " ORDER BY location_name",
            (user.hospital_id,),
        )
        locations = cur.fetchall()

        if count_id:
            cur.execute(_COUNT_SQL + " AND d.stock_document_id = %s", (user.hospital_id, count_id))
            count = cur.fetchone()
            if not count:
                raise HTTPException(404, "Count not found.")
            location_id = count["location_id"]
        else:
            allowed = {row["location_id"] for row in locations}
            if location_id not in allowed:
                # ponytail: first pharmacy counter; DocAssist's header-store cookie is not read yet
                location_id = next(
                    (r["location_id"] for r in locations if r["location_type"] == "PHARMACY"),
                    locations[0]["location_id"] if locations else None,
                )
            cur.execute(
                _COUNT_SQL + " AND d.status = 'DRAFT' AND d.location_id = %s"
                " ORDER BY d.stock_document_id DESC LIMIT 1",
                (user.hospital_id, location_id),
            )
            count = cur.fetchone()

        lines = []
        if count:
            columns = _LINE_COLUMNS + ("" if count["status"] == "DRAFT" else _BOOK_COLUMNS)
            cur.execute(
                f"SELECT {columns} FROM stock_document_items"
                " WHERE stock_document_id = %s ORDER BY line_number",
                (count["stock_document_id"],),
            )
            lines = cur.fetchall()
    return Screen(locations=locations, location_id=location_id, count=count, lines=lines)


@router.put("/{count_id}/lines", status_code=204)
def save_lines(count_id: int, body: SaveLines, user: User = Depends(current_user)) -> None:
    """Record the counted quantity of many lines in one statement."""
    quantities = {line.stock_item_id: line.counted_quantity for line in body.lines}
    with transaction() as cur:
        # the lock keeps a save from landing in the middle of Finish count
        cur.execute(
            "SELECT status FROM stock_documents WHERE stock_document_id = %s"
            " AND stock_type = 'PHYSICAL_COUNT' AND source_module = 'PHARMACY'"
            " AND hospital_id = %s FOR UPDATE",
            (count_id, user.hospital_id),
        )
        count = cur.fetchone()
        if not count:
            raise HTTPException(404, "Count not found.")
        if count["status"] != "DRAFT":
            raise HTTPException(409, "This count is closed.")

        marks = ", ".join(["%s"] * len(quantities))
        cur.execute(
            f"SELECT COUNT(*) AS found FROM stock_document_items"
            f" WHERE stock_document_id = %s AND stock_item_id IN ({marks})",
            (count_id, *quantities),
        )
        if cur.fetchone()["found"] != len(quantities):
            raise HTTPException(404, "Count row not found. Reload the page and try again.")

        cases = " ".join(["WHEN %s THEN %s"] * len(quantities))
        pairs = [value for pair in quantities.items() for value in pair]
        cur.execute(
            f"UPDATE stock_document_items"
            f" SET counted_quantity = CASE stock_item_id {cases} END, line_status = 'CONFIRMED'"
            f" WHERE stock_document_id = %s AND stock_item_id IN ({marks})",
            (*pairs, count_id, *quantities),
        )
