"""SQLAlchemy models for the Kalika Enterprises ERP.

Schema designed from the actual Excel source (Kalika_inventory/Daily Report Aug-26.xlsx):
Supplier -> Purchase -> RawMaterial -> Store -> Production -> Finished Product -> Order -> Dispatch -> Completed.
"""
from __future__ import annotations

import enum
from datetime import date, datetime

from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, Enum, Float, ForeignKey, Index,
    Integer, Numeric, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    manager = "manager"
    store = "store"
    production = "production"
    dispatch = "dispatch"
    viewer = "viewer"


class ProductCategory(str, enum.Enum):
    raw_material = "raw_material"
    finished = "finished"
    store = "store"
    trading = "trading"


class OrderStatus(str, enum.Enum):
    new = "New"
    confirmed = "Confirmed"
    in_production = "In Production"
    ready = "Ready"
    dispatched = "Dispatched"
    completed = "Completed"
    cancelled = "Cancelled"


class ProductionStatus(str, enum.Enum):
    planned = "Planned"
    in_production = "In Production"
    completed = "Completed"
    cancelled = "Cancelled"


class DispatchStatus(str, enum.Enum):
    pending = "Pending"
    in_transit = "In Transit"
    delivered = "Delivered"
    partial = "Partially Dispatched"
    completed = "Completed"


class PurchaseStatus(str, enum.Enum):
    draft = "Draft"
    ordered = "Ordered"
    partially_received = "Partially Received"
    received = "Received"
    cancelled = "Cancelled"


class MovementType(str, enum.Enum):
    receipt = "RECEIPT"
    issue = "ISSUE"
    consumption = "CONSUMPTION"
    production_output = "PRODUCTION_OUTPUT"
    dispatch = "DISPATCH"
    adjustment = "ADJUSTMENT"


class PlanType(str, enum.Enum):
    production = "PRODUCTION_PLAN"
    dispatch = "DISPATCH_PLAN"


# ---------------------------------------------------------------------------
# Master data
# ---------------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(160), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.viewer, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    code: Mapped[str] = mapped_column(String(60), default="", index=True)
    company: Mapped[str] = mapped_column(String(255), default="")
    contact_person: Mapped[str] = mapped_column(String(160), default="")
    phone: Mapped[str] = mapped_column(String(60), default="")
    email: Mapped[str] = mapped_column(String(160), default="")
    address: Mapped[str] = mapped_column(Text, default="")
    gstin: Mapped[str] = mapped_column(String(40), default="")
    is_plant: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    code: Mapped[str] = mapped_column(String(60), default="", index=True)
    company: Mapped[str] = mapped_column(String(255), default="")
    contact_person: Mapped[str] = mapped_column(String(160), default="")
    phone: Mapped[str] = mapped_column(String(60), default="")
    email: Mapped[str] = mapped_column(String(160), default="")
    address: Mapped[str] = mapped_column(Text, default="")
    gstin: Mapped[str] = mapped_column(String(40), default="")
    materials: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("item_code", "model", name="uq_product_code_model"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    item_code: Mapped[str] = mapped_column(String(80), default="", index=True)
    model: Mapped[str] = mapped_column(String(500), index=True)
    name: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[ProductCategory] = mapped_column(
        Enum(ProductCategory), default=ProductCategory.store, index=True
    )
    uom: Mapped[str] = mapped_column(String(30), default="Each")
    min_stock_level: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    stock: Mapped[list[Inventory]] = relationship(back_populates="product", cascade="all, delete-orphan")


class Plant(Base):
    """Ship-to location / customer plant (G-6, C-33, CPG, EATON, ...)."""

    __tablename__ = "plants"
    __table_args__ = (UniqueConstraint("name", name="uq_plant_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    code: Mapped[str] = mapped_column(String(60), default="", index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), nullable=True)
    description: Mapped[str] = mapped_column(Text, default="")
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    customer: Mapped[Customer | None] = relationship()


# ---------------------------------------------------------------------------
# Raw material & purchase
# ---------------------------------------------------------------------------
class RawMaterialBalance(Base):
    """Raw-material monthly position from the RAW MATERIAL sheet."""

    __tablename__ = "raw_material_balances"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    report_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    schedule_qty: Mapped[float | None] = mapped_column(Float, nullable=True)
    ask_till_date: Mapped[float | None] = mapped_column(Float, nullable=True)
    inward_qty: Mapped[float | None] = mapped_column(Float, nullable=True)
    completion_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    balance_qty: Mapped[float | None] = mapped_column(Float, nullable=True)
    opening_stock: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")

    product: Mapped[Product] = relationship()


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    po_number: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"), nullable=True, index=True)
    order_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    status: Mapped[PurchaseStatus] = mapped_column(
        Enum(PurchaseStatus), default=PurchaseStatus.ordered, index=True
    )
    total_amount: Mapped[float] = mapped_column(Numeric(14, 2), default=0)
    notes: Mapped[str] = mapped_column(Text, default="")
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    lines: Mapped[list[PurchaseOrderLine]] = relationship(back_populates="po", cascade="all, delete-orphan")
    supplier: Mapped[Supplier | None] = relationship()


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    po_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    quantity: Mapped[float] = mapped_column(Float, default=0)
    received_qty: Mapped[float] = mapped_column(Float, default=0)
    rate: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    amount: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)

    po: Mapped[PurchaseOrder] = relationship(back_populates="lines")
    product: Mapped[Product | None] = relationship()


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------
class Inventory(Base):
    __tablename__ = "inventory"
    __table_args__ = (UniqueConstraint("product_id", "plant_id", name="uq_inventory_product_plant"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), nullable=True, index=True)
    opening_stock: Mapped[float] = mapped_column(Float, nullable=False, server_default="0", default=0)
    received_qty: Mapped[float] = mapped_column(Float, nullable=False, server_default="0", default=0)
    issued_qty: Mapped[float] = mapped_column(Float, nullable=False, server_default="0", default=0)
    current_stock: Mapped[float] = mapped_column(Float, nullable=False, server_default="0", default=0)
    min_level: Mapped[float | None] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    product: Mapped[Product] = relationship(back_populates="stock")
    plant: Mapped[Plant | None] = relationship()


class StockMovement(Base):
    __tablename__ = "stock_movements"
    __table_args__ = (Index("ix_movement_product_date", "product_id", "transaction_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), nullable=True, index=True)
    movement_type: Mapped[MovementType] = mapped_column(Enum(MovementType), index=True)
    quantity: Mapped[float] = mapped_column(Float, default=0)
    transaction_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    ref_type: Mapped[str] = mapped_column(String(80), default="")
    ref_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    remarks: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    product: Mapped[Product] = relationship()
    plant: Mapped[Plant | None] = relationship()


# ---------------------------------------------------------------------------
# Production
# ---------------------------------------------------------------------------
class ProductionOrder(Base):
    __tablename__ = "production_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_no: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    section: Mapped[str] = mapped_column(String(120), default="", index=True)
    schedule_qty: Mapped[float] = mapped_column(Float, default=0)
    ask_till_date: Mapped[float | None] = mapped_column(Float, nullable=True)
    produced_qty: Mapped[float] = mapped_column(Float, default=0)
    completion_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    balance_qty: Mapped[float] = mapped_column(Float, default=0)
    opening_stock: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[ProductionStatus] = mapped_column(
        Enum(ProductionStatus), default=ProductionStatus.planned, index=True
    )
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    completion_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    report_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    remarks: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    product: Mapped[Product] = relationship()
    movements: Mapped[list[ProductionMovement]] = relationship(
        back_populates="production_order", cascade="all, delete-orphan"
    )


class ProductionMovement(Base):
    __tablename__ = "production_movements"

    id: Mapped[int] = mapped_column(primary_key=True)
    production_order_id: Mapped[int] = mapped_column(ForeignKey("production_orders.id"), index=True)
    quantity: Mapped[float] = mapped_column(Float, default=0)
    production_date: Mapped[date] = mapped_column(Date, index=True)
    source_excel: Mapped[str] = mapped_column(String(255), default="")

    production_order: Mapped[ProductionOrder] = relationship(back_populates="movements")


# ---------------------------------------------------------------------------
# Sales orders
# ---------------------------------------------------------------------------
class SalesOrder(Base):
    __tablename__ = "sales_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_no: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), nullable=True, index=True)
    order_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    required_delivery_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus), default=OrderStatus.new, index=True)
    total_value: Mapped[float] = mapped_column(Numeric(14, 2), default=0)
    remarks: Mapped[str] = mapped_column(Text, default="")
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    customer: Mapped[Customer | None] = relationship()
    lines: Mapped[list[SalesOrderLine]] = relationship(back_populates="order", cascade="all, delete-orphan")
    dispatches: Mapped[list[Dispatch]] = relationship(back_populates="sales_order")


class SalesOrderLine(Base):
    __tablename__ = "sales_order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("sales_orders.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    quantity: Mapped[float] = mapped_column(Float, default=0)
    unit_price: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    amount: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)

    order: Mapped[SalesOrder] = relationship(back_populates="lines")
    product: Mapped[Product | None] = relationship()


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
class Dispatch(Base):
    __tablename__ = "dispatches"

    id: Mapped[int] = mapped_column(primary_key=True)
    dispatch_no: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), nullable=True, index=True)
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id"), nullable=True, index=True)
    sales_order_id: Mapped[int | None] = mapped_column(ForeignKey("sales_orders.id"), nullable=True, index=True)
    sales_person: Mapped[str] = mapped_column(String(120), default="")
    schedule_qty: Mapped[float] = mapped_column(Float, default=0)
    ask_till_date: Mapped[float | None] = mapped_column(Float, nullable=True)
    dispatched_qty: Mapped[float] = mapped_column(Float, default=0)
    completion_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    balance_qty: Mapped[float] = mapped_column(Float, default=0)
    opening_stock: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[DispatchStatus] = mapped_column(
        Enum(DispatchStatus), default=DispatchStatus.pending, index=True
    )
    dispatch_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    delivery_status: Mapped[str] = mapped_column(String(120), default="")
    transport_details: Mapped[str] = mapped_column(Text, default="")
    report_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    remarks: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    customer: Mapped[Customer | None] = relationship()
    plant: Mapped[Plant | None] = relationship()
    sales_order: Mapped[SalesOrder | None] = relationship(back_populates="dispatches")
    lines: Mapped[list[DispatchLine]] = relationship(back_populates="dispatch", cascade="all, delete-orphan")


class DispatchLine(Base):
    __tablename__ = "dispatch_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    dispatch_id: Mapped[int] = mapped_column(ForeignKey("dispatches.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    quantity: Mapped[float] = mapped_column(Float, default=0)
    dispatch_date: Mapped[date] = mapped_column(Date, index=True)
    rate: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    weight: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_excel: Mapped[str] = mapped_column(String(255), default="")

    dispatch: Mapped[Dispatch] = relationship(back_populates="lines")
    product: Mapped[Product | None] = relationship()


# ---------------------------------------------------------------------------
# Plans (production / dispatch plane)
# ---------------------------------------------------------------------------
class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_type: Mapped[PlanType] = mapped_column(Enum(PlanType), index=True)
    model: Mapped[str] = mapped_column(String(500), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True, index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), nullable=True, index=True)
    quantity: Mapped[float | None] = mapped_column(Float, nullable=True)
    rate: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    weight: Mapped[float | None] = mapped_column(Float, nullable=True)
    owner: Mapped[str] = mapped_column(String(120), default="")
    status: Mapped[str] = mapped_column(String(80), default="PENDING", index=True)
    plan_date: Mapped[date] = mapped_column(Date, index=True, default=date.today)
    source_excel: Mapped[str] = mapped_column(String(255), default="")
    remarks: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    product: Mapped[Product | None] = relationship()
    customer: Mapped[Customer | None] = relationship()


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------
class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(60), index=True)
    entity: Mapped[str] = mapped_column(String(120), index=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    details: Mapped[str] = mapped_column(Text, default="")
    ip: Mapped[str] = mapped_column(String(60), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class MigrationLog(Base):
    __tablename__ = "migration_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_sheet: Mapped[str] = mapped_column(String(120))
    target_table: Mapped[str] = mapped_column(String(120))
    rows_imported: Mapped[int] = mapped_column(Integer, default=0)
    rows_skipped: Mapped[int] = mapped_column(Integer, default=0)
    assumptions: Mapped[str] = mapped_column(Text, default="")
    imported_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    status: Mapped[str] = mapped_column(String(40), default="completed")