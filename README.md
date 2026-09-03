# Kalika Enterprises ERP

A full-stack ERP for **Kalika Enterprises** — a manufacturing + B2B trading business. It ingests the company's daily Excel report from Google Cloud Storage, migrates it into PostgreSQL, and provides a modern React dashboard for managing raw materials, purchases, inventory, production, sales orders, dispatch, plans, customers, suppliers, and reports.

![Stack](https://img.shields.io/badge/Backend-FastAPI%20%7C%20SQLAlchemy-009688)
![DB](https://img.shields.io/badge/DB-PostgreSQL-4169E1)
![Frontend](https://img.shields.io/badge/Frontend-React%20%7C%20Vite%20%7C%20Tailwind-61DAFB)
![Auth](https://img.shields.io/badge/Auth-JWT%20%7C%20RBAC-FF6F00)

---

## Table of Contents

- [Architecture](#architecture)
- [Flow Chart](#flow-chart)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Data Model](#data-model)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [1. Configure environment](#1-configure-environment)
  - [2. Initialize the database](#2-initialize-the-database)
  - [3. Migrate the source data](#3-migrate-the-source-data)
  - [4. Run the backend](#4-run-the-backend)
  - [5. Run the frontend](#5-run-the-frontend)
  - [6. Production build (single server)](#6-production-build-single-server)
- [Default Login](#default-login)
- [API Overview](#api-overview)
- [Roles & Permissions](#roles--permissions)
- [Reports](#reports)
- [Verification & Smoke Tests](#verification--smoke-tests)
- [Data Quality Notes](#data-quality-notes)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌──────────────────┐         ┌──────────────────────┐
│  Google Cloud    │         │   React SPA (Vite)   │
│  Storage (GCS)   │         │  AuthContext, axios  │
│  Daily report    │         │  recharts, Tailwind  │
│  .xlsx           │         └──────────┬───────────┘
└────────┬─────────┘                    │  /api (proxy in dev)
         │ ADC credentials              │  http://localhost:5173/api/*
         ▼                              ▼
┌──────────────────────┐    ┌───────────────────────┐
│ Migration script     │    │ FastAPI backend        │
│ scripts/migrate_data │───▶│ routers/ + services/   │
│ .py  (one-time/sync) │    │ JWT auth + RBAC        │
└──────────────────────┘    │ SQLAlchemy ORM         │
                            └──────────┬────────────┘
                                       │
                                       ▼
                            ┌───────────────────────┐
                            │ PostgreSQL (kalika_erp)│
                            │ 18 tables             │
                            └───────────────────────┘
```

**Data flow:** GCS Excel file → migration service (sheet-aware parsers) → PostgreSQL → FastAPI REST API → React UI. In production the backend also serves the built React bundle, so a single server (port 8000) runs the whole app.

---

## Flow Chart

### End-to-end business flow

```mermaid
flowchart TD
    subgraph INGEST ["1 · Data Ingestion"]
        A[Daily Report Aug-26.xlsx<br/>Google Cloud Storage] --> B[Migration Service<br/>services/migration.py]
        B --> C1[RAW  MATERIAL sheet] 
        B --> C2[STORE sheet]
        B --> C3[PRODUCTION sheet]
        B --> C4[DISPATCH sheet]
        B --> C5[ORDER sheet]
        C1 --> D[(PostgreSQL<br/>kalika_erp)]
        C2 --> D
        C3 --> D
        C4 --> D
        C5 --> D
    end

    subgraph API ["2 · FastAPI Backend"]
        D --> E[Auth Router<br/>JWT login / RBAC]
        E --> F[Module Routers]
        F --> F1[Raw Materials]
        F --> F2[Purchases<br/>PO + receive]
        F --> F3[Inventory<br/>stock movements]
        F --> F4[Production<br/>orders + output]
        F --> F5[Orders<br/>sales orders + status]
        F --> F6[Dispatch<br/>lines + stock deduction]
        F --> F7[Plans / Plants]
        F --> F8[Customers / Suppliers<br/>Products / Users]
    end

    subgraph UI ["3 · React Frontend"]
        G[Login] --> G1[Dashboard KPIs + charts]
        G1 --> G2[Module pages<br/>tables + CRUD modals]
        G2 --> G3[Reports<br/>CSV + Excel export]
    end

    F --> UI
    G3 --> H[Downloaded files<br/>reports/*.xlsx, *.csv]
```

### Order lifecycle

```mermaid
stateDiagram-v2
    [*] --> New
    New --> Confirmed
    Confirmed --> "In Production"
    "In Production" --> Ready
    Ready --> Dispatched
    Dispatched --> Completed
    New --> Cancelled
    Confirmed --> Cancelled
```

### Purchase → Inventory flow

```mermaid
sequenceDiagram
    participant U as Manager
    participant B as FastAPI
    participant DB as PostgreSQL
    U->>B: POST /purchases (create PO)
    B->>DB: insert purchase_order + lines
    U->>B: POST /purchases/{id}/receive (qty)
    B->>DB: update line.received_qty
    B->>DB: inventory.received_qty += delta
    B->>DB: inventory.current_stock += delta
    B->>DB: insert stock_movement (receipt)
    B->>DB: insert audit_log
    B-->>U: serialized PO (status recalced)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11, FastAPI 0.115, SQLAlchemy 2.0, Pydantic 2 |
| Database | PostgreSQL 17 (DB `kalika_erp`, role `kalika_app`) |
| Auth | JWT (PyJWT) + passlib/bcrypt, role-based access control |
| Cloud | Google Cloud Storage (ADC credentials) |
| Excel | openpyxl, pandas, xlsxwriter, reportlab |
| Frontend | React 19, Vite 8, Tailwind CSS 4, react-router-dom 7 |
| Frontend libs | axios, recharts, lucide-react |
| Lint | oxlint |

---

## Features

- **Excel → DB migration** with sheet-aware parsers (handles double-space sheet names, multi-row headers, section markers, stale daily columns).
- **JWT authentication** with **RBAC** (admin / manager / store / production / dispatch / viewer).
- **Full CRUD** for customers, suppliers, products, plants, users, plans.
- **Business flows**: purchase order receiving, production output, dispatch stock deduction, sales order status transitions.
- **Inventory engine**: every receipt/issue/dispatch/production creates a `stock_movement` and updates `received_qty` / `issued_qty` / `current_stock`.
- **Audit log** on every mutating action.
- **Dashboard** with KPIs and charts (order pipeline, production by product, dispatch by plant, daily trends, low-stock list).
- **Reports**: single combined Excel workbook plus per-module CSV exports.
- **SPA production mode**: backend serves the built React app.

---

## Data Model

18 tables:

| Domain | Tables |
|--------|--------|
| Identity | `users`, `audit_logs` |
| Masters | `customers`, `suppliers`, `products`, `plants` |
| Raw materials | `raw_material_balances` |
| Procurement | `purchase_orders`, `purchase_order_lines` |
| Inventory | `inventory`, `stock_movements` |
| Manufacturing | `production_orders`, `production_movements` |
| Sales | `sales_orders`, `sales_order_lines`, `dispatches`, `dispatch_lines` |
| Planning | `plans` |
| Migration | `migration_logs` |

### Key relationships

```mermaid
erDiagram
    CUSTOMERS ||--o{ SALES_ORDERS : places
    SALES_ORDERS ||--|{ SALES_ORDER_LINES : has
    PRODUCTS ||--o{ SALES_ORDER_LINES : in
    PURCHASE_ORDERS ||--|{ PURCHASE_ORDER_LINES : has
    PRODUCTS ||--o{ PURCHASE_ORDER_LINES : in
    PRODUCTS ||--o{ INVENTORY : stocked_as
    PLANTS ||--o{ INVENTORY : at
    PRODUCTS ||--o{ STOCK_MOVEMENTS : moves
    PRODUCTION_ORDERS ||--o{ PRODUCTION_MOVEMENTS : logs
    DISPATCHES ||--|{ DISPATCH_LINES : has
    PRODUCTS ||--o{ DISPATCH_LINES : in
    PRODUCTS ||--o{ RAW_MATERIAL_BALANCES : scheduled
```

---

## Project Structure

```
ERP-System/
├── .env                        # secrets (git-ignored)
├── .gitignore
├── data/
│   └── Kalika_inventory__Daily Report Aug-26.xlsx
├── backend/
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py             # FastAPI app + CORS + SPA serving
│   │   ├── config.py           # settings from .env
│   │   ├── database.py         # engine + session
│   │   ├── models.py           # SQLAlchemy models (18 tables)
│   │   ├── schemas.py          # Pydantic schemas
│   │   ├── auth.py             # JWT + role dependencies
│   │   ├── crud.py             # shared helpers (get_or_404, audit)
│   │   ├── routers/            # 16 routers (one per domain)
│   │   └── services/
│   │       ├── gcs.py          # download source file from GCS
│   │       └── migration.py    # sheet-aware Excel → DB loader
│   └── scripts/
│       ├── init_db.py          # create tables + seed admin
│       └── migrate_data.py     # run/refresh the migration
└── frontend/
    ├── package.json
    ├── vite.config.js          # /api proxy → 127.0.0.1:8000
    └── src/
        ├── main.jsx / App.jsx  # routes
        ├── index.css           # Tailwind v4
        ├── lib/api.js          # axios client + bearer token
        ├── context/AuthContext.jsx
        ├── components/         # Layout, Table, ui.jsx
        └── pages/              # Login, Dashboard, 12 module pages
```

---

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 20+ / npm
- PostgreSQL 17 (running locally)
- Google Cloud SDK credentials (only needed to re-download the source file from GCS)

### 1. Configure environment

Copy `.env` keys (create from the template below — values are in your local `.env`):

```env
DATABASE_URL=postgresql+psycopg2://kalika_app:YOUR_PASSWORD@localhost:5432/kalika_erp
JWT_SECRET=replace-with-a-long-random-string
JWT_EXPIRES_MINUTES=1440
# Optional (only for GCS re-download):
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\application_default_credentials.json
GCS_BUCKET=kalisoftai-datahub
GCS_OBJECT=Kalika_inventory/Daily Report Aug-26.xlsx
```

### 2. Initialize the database

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python scripts\init_db.py
```

Creates all tables and seeds the admin user (`admin / password`).

### 3. Migrate the source data

```powershell
# Legacy importer (v1, kept for reference)
python scripts\migrate_data.py --file ..\data\Kalika_inventory__Daily Report Aug-26.xlsx
```

**Phase 3 adds a corrected, isolated importer (v2):**

```powershell
python scripts\migrate_v2.py --fresh
# imports into backend/data/import_batches/staging_aug_2026.sqlite (LIVE DB UNTOUCHED)
# validates Excel vs ERP and writes reports/validation_batch_*.json
# exit 0 -> READY_FOR_PROMOTION, exit 1 -> NOT_READY
```

`scripts/migrate_v2.py` uses `app/services/excel_parser_v2.py` (backward
section association, row classifier, daily-date detection, text identifiers),
`app/services/migration_v2.py` (normalized import with aliases, salespersons,
reporting period, business rules) and `app/services/validation_v2.py`
(reconciliation: row counts, daily totals, customer totals, identifier
integrity, sub-total leakage, duplicates, orphans).

> **Note:** `--reset` wipes the `users` table too, so always re-run `scripts\init_db.py` after a reset.

### 4. Run the backend

```powershell
python -m uvicorn app.main:app --port 8000
```

- API docs: http://127.0.0.1:8000/docs
- Health check: http://127.0.0.1:8000/health

### 5. Run the frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (use `localhost`, not `127.0.0.1` — the Vite dev server binds to IPv6 localhost). The dev server proxies `/api/*` to the backend on port 8000.

### 6. Production build (single server)

```powershell
cd frontend
npm run build        # outputs to frontend/dist
```

Then run **only the backend** and open http://127.0.0.1:8000 — it serves both the API and the built SPA.

---

## Default Login

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |

Create additional users with different roles via the **Users** page (admin only).

---

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login, returns JWT |
| POST | `/auth/change-password` | Change own password |
| GET | `/dashboard/summary` | Top KPIs |
| GET | `/dashboard/*` | Charts & pipeline data |
| GET/POST/PATCH/DELETE | `/customers` `/suppliers` `/products` `/plants` `/users` | Master CRUD |
| GET/POST | `/raw-materials`, `/raw-materials/balances` | Raw material list + balance upsert |
| GET/POST | `/purchases`, `/purchases/{id}/receive` | Purchase orders + receiving |
| GET/POST | `/inventory`, `/inventory/movements` | Stock + manual movements |
| GET/POST | `/production`, `/production/{id}/movements` | Production orders + output |
| GET/POST | `/orders`, `/orders/{id}/status` | Sales orders + status transitions |
| GET/POST | `/dispatch`, `/dispatch/{id}/lines` | Dispatches + stock deduction |
| GET | `/reports/excel`, `/reports/{name}/csv` | Report exports |
| GET | `/meta/statuses` | Enum/status reference lists |

Full interactive docs at **/docs** (Swagger UI).

---

## Roles & Permissions

| Action | admin | manager | store | production | dispatch | viewer |
|--------|:-----:|:-------:|:-----:|:----------:|:--------:|:------:|
| Users / master data write | ✅ | ✅ | — | — | — | — |
| Purchase receive / production output | ✅ | ✅ | ✅ | ✅ | — | — |
| Dispatch lines | ✅ | ✅ | — | — | ✅ | — |
| Read all data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Reports

- **Complete Excel workbook** (`/reports/excel`) — all modules in one `.xlsx`.
- **Per-module CSV** exports: inventory, stock movements, raw materials, production, dispatch, orders, purchases, customers, suppliers, products.
- CSV exports are linked directly from each module page header.

---

## Verification & Smoke Tests

A lightweight verification suite covers the four core flows:

| Flow | Endpoint | Status |
|------|----------|--------|
| Login | `POST /auth/login` | ✅ |
| Dashboard | `GET /dashboard/summary` + 6 chart endpoints | ✅ |
| CRUD | `POST/PATCH/DELETE /customers` | ✅ |
| Reports | `GET /reports/excel` + 10 CSVs | ✅ |

Write-flow checks (order create/status/delete, purchase receive, dispatch line, production movement, raw-material balance upsert) all pass.

---

## Data Quality Notes

Known characteristics of the source data (mirrored as-is from the Excel):

- `production_pending_qty` and `production_planned_qty` can look odd — the PRODUCTION sheet schedules are mostly `0`, so produced vs. planned is derived from actuals.
- `order_value` / `purchase_value` are `0` — the source contains no prices.
- Some products may have two inventory rows (one with a plant, one global). This is a deliberate source-data quirk; the global row is used for on-the-fly balance updates.
- The migration ignores totals/subtotal rows (`G.TOTAL`, `SUB-TOTAL`) and skips empty rows.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Vite dev server unreachable on `127.0.0.1:5173` | Use `http://localhost:5173` (IPv6 binding) |
| `module 'bcrypt' has no attribute '__about__'` | Harmless passlib/bcrypt version warning; auth works |
| 401 on API calls | Token expired (default 24h) — re-login |
| `--reset` migration leaves no admin | Re-run `python scripts\init_db.py` |
| 500 `NoneType += float` in inventory updates | Fixed — inventory counters now init to `0` and DB columns are `NOT NULL DEFAULT 0` |
| `/` shows Swagger UI instead of app | Run `npm run build` first, then restart backend |

---

## License

Internal project for Kalika Enterprises.
