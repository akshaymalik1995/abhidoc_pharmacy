# Pharmacy

Rewrite of the DocAssist pharmacy screens. FastAPI backend, React + TypeScript + Mantine frontend,
same database tables, same DocAssist login (it reads DocAssist's login cookie).

## Run

DocAssist must be running on port 5002: you log in there, and starting, finishing and
cancelling a count still go through it.

    cd backend
    copy settings.example.ini settings.ini    (first time; fill in session_secret)
    .venv\Scripts\python -m uvicorn app.main:app --port 8000 --reload

    cd frontend
    npm run dev

Log in at http://localhost:5002/doctor/login, then open http://localhost:5173.

## Checks

    cd backend && .venv\Scripts\python -m pytest -q     (test database, changes nothing)
    cd frontend && npm run build                        (type check + build)
    cd frontend && npm run types                        (regenerate src/api-types.ts; backend must be running)

## Adding a screen

Backend: one file in `backend/app/` with a router, registered in `main.py`. One GET returns
everything the screen shows; a save sends all changed rows in one request.
Frontend: one file in `frontend/src/`, built only from Mantine components. Colours, radius
and fonts are set once in the theme in `main.tsx`, never per screen.

## What is built

Every screen of the DocAssist pharmacy menu (54 with the Dashboard, Medicines and Masters): Dashboard, Medicines,
Masters, all of Purchase, Stock (registers, reports, every stock form, Unsold / Ageing / Expiring Stocks), Sales (New
Sale, Sales History, Bill, Sales Register, Estimates, Sale Returns, Deliveries), Accounts (13 screens) and Reports
(Reports, Summary, Audit Log).

Native in the new backend (FastAPI, `backend/app`): Medicines, Masters, the stock registers and reports, the purchase
lists and document views, Sales History, the bill view, the Sales Register / Estimates list, and the New Sale product
search, batches and counter details.
Still read or saved through DocAssist (`/pharmacy/api/...` and `/accounts/api/...` via the dev proxy): everything that
changes stock or money, every Accounts screen, the report catalogue and reports, the Summary, the Audit Log, the
Dashboard figures, deliveries, prescriptions and the patient statement.

## Clerk checks

`cd checks && node patients.mjs` walks every Accounts > Patients workflow on its own AKTEST data (test database) and saves a screenshot per step in `checks/screens/`. Steps: `checks/patients.md`. Needs :5002, :8000 and :5173 running.
