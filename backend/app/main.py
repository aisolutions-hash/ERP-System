"""Kalika Enterprises ERP - FastAPI application entrypoint."""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .database import Base, engine
from . import models  # noqa: F401  (register models)
from .routers import (
    auth, users, meta, customers, suppliers, products, plants, raw_materials,
    purchases, inventory, production, orders, dispatch, plans, dashboard, reports,
    requirements, salespersons, local_orders, bom, alerts,
    material_requirements, fulfilment,
)

app = FastAPI(
    title="Kalika Enterprises ERP",
    description="Manufacturing + B2B trading ERP for Kalika Enterprises.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)


@app.get("/", include_in_schema=False)
def root():
    if _FRONTEND_DIST.exists():
        return _serve_frontend("")
    return RedirectResponse(url="/docs")


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "app": "kalika-erp"}


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(meta.router)
app.include_router(customers.router)
app.include_router(suppliers.router)
app.include_router(products.router)
app.include_router(plants.router)
app.include_router(raw_materials.router)
app.include_router(purchases.router)
app.include_router(inventory.router)
app.include_router(production.router)
app.include_router(orders.router)
app.include_router(dispatch.router)
app.include_router(plans.router)
app.include_router(dashboard.router)
app.include_router(reports.router)
app.include_router(requirements.router)
app.include_router(salespersons.router)
app.include_router(local_orders.router)
app.include_router(bom.router)
app.include_router(alerts.router)
app.include_router(material_requirements.router)
app.include_router(fulfilment.router)


# Serve the built React app in production mode (frontend/dist).
_FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


def _serve_frontend(path: str):
    index = _FRONTEND_DIST / "index.html"
    if not index.exists():
        return RedirectResponse(url="/docs")
    target = _FRONTEND_DIST / path
    if target.is_file():
        return FileResponse(target)
    return FileResponse(index)


if _FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=_FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        return _serve_frontend(full_path)