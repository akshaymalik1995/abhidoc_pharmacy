import logging

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from . import masters, medicines, physical_stock, purchase_documents, sales, stock_documents, stock_ledger, stock_overall, stock_query
from pydantic import BaseModel

from .auth import User, current_user
from .common import Choice
from .db import transaction

app = FastAPI(title="Pharmacy")
app.include_router(physical_stock.router)
app.include_router(medicines.router)
app.include_router(masters.router)
app.include_router(stock_overall.router)
app.include_router(stock_query.router)
app.include_router(stock_ledger.router)
app.include_router(purchase_documents.router)
app.include_router(stock_documents.router)
app.include_router(sales.router)


class Me(BaseModel):
    name: str
    hospital: str
    locations: list[Choice]  # the stock locations a document can be made at


@app.get("/api/me")
def me(user: User = Depends(current_user)) -> Me:
    """Who is logged in and where they can work, for the top bar."""
    table, key = ("Admin", "Admin_ID") if user.is_admin else ("Doctor", "Doctor_ID")
    with transaction() as cur:
        cur.execute(
            f"SELECT TRIM(CONCAT(First_Name, ' ', COALESCE(Last_Name, ''))) AS name FROM {table} WHERE {key} = %s",
            (user.actor_id,),
        )
        person = cur.fetchone()
        cur.execute("SELECT hospital_name AS name FROM hospitals WHERE hospital_id = %s", (user.hospital_id,))
        hospital = cur.fetchone()
        cur.execute(
            "SELECT CAST(location_id AS CHAR) AS value, location_name AS label FROM stock_locations"
            " WHERE hospital_id = %s AND is_active = 1 AND is_stock_location = 1"
            " ORDER BY location_type <> 'PHARMACY', location_name",
            (user.hospital_id,),
        )
        locations = cur.fetchall()
    return Me(name=(person or {}).get("name") or "", hospital=(hospital or {}).get("name") or "", locations=locations)


@app.exception_handler(Exception)
def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    # Database and other unexpected failures: keep the evidence, tell the user nothing internal.
    logging.getLogger("pharmacy").exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "Something went wrong. Try again."}, status_code=500)
