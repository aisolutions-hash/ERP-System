"""Customer helpers for the central customer master.

Any module that accepts a free-text customer name (transfer, customer
dispatch, sales order, dispatch department) promotes it to the Customer
table so the record is usable across the whole ERP. Auto-creation is
case-insensitive name dedupe safe.
"""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Customer


def get_or_create_customer(db: Session, name: str) -> Customer | None:
    """Return the customer for a typed name, creating it in the master if new.

    Matches an existing active customer by case-insensitive name. Returns None
    when no name is given.
    """
    name = (name or "").strip()
    if not name:
        return None
    c = db.scalar(
        select(Customer).where(func.lower(Customer.name) == name.lower()).limit(1)
    )
    if c is None:
        c = Customer(name=name)
        db.add(c)
        db.flush()
    return c