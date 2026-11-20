# Kalika Enterprises ERP — Complete Project Documentation

> **Purpose of this document:** This is the single technical knowledge base for the Kalika ERP project.
> A new developer or AI coding agent should be able to understand the entire system from this file
> alone, without needing a walkthrough from another person. Every statement here was verified against
> the actual source code in this repository.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [Application Architecture](#4-application-architecture)
5. [Modules & Functionality](#5-modules--functionality)
6. [Business Logic & Workflows](#6-business-logic--workflows)
7. [Database](#7-database)
8. [API Reference](#8-api-reference)
9. [Setup & Execution](#9-setup--execution)
10. [Current Project Status](#10-current-project-status)

---

## 1. Project Overview

### 1.1 What this system is

**Kalika Enterprises ERP** is an internal, full-stack ERP system built for **Kalika Enterprises**, a
manufacturing + B2B trading company (Ahmednagar, India). The company's daily operations were
historically tracked in a single large Excel workbook (`Daily Report Aug-26.xlsx`). This ERP:

1. **Ingests** that Excel workbook (stored in Google Cloud Storage) into a proper relational database.
2. **Replaces** the workbook with live modules for sales orders, dispatch, production, purchase,
   inventory, raw materials, customers, suppliers, quotations, purchase requisitions (PRN), packaging
   lists, employees and reports.
3. **Adds business automation** the Excel file could not do: automatic stock deduction, shortage
   detection, reorder alerts, order status lifecycle, BOM explosion, PDF generation and e-mail.

### 1.2 Business use cases covered

| Area | What the business does in the ERP |
|---|---|
| Sales | Record OEM / Trading / Local customer orders, track fulfilment, send order-confirmation and dispatch e-mails, print order PDFs |
| Quotations | Issue branded quotations (two company identities: *Kalika Enterprises* and *Kalika Infotech*), revisions, PDF + e-mail |
| Dispatch | Record date-wise dispatch entries against orders, deduct stock, track per-customer completion |
| Production | Plan production, record daily output, auto-increase finished-goods stock, monthly production reports |
| Purchase | Create regular and import purchase orders, receive goods (stock in), bulk import POs |
| PRN | Departments raise Purchase Requisition Notes, managers approve, purchase team converts them to POs |
| Inventory | Multi-location stock (Main Store / Dispatch / Production), transfers between locations, customer dispatches, stock ledger |
| Raw materials | Monthly schedule vs inward tracking, min/max stock, reorder alerts |
| Planning | Material requirements from BOM explosion, production readiness, fulfilment decisions, purchase/production shortage engine |
| HR | Employee master with statutory details (PF, UAN, ESIC), sensitive-field masking, PDF/Excel export |
| Utilities | Packaging lists (box-wise weights), Standard Size master, Activity Log (audit viewer), Alert Centre |

### 1.3 Major design decisions (read this first)

- **The database internal `id` is the only unique key.** SO numbers (`sales_orders.order_no`) and PO
  numbers (`purchase_orders.po_number`) are *manual business references* and are deliberately **not
  unique** (the startup migration `_ensure_number_indexes` drops any legacy unique constraints).
- **Main Store is `plant_id = NULL`.** Internal locations "Dispatch" and "Production" are rows in the
  `plants` table seeded at startup. Customer ship-to locations (G-06, C-33, EATON, …) are also `plants`.
- **Inventory is dual-tracked:** every stock-changing operation updates the `inventory` counters
  (`opening_stock`, `received_qty`, `issued_qty`, `current_stock`) **and** writes a `stock_movements`
  ledger row, inside the same transaction, with the inventory row locked `FOR UPDATE`.
- **`current_stock = opening_stock + received_qty − issued_qty`** (maintained incrementally, not derived).
- **Every mutating API call writes an `audit_logs` row.** Audit rows are immutable (a SQLAlchemy
  `before_update` event raises on modification).
- **Excel migration never guesses.** v2 migration imports into an isolated SQLite staging database,
  validates against the workbook, and only then can be promoted to the live PostgreSQL database.
- **Monetary "less" values are stored but never subtracted** from line/order totals (confirmed
  business rule in `routers/orders.py::_recalc_total` and `routers/local_orders.py`).
- The backend serves the built React SPA itself in production — one container, one port.

---

## 2. Tech Stack

### 2.1 Backend (`backend/`)

| Layer | Technology | Pinned version |
|---|---|---|
| Language | Python | 3.11 |
| Web framework | FastAPI | 0.115.6 |
| ASGI server | uvicorn[standard] | 0.32.1 |
| ORM | SQLAlchemy | 2.0.37 |
| DB driver | psycopg2-binary | 2.9.10 |
| Validation | pydantic 2 + pydantic-settings | 2.10.4 / 2.7.0 |
| Auth | PyJWT (HS256) + passlib[bcrypt] | 2.10.1 / 1.7.4 (bcrypt 4.0.1) |
| Cloud | google-cloud-storage (ADC credentials) | 2.19.0 |
| Excel / data | pandas, openpyxl, xlsxwriter | 2.2.3 / 3.1.5 / 3.2.2 |
| PDF | reportlab, Pillow | 4.2.5 / 11.1.0 |
| E-mail | stdlib `smtplib` (Gmail SMTP, STARTTLS) | — |

Full pinned list: `backend/requirements.txt`.

### 2.2 Frontend (`frontend/`)

| Layer | Technology | Version |
|---|---|---|
| Framework | React | 19.2.x |
| Build tool | Vite | 8.x |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) | 4.x |
| Routing | react-router-dom | 7.x |
| HTTP | axios | 1.x |
| Charts | recharts | 3.x |
| Icons | lucide-react | 1.x |
| Image export | html2canvas | 1.4.x |
| Linter | oxlint | 1.x |

### 2.3 Database & infrastructure

| Component | Detail |
|---|---|
| Local DB | PostgreSQL 17, database `kalika_erp`, role `kalika_app` |
| Production DB | Cloud SQL for PostgreSQL (instance `…:asia-south1:kalika-erp-db`), reached via Cloud SQL Auth Proxy socket (`/cloudsql/…`) |
| Staging (migration v2) | SQLite file `backend/data/import_batches/staging_aug_2026.sqlite` |
| Object storage | Google Cloud Storage bucket (source Excel workbook + company stamp image) |
| Secrets | Google Secret Manager (`kalika-db-password`, `kalika-jwt-secret`, `kalika-mail-password`) |
| CI/CD | Google Cloud Build (`cloudbuild.yaml`) → Artifact Registry → Cloud Run |
| Container | Multi-stage `Dockerfile` (node:22 build → python:3.11-slim runtime), non-root user, port 8080 |

### 2.4 External services

- **Google Cloud Storage** — hosts the source workbook `Kalika_inventory/Daily Report Aug-26.xlsx`
  and the company stamp used on PDFs. Accessed with Application Default Credentials.
- **Gmail SMTP** — optional (`MAIL_ENABLED`) for order confirmations, dispatch e-mails and quotation
  e-mails with PDF attachments.

---

## 3. Project Structure

```
ERP-System/
├── .env                         # Local secrets (git-ignored) — DB URL, JWT secret, SMTP, GCS
├── Dockerfile                   # Multi-stage: build React → package FastAPI + dist
├── cloudbuild.yaml              # Cloud Build: docker build + push to Artifact Registry
├── deploy.sh                    # One-command deploy to Cloud Run (see §9.5)
├── deploy_guide.md              # Short manual deploy instructions
├── data/                        # Local copy of the source Excel workbook
├── reports/                     # Generated exports (CSV/XLSX) + v2 validation JSON
├── prn_attachments/             # Uploaded PRN line attachments (≤10 MB each)
├── dump*.sql, read_issue.py     # Ad-hoc DB dumps / debug scripts (not part of the app)
├── README.md                    # Original project readme (partly outdated — see §10.4)
├── WORKING_FLOW_DIAGRAM.md      # Mermaid flow diagrams (mostly accurate, router list outdated)
├── Requirements-HR-Payroll-and-Packaging-List.md   # Feature requirements doc
│
├── backend/
│   ├── requirements.txt
│   ├── dump_import.py           # Ad-hoc Excel inspection utility (debug only)
│   ├── app/
│   │   ├── main.py              # FastAPI app: router registration, startup migrations, SPA serving
│   │   ├── config.py            # Settings from .env (pydantic-settings); DB URL resolution
│   │   ├── database.py          # Engine, SessionLocal, get_db, health check; TZ = Asia/Kolkata
│   │   ├── models.py            # ALL SQLAlchemy models + enums (42 tables)
│   │   ├── schemas.py           # ALL Pydantic schemas (~1200 lines, grouped by domain)
│   │   ├── auth.py              # JWT issue/verify, role dependencies (CurrentUser, AdminUser, …)
│   │   ├── crud.py              # paginate, write_audit, apply_updates, get_or_404
│   │   ├── migrate_po_type.py   # One-off: add purchase_orders.po_type
│   │   ├── migrations_phase6.py # One-off: phase-6 additive columns
│   │   ├── assets/              # Bundled stamp.png, Standard_Size.xlsx (seed source)
│   │   ├── routers/             # 30 router files — one per API domain (§8)
│   │   └── services/            # Business engines, migration, PDF/e-mail builders (§6)
│   ├── scripts/
│   │   ├── init_db.py           # create_all + seed admin user
│   │   ├── migrate_data.py      # v1 legacy Excel → PostgreSQL importer
│   │   ├── migrate_v2.py        # v2 isolated importer (SQLite staging + validation)
│   │   ├── promote_v2.py        # Promote validated staging data into live PostgreSQL
│   │   └── migrate_orderstatus_enum.py  # One-off enum patch
│   ├── tests/                   # 4 plain-assert self-check suites (see §10.3)
│   ├── data/import_batches/     # v2 staging SQLite files
│   └── reports/                 # Backend-side report outputs
│
└── frontend/
    ├── package.json / vite.config.js    # Vite dev server: /api → http://127.0.0.1:8000
    ├── index.html
    ├── public/                  # favicon, logo, stamp asset
    └── src/
        ├── main.jsx / App.jsx   # Router: 27 pages, RequireAuth guard
        ├── index.css            # Tailwind v4
        ├── lib/
        │   ├── api.js           # axios instance (Bearer token, 401 handling, blob download)
        │   ├── session.js       # sessionStorage JWT, inactivity + absolute expiry
        │   └── format.jsx       # RoleBadge, StatusBadge, FlowBadge, CompletionBar, fmt helpers
        ├── context/AuthContext.jsx  # login/logout, idle tracking, session-expired event
        ├── components/          # Layout, Table, ui primitives, workflow modals
        └── pages/               # 27 page components (§5)
```

### Key files and their responsibilities

| File | Responsibility |
|---|---|
| `backend/app/main.py` | App factory; registers all routers; **startup sequence** (create_all, idempotent column/enum/index migrations, location seed, dispatch schedule backfill, shortage sync); SPA static serving + HTML-fallback middleware; cache-control headers |
| `backend/app/config.py` | `Settings` (pydantic-settings). `database_url` property: explicit `DATABASE_URL` → Cloud SQL socket → fail fast. Never ships credentials |
| `backend/app/models.py` | Single source of truth for the schema: all enums (`OrderStatus`, `PurchaseStatus`, `PRNStatus`, …) and all 42 tables |
| `backend/app/auth.py` | `create_access_token`, `decode_token`, `get_current_user`, `require_roles`, and the reusable dependency aliases `CurrentUser`, `AdminUser`, `ManagerOrAdmin`, `AllStaff` |
| `backend/app/services/business.py` | **Central engines:** inventory maps, BOM material requirements, fulfilment decisions, alert helpers, shortage sync (`sync_purchase_shortages`), order status recompute (`recompute_order_statuses`) |
| `backend/app/services/stock_service.py` | **Single implementation of all stock effects:** `apply_movement`, `reverse_and_remove_ref`, `reconvert_document`, `ensure_available_stock`, `resolve_or_create_product` |
| `frontend/src/lib/api.js` | axios client; attaches `Authorization: Bearer`; on 401 (except login) clears the session and fires `kalika:session-expired`; adds a cache-busting `_t` param to GETs; `downloadFile` helper for blob exports |
| `frontend/src/components/Layout.jsx` | Sidebar with 8 grouped sections, role-based Administration section, polls `/alerts/count` every 30 s |

---

## 4. Application Architecture

### 4.1 High-level architecture

```mermaid
flowchart TD
    subgraph EXTERNAL ["External"]
        GCS[("Google Cloud Storage\nDaily Report .xlsx + stamp.png")]
        SMTP["Gmail SMTP\n(optional e-mail)"]
    end

    subgraph FE ["React SPA — Vite dev :5173 / served by backend in prod"]
        PAGES["27 pages\n(pages/*.jsx)"]
        AXIOS["axios client\nlib/api.js + session.js"]
        AUTHCTX["AuthContext\n(idle + absolute expiry)"]
    end

    subgraph BE ["FastAPI backend — uvicorn :8000 (prod :8080)"]
        MAIN["main.py\nCORS · SPA middleware · startup migrations"]
        ROUTERS["30 routers\n(REST, /auth /orders /dispatch …)"]
        AUTH["auth.py\nJWT HS256 + RBAC"]
        SERVICES["services/\nbusiness · stock · migration · PDF · email"]
        MODELS["models.py\nSQLAlchemy ORM"]
    end

    subgraph DATA ["Data"]
        PG[("PostgreSQL 17\nkalika_erp\n(local or Cloud SQL)")]
        STG[("SQLite staging\nimport_batches/ (v2 migration)")]
        FILES["reports/ · prn_attachments/"]
    end

    GCS -->|download_excel| SERVICES
    PAGES --> AXIOS -->|Bearer JWT| MAIN --> ROUTERS
    ROUTERS --> AUTH
    ROUTERS --> SERVICES --> MODELS --> PG
    SERVICES --> STG
    ROUTERS --> FILES
    SERVICES --> SMTP
```

### 4.2 Request lifecycle (every API call)

```mermaid
sequenceDiagram
    participant U as Browser
    participant F as React (lib/api.js)
    participant M as FastAPI middleware
    participant J as auth.py (JWT + role)
    participant R as Router
    participant S as Service
    participant DB as PostgreSQL

    U->>F: action (click / submit)
    F->>M: GET/POST/PATCH/DELETE + Bearer token
    M->>M: CORS check, cache-control
    M->>J: get_current_user / require_roles
    J-->>M: 401 (no/expired token) or 403 (role)
    J->>R: CurrentUser (+role)
    R->>R: Pydantic schema validation (422 on error)
    R->>S: business logic
    S->>DB: SELECT … FOR UPDATE / INSERT / UPDATE
    S->>DB: stock_movements + inventory (same transaction)
    S->>DB: audit_logs (write_audit)
    S-->>R: result
    R-->>F: JSON
    F-->>U: UI update (401 → session-expired event → /login)
```

### 4.3 Authentication & session model

- Login: `POST /auth/login` → bcrypt verify → JWT (`HS256`, claims `sub`, `username`, `role`, `exp`, `iat`).
- **Absolute lifetime:** `JWT_EXPIRE_MINUTES` (default **480 min** = 8 h).
- **Inactivity timeout:** `SESSION_INACTIVITY_MINUTES` (default **30 min**), enforced *client-side* by
  `AuthContext.jsx`: genuine input events (throttled to 15 s) update `lastActivity`; a 30-second
  interval + focus/visibility listeners sign the user out when idle too long or the token is past
  `exp`. API 401 responses (except from `/auth/login`) trigger a single `kalika:session-expired`
  event → `session.clearSession()` → redirect to `/login` (no reload, no redirect loop).
- Token storage: **sessionStorage** (in-memory fallback), *not* localStorage.
- Logout is stateless: `POST /auth/logout` only writes an audit row.

### 4.4 RBAC

Roles (`UserRole` enum): `admin`, `manager`, `store`, `production`, `dispatch`, `viewer`.

Dependency aliases (`app/auth.py`):

| Alias | Allowed roles |
|---|---|
| `CurrentUser` | any authenticated user |
| `AdminUser` | `admin` |
| `ManagerOrAdmin` | `manager`, `admin` |
| `AllStaff` | `admin`, `manager`, `store`, `production`, `dispatch` (i.e. everyone except `viewer`) |

Effective permission matrix (enforced server-side per endpoint):

| Capability | admin | manager | store | production | dispatch | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| User management | ✅ | — | — | — | — | — |
| Master data write (customers, suppliers, products, plants, raw materials) | ✅ | ✅ | — | — | — | — |
| Employees (sensitive fields) | ✅ | masked | masked | masked | masked | masked |
| Orders / production / inventory / dispatch writes (`AllStaff`) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| PRN approve / reject / send-to-purchase | ✅ | ✅ | — | — | — | — |
| PRN create/edit own drafts | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Read all data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.5 Startup sequence (`main.py:on_startup`)

Every boot runs this idempotent, non-fatal chain (each step is wrapped in try/except so the container
starts even if the DB is briefly down; `/health` reports real status):

```mermaid
flowchart TD
    A[uvicorn starts] --> B[Base.metadata.create_all]
    B --> C["_ensure_columns()\n(~80 idempotent ALTER TABLE ADD COLUMN IF NOT EXISTS)"]
    C --> D["seed_standard_sizes()\n(one-time from bundled workbook)"]
    D --> E["_ensure_product_legacy_defaults()\n(defaults for legacy NOT NULL product columns)"]
    E --> F["_ensure_prn_po_indexes()\n(incl. PARTIAL unique index on idempotency_key)"]
    F --> G["_ensure_order_status_enum()\n(adds production_completed, partially_dispatched,\nready_for_dispatch, purchase_required)"]
    G --> H["_ensure_email_type_enum()\n(adds 'quotation')"]
    H --> I["_ensure_number_indexes()\n(drops UNIQUE on order_no/po_number → plain indexes)"]
    I --> J["_ensure_locations()\n(seed Dispatch + Production plants)"]
    J --> K["_backfill_dispatch_line_schedules()"]
    K --> L["_ensure_inventory_unique()\n(partial unique index for Main Store rows)"]
    L --> M["sync_purchase_shortages()\n(reconcile requirements + alerts)"]
    M --> N["GET /health reports ok/degraded"]
```

### 4.6 Production serving & SPA fallback

- The backend locates `frontend/dist` (several candidate paths), mounts `/assets`, and a catch-all
  `GET /{full_path}` serves `index.html`.
- Middleware `spa_html_navigation`: browser hard-refreshes on client routes (e.g. `/orders`) first
  reach the API router (same path prefix); on a **401/404** or an HTML-accept request that got JSON,
  the middleware serves `index.html` instead.
- Middleware `cache_control_headers`: `no-store` on everything except `/assets/*` — prevents a cached
  HTML fallback being served for a later JSON API call (this was a real production bug).

---

## 5. Modules & Functionality

Frontend routes (`src/App.jsx`) — all except `/login` require authentication and render inside
`Layout`. Navigation is grouped in the sidebar (`Layout.jsx`):

| Sidebar section | Pages (route) |
|---|---|
| Overview | Dashboard (`/`) |
| Sales | Orders (`/orders`), Quotations (`/quotations`) |
| Operations | Dispatch (`/dispatch`), Production (`/production`), Local Orders (`/local-orders`), Pending PO (`/pending-po`), Packaging List (`/packaging-lists`) |
| Inventory | Raw Materials (`/raw-materials`), Inventory (`/inventory`), Standard Size Master (`/standard-sizes`), Stock Movements (`/stock-movements`) |
| Procurement | Purchases (`/purchases`), PRN (`/prn`, `/prn/:id`), Requirements (`/requirements`), Material Req (`/material-requirements`), Fulfilment (`/fulfilment`) |
| Intelligence | BOM / Recipe (`/bom`), Alert Center (`/alerts`), Reports (`/reports`) |
| Master Data | Customers (`/customers`), Suppliers (`/suppliers`) |
| HR & Payroll Department | Employee Management (`/employees`) |
| Administration (admin/manager) | Activity Log (`/activity-log`); Users (`/users`, admin only) |

### 5.1 Dashboard (`/`)

- Calls `/dashboard/summary` + 7 chart endpoints + `/alerts/count` + `/material-requirements/rm-shortage` in one `Promise.all`.
- KPI cards (orders, pending, dispatch, production, RM stock, open alerts, shortages), recharts
  AreaCharts (30-day production & dispatch trends), PieCharts (order pipeline, inventory status),
  BarChart (dispatch by plant), progress bars (production by product), low-stock list.

### 5.2 Orders (`/orders`) — OEM & Trading sales orders

- Tabs All / Manufacture (OEM) / Trading; flattened one-row-per-line table; status/customer/search filters.
- Create/edit orders with multi-line items (live `qty × unit_price` totals), per-line edit modal.
- **Excel/CSV import wizard** with server-side preview (`/orders/import-preview`), duplicate
  detection and confirm flow.
- Per order: customer-wise detail modal, stock readiness per line (`FlowBadge`: READY FOR DISPATCH /
  PURCHASE REQUIRED / PRODUCTION REQUIRED / MANUAL DECISION REQUIRED / FULFILLED / OVER FULFILLED),
  linked dispatches, **order PDF** (`/reports/orders/{id}/pdf`), **confirmation & dispatch e-mails**
  with preview/history, Web Share.
- Deleting an order is refused (409) when dispatches, purchase requirements or production orders
  reference it.

### 5.3 Local Orders (`/local-orders`)

- Local (walk-in/regional) sales with their own numbering (`LOC-NNN`) and a **user-controlled status**
  (New → Confirmed → Production In Process → Production Completed → Ready for Dispatch → …; explicit
  manual statuses are never overwritten by the engine).
- Per-line stock position (Required / At Dispatch / Main Store), transfer-need calculation, one-click
  **Transfer to Dispatch** (StockTransferModal) or **Dispatch**, auto-creation of production plans for
  MANUFACTURING local orders in "Production In Process".
- Dispatch entries capped at both dispatch-location stock and remaining line balance.
- PDF (client-built HTML print), JPG (html2canvas), CSV reports (`report/active`, `report/orders`,
  `report/plans`), bulk import.

### 5.4 Dispatch (`/dispatch`)

Five tabs: **Dispatches** (records, date-wise entries, add/edit/delete), **Customer Dispatch**
(per-customer completion bars, item-wise history), **Dispatch Stock** (stock at the Dispatch
location), **Completed Production** ("Dispatch Now" prefills a dispatch capped at line balance),
**Local Orders** (dispatch plan with ready-only filter).
Over-dispatch is shown as a red `OVER` badge; every entry deducts stock at the dispatch's plant.

### 5.5 Production (`/production`)

Four tabs: **Production** (orders, record daily output, auto status, completion guard — cannot
complete with 0 produced), **Monthly Schedule** (production `Plan`s with duplicate-month detection),
**Actual Production** (daily output ledger), **Production Report** (monthly rollups from real
movements + CSV). CSV/Excel import with preview and force-on-duplicate. Deep link `?order={id}`
prefills schedule from a Local Order.

### 5.6 Purchases (`/purchases`)

- Stat cards (POs, Received, Partially Received, Open Value), infinite-scroll table.
- **PO Type switch:** *Regular* (supplier auto-created/enriched in master; lines with GST % and
  discount %; client-side `taxable = qty×rate − discount; total = taxable + GST`) vs *Import*
  (`ImportPOForm`: supplier details stay as a snapshot on the PO, USD lines, fixed terms, print layout).
- **Receive Items** per line, capped at remaining; receiving updates stock and PO status.
- Create supports `idempotency_key` (safe double-submit) and `prn_id` (PRN→PO conversion).
- PO print (regular + import layouts with company stamp from `/reports/stamp`), bulk CSV/Excel import.

### 5.7 PRN — Purchase Requisition Notes (`/prn`, `/prn/:id`)

- Department users draft PRNs with material lines; each line stores a **point-in-time stock snapshot**
  (available/incoming/suggested) for the chosen location; a manual "stock override" is stored on the
  line only (never touches inventory) and is shown distinctly on the PDF.
- Lines can reference a catalogue material or be **manual** ("New Material", stock = Unknown).
- Attachments per line (upload/download/delete, extension whitelist, ≤10 MB, saved under
  `prn_attachments/`).
- Workflow actions on the detail page: Edit (requester/admin), PDF/Print, Delete (blocked when a PO
  is linked). Approval actions are API-side (approve/reject/cancel/send-to-purchase).
- Register page shows priority stat cards (Critical/Urgent/Normal), filters, linked-PO table and an
  activity history timeline.

### 5.8 Inventory (`/inventory`)

Three tabs: **Stock** (per product+location rows, OK/Low/Out-of-Stock badges, add-stock, edit with
min-level, guarded delete), **Transfers** (Main Store ⇄ Dispatch/Production via `StockTransferModal`
with per-line availability), **Dispatch History** (customer dispatches `CD-YYYYMMDD-NNN`).
The page builds an `invIndex` map (`product:plant → stock`) shared with the transfer modal.

### 5.9 Stock Movements (`/stock-movements`)

Filterable ledger of every `stock_movements` row (type, product, location, date range) with signed
quantities, inward/outward/net stat cards, manual "Record Movement" and CSV export.

### 5.10 Raw Materials (`/raw-materials`)

- RM = `Product` with `category=raw_material`. Table shows schedule, inward, **balance = schedule −
  inward**, completion %, opening stock, MIN stock and a client-side status (Reorder / Low / Normal).
- Update Balance modal with live preview; Set Stock modal (the only sanctioned way to set physical RM
  stock — it posts a compensating movement); Excel import; delete auto-**deactivates** when the
  material is referenced by any of 14 modules.

### 5.11 Standard Size Master (`/standard-sizes`)

Sheet/roll size reference (size inches/mm, rolls, tare weights 6/10/12 mm, gross weight, item code,
paper core weight). Seeded once at startup from `app/assets/Standard_Size.xlsx`. Sortable/paged table,
import wizard with a downloadable validation report, duplicate → 409 → "confirm to update" upsert,
Excel export. Never creates products — only links to existing ones.

### 5.12 Customers / Suppliers

Standard master CRUD with search; customers carry `is_plant` flag; delete is refused (409) when
referenced (orders/dispatches for customers, POs for suppliers). Supplier detail includes a
**purchase history** modal (products + PO history). Both auto-created (case-insensitive, blank-field
enrichment only) when typed free-text into transactional forms.

### 5.13 Quotations (`/quotations`)

- Branded quotations under two allowed company identities — `KALIKA ENTERPRISES` / `KALIKA INFOTECH`
  (server-validated allow-list). Auto number `QTN-YYYYMMDD-NNN`.
- Lines: description, HSN, qty, UOM, price, lead time, tax % (display-only; totals are qty×price).
- Lifecycle: Draft → Sent → Accepted/Rejected/Expired (**lazy expiry**: a Sent quotation past
  `valid_until` flips to Expired on read). Editing a Sent/Accepted quotation creates a **new revision**
  (same number, `revision+1`, original preserved); explicit `/revise`, `/duplicate`, `/history`.
- Reusable **terms templates** with a default flag; payment-days helper rewrites the payment term line.
- Server PDF (`/reports/quotations/{id}/pdf`) with stamp; e-mail with PDF attachment; client-side
  printable preview.

### 5.14 Packaging List (`/packaging-lists`)

- Box-wise weight lists: per line `net = gross − less` (less defaults from header), totals summed,
  6-decimal internal rounding, 3-decimal display. Auto number `PKL-YYYYMMDD-NNN`.
- Bulk "Add Boxes" (≤500 at once), Enter-key row navigation, **unsaved-draft persistence** to
  localStorage (restored on revisit, cleared after save) — direct implementation of the requirements doc.
- Duplicate guard (same date + customer + description → warning unless `force=true`), duplicate
  action, Share/PDF/JPG export. Explicitly no effect on inventory/dispatch/orders.

### 5.15 Employees (`/employees`) — HR & Payroll Department

- Employee master: code, name, contact, department, designation, joining date, status; plus
  **Advanced Edit** statutory fields (PF/UAN, ESIC, bank, Aadhaar, PAN, verification, job-leave).
- **Sensitive-field security:** Aadhaar/PAN/bank/IFSC/UAN/PF-member/ESIC-IP are admin-only — masked
  (last 4) in lists, stripped from non-admin write payloads, excluded from exports unless an admin
  explicitly unmasks.
- Format validation (Aadhaar `^[2-9]\d{11}$`, PAN, IFSC, UAN 12 digits, ESIC IP 10–17, date-order
  rules). CSV/Excel import (≤5 MB, ≤1000 rows, skip/update duplicate actions), template download,
  export CSV/XLSX/PDF with column picker, per-employee portrait PDF.

### 5.16 BOM / Recipe (`/bom`)

Grouped BOMs: one `BOM` header (unique code) + multiple raw-material lines (product ≠ RM, no duplicate
RM per BOM, qty > 0). Typed product names auto-create products (finished for the header, raw_material
for lines). Soft-delete (deactivate). Legacy header-less lines are still displayed and editable.

### 5.17 Requirements / Material Requirements / Fulfilment (planning trio)

- **Requirements** (`/requirements`): per-order-line shortage vs Main-Store stock; category derived
  from product source type (PURCHASE / PRODUCTION / DECISION); inline status dropdown writes a
  `PurchaseRequirement` (Pending → In Progress → Ordered → Received → Completed → Resolved).
- **Material Requirements** (`/material-requirements`): BOM explosion of production plans + orders
  (`required = production qty × BOM qty/unit`), per-line READY/SHORTAGE/NO_BOM, aggregate RM shortage
  table, production-readiness per product. Read-only.
- **Fulfilment** (`/fulfilment`): per-order-line decision table (READY FOR DISPATCH / PRODUCTION
  REQUIRED / PURCHASE REQUIRED / MANUAL DECISION REQUIRED / FULFILLED / OVER FULFILLED) plus the two
  engine buttons: **Sync Requirements** and **Recompute Status**.

### 5.18 Alerts (`/alerts`)

Alert Centre: filterable list (type, priority, status), per-item mark-read, mark-all-read, stat cards.
The sidebar bell polls `/alerts/count` every 30 s. Alerts are created/resolved automatically by the
shortage engines (see §6.5).

### 5.19 Pending PO (`/pending-po`)

Read-only permanent **order fulfilment ledger** (`/orders/pending`): per order line ordered /
dispatched / balance with Pending / Partially Dispatched / Completed / Over-fulfilled status; tabs
All / Current Month / Previous (carried). (Despite the page title "Pending Purchase Orders", the data
source is sales-order lines.)

### 5.20 Reports (`/reports`)

Seven tabs: Customer Summary (client-side fulfilment rollup), Dispatch Summary, Delivery Report
(per-order-line delivery ledger with unallocated handling + CSV), Production (monthly, by-date /
by-product), Raw Material (BOM shortage), Pending/Over-fulfilled, Trading vs Manufacturing mix.
Plus `/reports/excel` — one combined workbook with 10 sheets.

### 5.21 Users & Activity Log (Administration)

- **Users** (admin): user CRUD, role select, optional password reset; cannot delete yourself.
- **Activity Log** (admin/manager): audit viewer — Daily Summary (per day/module/user rollup with
  drill-down) and Detailed History (field-level old→new changes, decoded from JSON), filters by date,
  module, user, action, kind; CSV/Excel export.

---

## 6. Business Logic & Workflows

All heavy rules live in `backend/app/services/` and are called from routers. This section is the
heart of the system.

### 6.1 Inventory engine (`services/stock_service.py`)

Single implementation used by purchases, dispatch, production, plans, transfers, customer dispatches,
raw materials and manual movements:

- `apply_movement(db, product_id, movement_type, qty, date, ref_type, ref_id, plant_id)`:
  - sign: `RECEIPT` and `PRODUCTION_OUTPUT` → `received_qty += qty`, `current_stock += qty`;
    everything else → `issued_qty += qty`, `current_stock −= qty`.
  - writes one `stock_movements` row tagged with `ref_type`/`ref_id` (e.g. `"purchase_order"`,
    `"dispatch"`, `"production_order"`, `"plan"`, `"stock_transfer"`).
- `get_or_create_inventory(product_id, plant_id)` — `SELECT … FOR UPDATE` row lock; creation race is
  resolved via a savepoint + unique-index retry (`uq_inventory_product_plant`,
  `uq_inventory_product_main` for the NULL/Main-Store case).
- `ensure_available_stock(...)` — locked guard for every stock-OUT; raises HTTP 400 with the
  available quantity when insufficient. Because the lock is held to commit, concurrent stock-outs are
  serialised.
- `reverse_and_remove_ref(ref_type, ref_id)` — applies the exact inverse adjustment per movement and
  deletes the movement rows (used when a document is edited/deleted).
- `reconvert_document(...)` — reverse-all then re-apply (used on edits).
- `resolve_or_create_product(item_code, description, allow_blank)` — lazy product creation keyed on
  `(item_code, model)`; blank-code lines get a fresh product with a unique model suffix (`" (#n)"`),
  **never merged by description**.

### 6.2 Purchase → Inventory flow

```mermaid
sequenceDiagram
    participant U as Manager
    participant API as /purchases
    participant DB as PostgreSQL

    U->>API: POST /purchases (lines, optional prn_id + idempotency_key)
    API->>DB: INSERT purchase_orders + purchase_order_lines
    Note over API,DB: idempotency_key replay → 200 + existing PO (no duplicate)
    U->>API: POST /purchases/{id}/receive?line_id=&received_qty=
    API->>DB: validate: cumulative, non-negative, ≤ ordered
    API->>DB: delta = new_received − old_received
    API->>DB: apply_movement(RECEIPT, delta, ref_type="purchase_order")
    API->>DB: if RM product → add_rm_inward (RawMaterialBalance only, no movement)
    API->>DB: recalc PO status (ordered/partially_received/received)
    API->>DB: refresh_reorder_alert + sync_prn_fulfilment + sync_purchase_shortages
    API->>DB: write_audit(RECEIVE)
```

PO line total: `basic = qty×rate; discount = round(basic×disc%/100,2); gst = round((basic−discount)×tax%/100,2); total = round(basic−discount+gst,2)`.

### 6.3 Production flow

- Create production order (auto `PO-YYYYMMDD-NNN`) → record daily output
  (`POST /production/{id}/movements`) → each movement adds finished-goods stock
  (`apply_movement(PRODUCTION_OUTPUT)`), updates `produced_qty`, `completion_pct =
  round(produced/schedule, 4)`, `balance = schedule − produced`; status auto-advances
  Planned → In Production → Completed (completion also settable manually, idempotent).
- Monthly **Plan** rows marked COMPLETED post their quantity as production output to Main Store
  (idempotent; reversing is blocked with 400 if it would drive any location negative).
- Completed production feeds the Dispatch module's "Completed Production" pool:
  `available = min(Σ production_output − Σ dispatch, stock at Dispatch plant)`.

### 6.4 Sales order status lifecycle (automatic)

`recompute_order_statuses` (`services/business.py`) derives status from real signals and **only ever
advances** an order (terminal statuses Completed/Cancelled are never regressed):

```mermaid
flowchart TD
    A[per non-cancelled order line] --> B["balance = ordered − dispatched"]
    B --> C{balance ≤ 0?}
    C -->|yes| D["line: completed"]
    C -->|no| E{"Main-Store stock ≥ balance?"}
    E -->|yes| F["line: ready"]
    E -->|no| G{product.source_type}
    G -->|MANUFACTURED| H["line: in_production"]
    G -->|TRADING| I["line: on_purchase"]
    G -->|MIXED/UNKNOWN| J["line: confirmed (manual decision)"]
    D & F & H & I & J --> K["order status = furthest-progressed line\n(ordinal: new 0 → confirmed/in_production 1 → ready 2 → dispatched 3 → completed 4)"]
    K --> L{fully dispatched?}
    L -->|"dispatched = ordered"| M[Dispatched]
    L -->|"dispatched > ordered"| N[Completed]
```

Local Orders have their own service (`services/local_orders.py`) with user-controlled statuses,
friendly labels (Ready for Dispatch / Stock Transfer Required / Production Required / Purchase /
Stock Required) and `sync_local_order_production_completion` (flips Manufacturing local orders
between Production In Process / Completed based on linked production plans).

### 6.5 Shortage & alert engines (`services/business.py`, `services/reorder_alerts.py`)

`sync_purchase_shortages` runs at startup **and after every stock/order/dispatch mutation**:

1. For every non-cancelled order line: `balance = ordered − dispatched`;
   `available` = Main-Store stock — except **LOCAL orders**, which use **all-location owned stock**
   (stock at the wrong location is a transfer problem, not a purchase problem).
2. `shortage = balance − available`; if `> 0` and the product is TRADING → upsert a
   `PurchaseRequirement(category=PURCHASE)` + one dedupe-safe OPEN alert `PURCHASE_REQUIRED`
   (target role `purchase`); MANUFACTURED → `PRODUCTION` + `PRODUCTION_MATERIAL_SHORTAGE`
   (target `production`); MIXED/UNKNOWN → surfaced for manual decision, no auto alert.
3. Stale OPEN product alerts whose shortage cleared are auto-RESOLVED; stale Pending requirements on
   LOCAL orders covered by repositioned stock are auto-closed as `Resolved`.
4. `/fulfilment/sync-requirements` additionally raises `RAW_MATERIAL_SHORTAGE` alerts from the BOM
   aggregate.

`refresh_reorder_alert(product_id)` runs after every RM stock change: if Main-Store
`current_stock < min_stock` (from the latest `RawMaterialBalance`), one OPEN `STOCK_SHORTAGE` alert
(priority HIGH, role `store`) exists; otherwise open alerts are resolved. Alert creation is dedupe-safe
(`ensure_alert` returns the existing OPEN alert for the same type+entity).

### 6.6 PRN workflow

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> PendingApproval: submit
    Rejected --> PendingApproval: resubmit
    PendingApproval --> Approved: approve (manager/admin; no self-approval unless admin)
    PendingApproval --> Rejected: reject (reason mandatory)
    Approved --> SentToPurchase: send-to-purchase
    SentToPurchase --> PartiallyFulfilled: linked PO receipts
    PartiallyFulfilled --> Completed: all lines fully received
    Draft --> Cancelled
    PendingApproval --> Cancelled
```

- PRN number: `PRN-NNNN` (max+1 over the `PRN-____` pattern; legacy monthly numbers ignored; ≤5
  retries on unique conflict).
- A PRN **never** creates POs, receipts or stock movements by itself. Conversion happens in the
  Purchases module: `POST /purchases` with `prn_id` + client `idempotency_key` (partial unique index;
  replay returns the first PO).
- `sync_prn_fulfilment` (called after PO create/receive/edit) recomputes PRN fulfilment from actual
  non-cancelled PO line receipts and transitions the status accordingly.
- Edit/delete of a PRN is blocked (409) once any PO is linked.

### 6.7 Dispatch rules

- Auto number `DP-YYYYMMDD-NNN`; default location = the "Dispatch" plant.
- Guards on every add/edit: per-product availability at the dispatch plant (locked, atomic) **and**
  order-line balance (`schedule − already dispatched`, +1e-9 tolerance) for linked lines.
- Header recompute: `dispatched_qty = Σ lines`; `schedule_qty = Σ line schedules` only when **every**
  line has one (legacy headers preserved otherwise); status Pending / Partially Dispatched /
  Completed. Line-level schedule derivation: explicit → linked order line (`schedule_qty ??
  quantity`) → order+product match sum → NULL.
- Deleting the last entry deletes the whole dispatch; deletes reverse stock via
  `reverse_and_remove_ref`.
- **Delivery attribution (reports):** a dispatch line with `sales_order_line_id` is exact; unlinked
  lines are pooled per (order, product) and attributed **only** if the order has exactly one line for
  that product — otherwise reported as `unallocated` (never guessed).

### 6.8 Other confirmed rules

- **Customer/Supplier auto-create:** typed names in transactional forms match case-insensitively and
  create masters on demand; existing masters are only enriched on blank fields (never clobbered).
  Suppliers match by GSTIN first.
- **Quotation totals:** `amount = round(qty × price, 2)`; discount/tax are stored but **not** included
  in totals (tax % is display-only).
- **Packaging lists:** pure documents — no stock, order or dispatch side effects.
- **Raw-material import:** inward is derived from `schedule × completion_pct` or
  `schedule − balance_qty` when absent; RM matching is RM-first (item_code → normalized model →
  squashed model → any product) and **resurrects soft-deleted** matches.
- **Employee statutory data:** admins only; list responses always masked.
- **Audit trail:** `write_audit` on every mutation with `changes` (old→new JSON) and
  created/updated/failed counters; `AuditLog` rows are immutable at ORM level.

---

## 7. Database

### 7.1 Overview

PostgreSQL 17, database `kalika_erp`. Session timezone is forced to `Asia/Kolkata` on connect.
**42 tables** defined in `backend/app/models.py` (SQLAlchemy 2.0 typed mappings). Schema management is
**additive and idempotent**: `create_all` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS` +
`ALTER TYPE … ADD VALUE` + partial unique indexes, all in `main.py` startup — there is no Alembic.

### 7.2 Tables by domain

| Domain | Tables |
|---|---|
| Identity & audit | `users`, `audit_logs`, `migration_logs`, `import_batches`, `reporting_periods`, `email_logs` |
| Masters | `customers`, `customer_aliases`, `suppliers`, `products`, `product_aliases`, `plants`, `salespersons`, `employees`, `standard_sizes`, `terms_templates` |
| Raw materials | `raw_material_balances` |
| Procurement | `purchase_orders`, `purchase_order_lines`, `purchase_requirements`, `prns`, `prn_lines` |
| Inventory | `inventory`, `stock_movements`, `stock_transfers`, `stock_transfer_lines`, `customer_dispatches`, `customer_dispatch_lines` |
| Manufacturing | `production_orders`, `production_movements`, `boms`, `bill_of_materials` |
| Sales | `sales_orders`, `sales_order_lines`, `quotations`, `quotation_lines` |
| Dispatch | `dispatches`, `dispatch_lines` |
| Planning | `plans`, `alerts` |
| Utilities | `packaging_lists`, `packaging_list_lines` |

### 7.3 Key entities and important fields

**`products`** — central item master. `item_code` + `model` (unique together), `category`
(`raw_material` / `finished` / `store` / `trading`), `source_type` (`MANUFACTURED` / `TRADING` /
`MIXED` / `UNKNOWN` — drives the shortage engine), `family`, `uom`, `is_active` (soft delete),
`import_batch_id` + `source_sheet`/`source_row` (migration traceability).

**`inventory`** — one row per (`product_id`, `plant_id`); `plant_id NULL` = Main Store. Counters
`opening_stock`, `received_qty`, `issued_qty`, `current_stock` (all `NOT NULL DEFAULT 0`), `min_level`.
Uniqueness: `uq_inventory_product_plant` + partial `uq_inventory_product_main` (NULL plant).

**`stock_movements`** — immutable ledger: `product_id`, `plant_id`, `movement_type` (`RECEIPT`,
`ISSUE`, `CONSUMPTION`, `PRODUCTION_OUTPUT`, `DISPATCH`, `ADJUSTMENT`, `OPENING`, `PURCHASE_RECEIPT`,
`RM_CONSUMPTION`, `TRANSFER`), `quantity`, `transaction_date`, `ref_type`+`ref_id` (owning document),
`source_sheet`/`source_row` (migration traceability).

**`sales_orders` / `sales_order_lines`** — `order_no` (business ref, **not unique**), `order_type`
(`OEM`/`TRADING`/`MANUFACTURING`/`LOCAL`), `local_order_type`, `customer_po_no`, `so_no`,
`salesperson_id`, `status` (rich `OrderStatus` enum incl. `production_completed`,
`partially_dispatched`, `ready_for_dispatch`, `purchase_required`), `total_value`. Lines carry
`quantity`, `schedule_qty`, `ask_till_date`, `completion_pct`, `balance_qty`, `opening_stock`,
`unit_price`, `less`, `amount`, `uom`.

**`dispatches` / `dispatch_lines`** — header `dispatch_no` (unique), `sales_order_id`, `plant_id`,
`schedule_qty`, `dispatched_qty`, `completion_pct`, `balance_qty`, `status` (`Pending` / `In Transit`
/ `Delivered` / `Partially Dispatched` / `Completed`). Lines: `product_id`, `sales_order_line_id`
(plain int, no FK), `quantity`, `schedule_qty` (derived), `dispatch_date`.

**`purchase_orders` / `purchase_order_lines`** — `po_number` (not unique), `supplier_id` (nullable —
import POs keep snapshot fields `supplier_name/address/email` instead), `po_type`
(`regular`/`import`), `prn_id` + `idempotency_key` (PRN link, partial unique index), `status`
(`Draft`/`Ordered`/`Partially Received`/`Received`/`Cancelled`), `total_amount`. Lines: `quantity`,
`received_qty`, `rate`, `uom`, `tax_percent`, `discount_percent`, `prn_line_id`.

**`production_orders` / `production_movements`** — `order_no` (unique), `product_id`, optional
`customer_id`/`sales_order_id`/`sales_order_line_id`, `schedule_qty`, `produced_qty`,
`completion_pct`, `balance_qty`, `status` (`Planned`/`In Production`/`Completed`/`Cancelled`),
`period_id`. Movements are dated daily output rows.

**`prns` / `prn_lines`** — `prn_number` (unique), `department`, `requested_by_*`, `priority`,
`requirement_type`, `status` (`Draft` → `Pending Approval` → `Approved`/`Rejected` →
`Sent to Purchase` → `Partially Fulfilled` → `Completed` / `Cancelled`), `fulfillment_status`,
approval stamps, sign-off fields. Lines: `entry_mode` (`EXISTING`/`MANUAL`), `material_id`,
`plant_id` (snapshot location), `quantity`, stock snapshot (`available_stock`, `incoming_qty`,
`suggested_qty`), `stock_override` (+ by/at), `is_new_material`, attachment fields.

**`quotations` / `quotation_lines`** — (`quotation_no`, `revision`) unique together,
`revised_from_id` self-link, `quotation_type`, `status`, denormalised customer + company blocks,
stored totals (`subtotal`, `discount_total`, `tax_total`, `total_amount`), `terms`, `payment_days`.

**`employees`** — identity + department/designation + sensitive statutory fields (Aadhaar, PAN, bank,
IFSC, PF/UAN, ESIC, verification), `status` (`Active`/`Inactive`).

**`boms` / `bill_of_materials`** — BOM header (unique `bom_code`, `product_id`, version) and lines
(`product_id` + `raw_material_product_id` + `version` unique, `quantity_per_unit`, `uom`, `is_active`).

**`purchase_requirements`** — engine output: `product_id`, order/line refs, `required_qty`,
`available_qty`, `shortage_qty`, `category` (`PRODUCTION`/`PURCHASE`/`DECISION`), `requirement_type`,
`status` (user-controlled lifecycle).

**`alerts`** — `type` (`PURCHASE_REQUIRED`, `RAW_MATERIAL_SHORTAGE`,
`PRODUCTION_MATERIAL_SHORTAGE`, `STOCK_SHORTAGE`, `PENDING_PO`, `OVER_FULFILLED`,
`VALIDATION_WARNING`), `priority` (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`), `entity_type`+`entity_id`,
`target_role`, `is_read`, `status` (`OPEN`/`RESOLVED`), `resolved_at`.

**Others:** `raw_material_balances` (per product + `report_date`: schedule/ask-till/inward/
completion/balance/opening/min/max), `stock_transfers` + lines (`TR-…`, from/to plant, optional
customer), `customer_dispatches` + lines (`CD-…`, stock-out to customer), `packaging_lists` + lines
(`PKL-…`, box weights), `plans` (`PRODUCTION_PLAN`/`DISPATCH_PLAN`), `standard_sizes`,
`terms_templates`, `customer_aliases` / `product_aliases` (migration linkage, never merged),
`reporting_periods` (unique year+month), `import_batches` (v2 batch status), `email_logs`,
`migration_logs`, `audit_logs` (immutable).

### 7.4 Relationship map

```mermaid
erDiagram
    USERS ||--o{ AUDIT_LOGS : writes
    CUSTOMERS ||--o{ SALES_ORDERS : places
    CUSTOMERS ||--o{ PLANTS : owns
    CUSTOMERS ||--o{ CUSTOMER_ALIASES : has
    SALES_ORDERS ||--|{ SALES_ORDER_LINES : has
    SALES_ORDERS ||--o{ DISPATCHES : fulfilled_by
    SALES_ORDERS ||--o{ PRODUCTION_ORDERS : schedules
    SALES_ORDERS ||--o{ PLANS : planned_in
    PRODUCTS ||--o{ SALES_ORDER_LINES : in
    PRODUCTS ||--o{ INVENTORY : stocked_as
    PLANTS ||--o{ INVENTORY : at
    PRODUCTS ||--o{ STOCK_MOVEMENTS : moves
    SUPPLIERS ||--o{ PURCHASE_ORDERS : supplies
    PURCHASE_ORDERS ||--|{ PURCHASE_ORDER_LINES : has
    PRNS ||--|{ PRN_LINES : has
    PRN_LINES |o--o{ PURCHASE_ORDER_LINES : fulfilled_by
    PRODUCTION_ORDERS ||--o{ PRODUCTION_MOVEMENTS : logs
    DISPATCHES ||--|{ DISPATCH_LINES : has
    BOMS ||--|{ BILL_OF_MATERIALS : contains
    PRODUCTS ||--o{ BILL_OF_MATERIALS : made_from
    PRODUCTS ||--o{ RAW_MATERIAL_BALANCES : tracked_as
    QUOTATIONS ||--|{ QUOTATION_LINES : has
    QUOTATIONS ||--o{ QUOTATIONS : revises
    PACKAGING_LISTS ||--|{ PACKAGING_LIST_LINES : has
    STOCK_TRANSFERS ||--|{ STOCK_TRANSFER_LINES : has
    CUSTOMER_DISPATCHES ||--|{ CUSTOMER_DISPATCH_LINES : has
    EMPLOYEES }o--|| USERS : managed_by
```

---

## 8. API Reference

Base URL: dev `http://localhost:5173/api/*` (Vite proxy strips `/api` → backend `:8000`); production
same origin, no prefix. Interactive Swagger docs at `/docs`. All endpoints except `/auth/login`,
`/health` and two noted diagnostics require `Authorization: Bearer <jwt>`.

### 8.1 Auth & meta

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | Login → `{access_token, user, expires_in, inactivity_seconds}` |
| POST | `/auth/logout` | any | Audit-only logout |
| GET | `/auth/me` | any | Current user |
| POST | `/auth/change-password` | any | Old password check, new ≥ 6 chars |
| GET | `/meta/statuses` | any | All enum value lists |
| GET | `/meta/filters` | any | Active customers/plants/products for dropdowns |
| GET | `/health` | public | App + DB connectivity status |

### 8.2 Masters

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET/POST/PATCH/DELETE | `/customers[/{id}]` | read: any, write: ManagerOrAdmin | Customer CRUD + per-row order stats; DELETE 409 when referenced |
| GET/POST/PATCH/DELETE | `/suppliers[/{id}]` | same | Supplier CRUD + purchase stats; DELETE 409 when POs exist |
| GET | `/suppliers/{id}/purchase-history` | any | Products + PO history for a supplier |
| GET/POST/PATCH/DELETE | `/products[/{id}]` | same | Product CRUD (`include_inactive` flag); DELETE 409 when stocked |
| GET/POST/PATCH/DELETE | `/plants[/{id}]` | same | Plant/location CRUD; DELETE 409 with reference list |
| GET/POST | `/salespersons` | read: any, write: ManagerOrAdmin | Salesperson list / create (name as query param) |
| GET/POST/PATCH/DELETE | `/users[/{id}]` | list: ManagerOrAdmin, write: admin | User management; cannot delete yourself |
| GET/POST/PATCH/DELETE | `/employees[/{id}]` | read: any (masked), write: ManagerOrAdmin | Employee CRUD; sensitive fields admin-only |
| POST | `/employees/import[/preview]` | ManagerOrAdmin | CSV/Excel import with duplicate action |
| GET | `/employees/export` | any | CSV / XLSX / PDF export (column picker, admin unmask) |
| GET | `/employees/{id}/pdf` | any | Single-employee portrait PDF |
| GET | `/employees/import/template` | any | CSV template |

### 8.3 Raw materials & inventory

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET/POST | `/raw-materials` | read: any, write: ManagerOrAdmin | RM list (with balance/stock/reorder flags) / create |
| GET/PATCH/DELETE | `/raw-materials/{product_id}` | same | Detail / update / delete (soft-delete when referenced) |
| POST | `/raw-materials/balances` | ManagerOrAdmin | Upsert monthly balance keyed on (product_id, report_date) |
| POST | `/raw-materials/{product_id}/stock` | ManagerOrAdmin | Set physical stock (compensating movement) |
| POST | `/raw-materials/import` | ManagerOrAdmin | Excel/CSV RM import |
| GET | `/inventory` · `/inventory/low-stock` | any | Stock rows (filters) / low+out list |
| PATCH/DELETE | `/inventory/{inv_id}` | PATCH: AllStaff, DELETE: ManagerOrAdmin | Edit (guarded) / delete (guarded) |
| POST | `/inventory/movements` | AllStaff | Manual stock movement (availability-guarded) |
| GET | `/inventory/movements` | any | Movement ledger (filters) |
| POST | `/inventory/add-stock` | AllStaff | Manual inward |
| GET | `/inventory/locations` | any | Main Store + Dispatch/Production |
| GET/POST/PATCH/DELETE | `/inventory/transfers[/{id}]` | write: AllStaff, delete: ManagerOrAdmin | Stock transfers (two movement legs) |
| GET/POST/PATCH/DELETE | `/inventory/dispatches[/{id}]` | same | Customer dispatches (stock-out) |
| GET | `/inventory/dispatches/history` | any | Flat date-wise dispatch ledger |

### 8.4 Purchase, PRN & planning

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET/POST | `/purchases` | read: any, write: ManagerOrAdmin | PO list (+stats) / create (idempotency_key, prn_id) |
| GET/PATCH/DELETE | `/purchases/{id}` | same | Detail / update (reverses + re-applies receipts) / delete (reverses stock) |
| POST | `/purchases/{id}/receive` | ManagerOrAdmin | Cumulative receipt per line |
| POST | `/purchases/import` | ManagerOrAdmin | Bulk PO import |
| GET | `/requirements` | any | Per-order-line shortage view |
| PATCH | `/requirements/{line_id}` | AllStaff | Set requirement status/category/notes |
| GET | `/material-requirements/summary` · `/rm-shortage` · `/production-readiness` | any | BOM explosion, RM shortage aggregate, per-product readiness |
| GET | `/fulfilment` | any | Per-line fulfilment decisions |
| POST | `/fulfilment/sync-requirements` · `/recompute-status` | AllStaff | Run the shortage / order-status engines |
| GET/POST/PATCH/DELETE | `/bom` (legacy single-line) · `/bom/groups[/{id}]` | groups create: any auth; delete = soft | BOM management + `/bom/validate` |
| GET/POST/PATCH/DELETE | `/plans[/{id}]` | read: any, write: AllStaff | Production/dispatch plans; COMPLETED production plans post stock |
| GET | `/alerts` · `/alerts/count` | open | Alert list / badge counts |
| PATCH | `/alerts/{id}` | open | Mark read / resolve |
| POST | `/alerts/mark-all-read` · `/alerts` · `/alerts/resolve-by-type` | open | Bulk ops / internal engine API |

PRN (prefix `/prn`): `GET /prn/constants` · `/departments` · `/locations` · `/materials` ·
`/stock-lookup` (any); `GET /prn` (list + purchasing status); `GET /prn/purchase-requests[/count]`
(ManagerOrAdmin); `GET /prn/{id}` · `GET /prn/{id}/pdf` (any); `POST /prn` · `PATCH /prn/{id}` ·
`DELETE /prn/{id}` (AllStaff, requester/admin rules); `POST /prn/{id}/submit|cancel` (AllStaff);
`POST /prn/{id}/approve|reject|send-to-purchase|fulfillment` (ManagerOrAdmin);
`POST/GET/DELETE /prn/{id}/lines/{lineId}/attachment`.

### 8.5 Sales, production & dispatch

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET/POST | `/orders` | read: any, write: AllStaff | Order list (filters) / create |
| GET | `/orders/pending?mode=all\|current\|previous` | any | Fulfilment ledger |
| GET/PATCH/DELETE | `/orders/{id}` | read: any, write: AllStaff, delete: ManagerOrAdmin | Detail / update / guarded delete |
| PATCH | `/orders/lines/{id}` | AllStaff | Edit one line |
| POST | `/orders/{id}/status?order_status=` | AllStaff | Manual status gate |
| POST | `/orders/import-preview` · `/orders/import` | preview: any, import: AllStaff | Excel/CSV import wizard |
| GET/POST | `/orders/{id}/email-preview/confirmation` · `/send-confirmation` · `/email-preview/dispatch/{did}` · `/send-dispatch-email/{did}` · `/email-history` | any | Order/dispatch e-mails |
| GET/POST/PATCH/DELETE | `/local-orders[/{id}]` | read: any, write: AllStaff, delete: ManagerOrAdmin | Local order module (manual statuses) |
| POST | `/local-orders/import` | ManagerOrAdmin | Bulk import |
| GET | `/local-orders/plans` · `/report/orders` · `/report/active` · `/report/plans` | any | Plans + CSV reports |
| GET/POST | `/production` | read: any, write: AllStaff | Production orders |
| GET/PATCH/DELETE | `/production/{id}` | read: any, write: AllStaff, delete: ManagerOrAdmin | Detail / update / delete (stock reversal) |
| PATCH | `/production/{id}/complete` | AllStaff | Idempotent manual complete |
| POST/PATCH | `/production/{id}/movements` · `/production/movements/{mid}` | AllStaff | Record / edit daily output |
| GET | `/production/actual` · `/plan-vs-actual` · `/report/orders/csv` · `/import/template` | any | Ledgers, comparison, CSV, template |
| POST | `/production/import` | AllStaff | Plan import (preview → confirm/force) |
| GET/POST | `/dispatch` | read: any, write: AllStaff | Dispatches |
| GET | `/dispatch/summary` · `/by-customer/{cid}` · `/customer-items/{cid}` · `/order-lines/{soId}` · `/completed-production` · `/local-order-dispatch` | any | Dispatch analytics & form data |
| GET/PATCH/DELETE | `/dispatch/{id}` | read: any, write: AllStaff, delete: ManagerOrAdmin | Detail / update / delete (stock reversal) |
| POST/PATCH/DELETE | `/dispatch/{id}/lines` · `/dispatch/lines/{lid}` | write: AllStaff, delete: ManagerOrAdmin | Date-wise dispatch entries |

### 8.6 Quotations, packaging, standard sizes

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET/POST | `/quotations` | any | List (lazy expiry) / create |
| GET/PUT/DELETE | `/quotations/{id}` | any | Detail / update (auto-revision when sent/accepted) / delete |
| POST | `/quotations/{id}/duplicate` · `/revise` · `/status` | any | Copy / explicit revision / status change |
| GET | `/quotations/{id}/history` · `/email-preview` · `/email-history` · `/check-number` | any | Revision chain / e-mail preview / e-mail log / number check |
| POST | `/quotations/{id}/send-email` | any | Send with optional PDF attachment |
| GET/POST/PUT/DELETE | `/quotations/terms-templates[/{id}]` | any | Reusable T&C templates |
| GET/POST | `/packaging-lists` | read: any, write: AllStaff | Lists / create (`force` on duplicate warning) |
| GET/PUT/DELETE | `/packaging-lists/{id}` | read: any, write: AllStaff, delete: ManagerOrAdmin | Detail / update / delete |
| POST | `/packaging-lists/{id}/duplicate` | AllStaff | Copy a list |
| GET/POST/PATCH | `/standard-sizes[/{id}]` | read: any, write: AllStaff | Size master (duplicate → 409 → confirm-update) |
| POST | `/standard-sizes/import[/preview]` | AllStaff | Import wizard |
| GET | `/standard-sizes/export` | any | Styled XLSX export |

### 8.7 Dashboard, reports & activity log

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard/summary` | All KPI counters for the dashboard |
| GET | `/dashboard/order-pipeline` · `/inventory-status` · `/raw-material-stock` · `/daily-trends` (30 days) · `/low-stock-list` · `/production-by-product` · `/dispatch-by-plant` | Chart datasets |
| GET | `/reports/excel` | Combined 10-sheet workbook (Inventory, Production, Dispatch, Raw Materials, Orders, Purchases, Customers, Suppliers, Plants, Products) |
| GET | `/reports/{inventory\|movements\|raw-materials\|production\|dispatch\|orders\|purchases\|customers\|suppliers\|products}/csv` | Per-module CSV exports |
| GET | `/reports/production/monthly[/csv]` | Monthly production from actual movements |
| GET | `/reports/delivery[/csv]` | Delivery ledger (exact/pooled attribution, `unallocated` list) |
| GET | `/reports/orders/{id}/pdf` · `/reports/quotations/{id}/pdf` | Branded PDFs |
| GET | `/reports/stamp` | Company stamp PNG (24 h cache) |
| GET | `/reports/debug/pdf-assets` | **Unauthenticated** Pillow/asset diagnostic |
| GET | `/activity-log` · `/summary` · `/options` · `/export` | Audit viewer (ManagerOrAdmin) |

---

## 9. Setup & Execution

### 9.1 Prerequisites

- Python **3.11+**, Node.js **20+** / npm, PostgreSQL **17** running locally (or a Cloud SQL instance).
- Google Cloud SDK credentials (Application Default Credentials) — only needed to re-download the
  source workbook or the stamp from GCS.
- No `.env` is committed; create it in the repo root (values from your local environment).

### 9.2 Environment configuration (`.env` in repo root)

Keys actually read by `app/config.py` (never commit real values):

```env
# --- required ---
DATABASE_URL=postgresql+psycopg2://kalika_app:YOUR_PASSWORD@localhost:5432/kalika_erp
JWT_SECRET=replace-with-a-long-random-string

# --- session policy (optional, defaults shown) ---
JWT_EXPIRE_MINUTES=480
ACCESS_TOKEN_NAME=kalika_access

# --- Cloud SQL alternative to DATABASE_URL (production) ---
# CLOUD_SQL_CONNECTION_NAME=project:region:instance
# CLOUD_SQL_DB_NAME=kalika_erp
# CLOUD_SQL_DB_USER=kalika_app
# CLOUD_SQL_DB_PASS=...

# --- GCS (optional; only for workbook/stamp download) ---
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\application_default_credentials.json
GCS_BUCKET=kalisoftai-datahub
GCS_EXCEL_FILE=Kalika_inventory/Daily Report Aug-26.xlsx

# --- reports ---
REPORT_DIR=reports

# --- e-mail (optional; disabled by default) ---
MAIL_ENABLED=False
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USE_TLS=True
MAIL_USERNAME=
MAIL_PASSWORD=
MAIL_FROM=kalikaenterprises@gmail.com
MAIL_FROM_NAME=Kalika Enterprises
```

`database_url` resolution order: explicit `DATABASE_URL` → Cloud SQL socket URL → **fail fast** with a
clear error (no baked-in credentials).

### 9.3 Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Create tables + seed admin user (admin / password)
python scripts\init_db.py

# Run the API (http://127.0.0.1:8000, docs at /docs, health at /health)
python -m uvicorn app.main:app --port 8000
```

> **Note:** `scripts/init_db.py` seeds `admin / password`. The older README mentions `admin /
> password` — **the script is the source of truth**.

### 9.4 Data migration (Excel → database)

**v1 (legacy, direct to live DB — kept for reference):**

```powershell
python scripts\migrate_data.py --file "..\data\Kalika_inventory__Daily Report Aug-26.xlsx"
# without --file it downloads from GCS
# --reset wipes ALL tables incl. users → re-run init_db.py afterwards
```

Sheet → table mapping (v1): `RAW  MATERIAL` → products+raw_material_balances+movements ·
`STORE` → products+plants+POs+inventory · `PRODUCTION` → production orders+movements+stock ·
`DISPATCH` → dispatches+lines+stock-out · `ORDER` → sales orders+lines.

**v2 (recommended, isolated):**

```powershell
python scripts\migrate_v2.py --fresh
# parse (excel_parser_v2) → import to SQLite staging (migration_v2)
# → validate (validation_v2) → reports/validation_batch_*.json
# exit 0 = READY_FOR_PROMOTION, exit 1 = NOT_READY, exit 2 = missing inputs

python scripts\promote_v2.py --dry-run     # counts only
python scripts\promote_v2.py               # pg_dump backup → clear 21 tables (users kept)
                                           # → copy staging → rebuild inventory → verify
```

v2 key behaviours: backward section association (subtotal rows *close* sections), row classifier
(grand-total / section-subtotal / data / label / empty via formulas), stale daily-date remapping into
the confirmed reporting period (Aug-2026), text-identifier normalisation (no `123.0` corruption),
customer aliases (JAKSON/JACKSON → JAKSON, G-6 variants → G-06, TCL-2-3), salespersons master,
product-family classification (11 manufactured families) → `source_type`. Validation performs row
counts, daily totals, per-customer totals, identifier integrity, sub-total leakage, duplicate
movement and orphan-line checks (tolerance 1e-6); hard errors block promotion.

### 9.5 Frontend

```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173  (use localhost, not 127.0.0.1 — IPv6 binding)
```

The dev server proxies `/api/*` → `http://127.0.0.1:8000` (prefix stripped).

**Production (single server):**

```powershell
cd frontend; npm run build     # outputs frontend/dist
cd ..\backend; python -m uvicorn app.main:app --port 8000
# open http://127.0.0.1:8000 — backend serves API + built SPA
```

### 9.6 Deployment (Google Cloud)

`./deploy.sh <PROJECT_ID> [REGION] [SERVICE] [REPO] [TAG]` (see `deploy_guide.md`):

1. Enables APIs, creates the Artifact Registry repo.
2. `gcloud builds submit` → multi-stage `Dockerfile` (node build → python runtime, non-root, port 8080).
3. Pulls secrets from Secret Manager (`kalika-db-password`, `kalika-jwt-secret`, optional `kalika-mail-password`).
4. `gcloud run deploy` — 1 GiB / 1 CPU, min 0 / max 3, Cloud SQL instance attached, env vars set,
   `--allow-unauthenticated` (the app itself enforces JWT on every route).
5. Grants the service account `roles/cloudsql.client` + `roles/storage.objectViewer`, routes 100 %
   traffic to the new revision.

### 9.7 Tests

Four self-check suites using in-memory SQLite (plain asserts, `if __name__ == "__main__"` runners —
no pytest configuration exists in the repo):

```powershell
cd backend
python tests\test_prn_override.py        # 15 checks — PRN stock override, numbering, delete rules
python tests\test_activity_log.py        # 4 checks — audit change capture, filters, immutability
python tests\test_employee_advanced.py   # 3 checks — statutory field validation
python tests\test_import_po_supplier.py  # 3 checks — import-PO supplier snapshot behaviour
```

---

## 10. Current Project Status

### 10.1 Implemented and working

- **Full module set live:** Dashboard, Orders (OEM/Trading), Local Orders, Quotations (with
  two-company identity + revisions + e-mail), Dispatch (5-tab workspace), Production (orders, plans,
  actuals, monthly report), Purchases (regular + import POs, receiving), PRN (full approval workflow,
  attachments, PDF, PO conversion), Inventory (multi-location, transfers, customer dispatches),
  Stock Movements, Raw Materials, Standard Sizes, BOM, Requirements, Material Requirements,
  Fulfilment, Alerts, Customers, Suppliers, Employees (HR), Packaging Lists, Pending PO ledger,
  Reports (10-sheet Excel + CSVs + PDFs + delivery report), Users, Activity Log.
- **Automation engines:** automatic order status, shortage → purchase/production requirement +
  alert engine, RM reorder alerts, PRN fulfilment sync, BOM explosion.
- **Platform:** JWT + RBAC, inactivity + absolute session expiry, immutable audit trail, idempotent
  startup migrations, SPA single-container serving, Cloud Run deployment pipeline.
- Recent development (branch `HR_Dev`, latest commits): Standard Size master, local-order & dispatch
  department changes, quotation/PRN/layout/purchase/packaging updates, auto supplier fetch + PO type,
  packaging "add box" flow, Import PO updates.

### 10.2 Partially implemented / not yet built

From `Requirements-HR-Payroll-and-Packaging-List.md`:

| Requirement | Status |
|---|---|
| HR – Employee Management | ✅ Implemented (incl. statutory fields, masking, import/export, PDF) |
| HR – Attendance Management | ❌ Not started (no models/routers) |
| HR – Salary / Payroll | ❌ Not started |
| HR – Reports & Dashboard | ❌ Not started |
| Packaging – numbered box rows / Enter-key navigation / draft persistence | ✅ Implemented (`MAX_BOXES_AT_ONCE=500`, refs-based Enter navigation, localStorage draft) |
| Packaging – PDF fits ≥40 rows per page | ⚠️ Packaging PDF is client-built HTML print; the compact-row optimisation is not verifiable in code |
| Quotation – Kalika Infotech template + company selection | ✅ Implemented (server-validated two-company allow-list) |

Other gaps:

- `frontend/src/components/PrnPurchaseRequests.jsx` (purchase-team queue UI) is **built but not
  imported anywhere** — orphaned.
- `PrnPurchaseRequests`-style purchase queue exists API-side (`/prn/purchase-requests`) but has no
  UI entry point (see above).
- `Plans` module has no dedicated page (managed inside the Production page's Monthly Schedule tab and
  Local Orders).
- Order/PO values are zero for migrated legacy data (the source Excel contains no prices).

### 10.3 Known technical issues & caveats

- **`README.md` / `WORKING_FLOW_DIAGRAM.md` are partly outdated** — they describe 18 tables, 16
  routers and 12 pages; the actual system has 42 tables, 30 router registrations and 27 pages. The
  default login is `admin / password` (script), not `admin / password` (README).
- **`/alerts` endpoints have no auth dependency** (any valid request shape works; treated as an
  internal engine API) and `/reports/debug/pdf-assets` is unauthenticated by design — both are
  effectively public when the service is exposed (`--allow-unauthenticated` on Cloud Run; the SPA
  still requires login for everything else).
- **`GET /raw-materials` accepts `page`/`page_size` but does not apply them** — the full filtered
  list is returned (fine at current data volumes).
- **passlib/bcrypt warning** (`module 'bcrypt' has no attribute '__about__'`) on startup — harmless
  version-notice, auth works.
- **Tests are not wired into CI** and there is no pytest config; they run as plain scripts.
- **Ad-hoc artifacts in the repo root** (`dump.sql`, `dump_final.sql`, `dump_noclean.sql`,
  `read_issue.py`) and `backend/migration/` (only orphaned `__pycache__`; sources deleted),
  `backend/dump_import.py` (debug utility) — not part of the application.
- **No Alembic** — schema evolution is the `_COLUMN_MIGRATIONS` list + `_ensure_*` functions in
  `main.py`; when adding columns, extend that list (and keep migrations additive/idempotent).
- **Vite dev server** binds IPv6 localhost — open `http://localhost:5173`, not `127.0.0.1:5173`.
- **SO/PO numbers are not unique** by design — never rely on them as keys; always use internal `id`.
- Data-quality notes inherited from the source Excel: production planned quantities are mostly 0
  (derived from actuals), some products intentionally have both a plant row and a Main-Store row is
  *not* allowed anymore (uniqueness enforced) but legacy data may predate enforcement (startup
  pre-checks and logs instead of auto-merging).

### 10.4 Conventions to follow when extending this project

1. Add stock effects **only** through `services/stock_service.py` (`apply_movement` /
   `reconvert_document` / `reverse_and_remove_ref` + `ensure_available_stock`).
2. After any stock/order/dispatch mutation call `sync_purchase_shortages(db)`; after RM stock changes
   also `refresh_reorder_alert`.
3. Write `write_audit(...)` on every mutating endpoint; never update `audit_logs` rows.
4. New schema → `models.py` + an idempotent entry in `_COLUMN_MIGRATIONS` / a `_ensure_*` startup
   function. No destructive migrations.
5. Role gates: use the existing aliases (`CurrentUser`, `AllStaff`, `ManagerOrAdmin`, `AdminUser`).
6. Frontend: call the API through `lib/api.js` only (it handles the token, 401s and cache-busting);
   use the shared `Table`/`ui.jsx` primitives and `SearchSelect` for master-data comboboxes.
7. Never make business document numbers (SO/PO/PRN/dispatch) unique keys; generate sequences the way
   existing modules do (`PREFIX-YYYYMMDD-NNN` or `PREFIX-NNNN`) with retry-on-conflict.

---

*Document generated from a full source-code analysis of the repository (branch `HR_Dev`). For flow
diagrams in more detail see also `WORKING_FLOW_DIAGRAM.md`; for the original quick-start see
`README.md` (noting the outdated parts listed in §10.3).*
