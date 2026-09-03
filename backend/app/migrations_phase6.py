from sqlalchemy import create_engine, text
from app.database import engine

statements = [
    "ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS customer_id INTEGER",
    "ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS salesperson_id INTEGER",
    "ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS sales_order_id INTEGER",
    "CREATE INDEX IF NOT EXISTS ix_production_orders_customer_id ON production_orders (customer_id)",
    "CREATE INDEX IF NOT EXISTS ix_production_orders_sales_order_id ON production_orders (sales_order_id)",
    "ALTER TABLE purchase_requirements ADD COLUMN IF NOT EXISTS requirement_type VARCHAR(40) DEFAULT 'TRADING_PRODUCT'",
    "CREATE INDEX IF NOT EXISTS ix_purchase_requirements_requirement_type ON purchase_requirements (requirement_type)",
    "ALTER TABLE dispatch_lines ADD COLUMN IF NOT EXISTS sales_order_line_id INTEGER",
    "CREATE INDEX IF NOT EXISTS ix_dispatch_lines_sales_order_line_id ON dispatch_lines (sales_order_line_id)",
]

with engine.begin() as conn:
    for stmt in statements:
        conn.execute(text(stmt))
print("ALTERs applied")
