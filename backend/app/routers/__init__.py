"""API routers package."""
from . import (
    auth, users, meta, customers, suppliers, products, plants, raw_materials,
    purchases, inventory, production, orders, dispatch, plans, dashboard, reports,
)

__all__ = [
    "auth", "users", "meta", "customers", "suppliers", "products", "plants",
    "raw_materials", "purchases", "inventory", "production", "orders", "dispatch",
    "plans", "dashboard", "reports",
]