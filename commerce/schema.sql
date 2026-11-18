-- LMK inventory foundation (staging design only).
-- Checkout defaults to OFF. Legal/product and processor eligibility must be approved
-- before any SKU is exposed to a payment checkout.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS inventory_products (
  sku TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  unit_size TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'review_required'
    CHECK(status IN ('review_required','research_only','approved_for_sale','blocked')),
  checkout_enabled INTEGER NOT NULL DEFAULT 0 CHECK(checkout_enabled IN (0,1)),
  price_cents INTEGER CHECK(price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(reserved <= on_hand),
  CHECK(checkout_enabled = 0 OR (status = 'approved_for_sale' AND price_cents IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL REFERENCES inventory_products(sku),
  quantity_delta INTEGER NOT NULL CHECK(quantity_delta <> 0),
  reason TEXT NOT NULL CHECK(reason IN ('receipt','adjustment','fulfillment','return','damage')),
  reference TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sku, reason, reference)
);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','paid','canceled','fulfilled','refunded')),
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents >= 0),
  provider TEXT,
  provider_checkout_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS commerce_order_items (
  order_id TEXT NOT NULL REFERENCES commerce_orders(id),
  sku TEXT NOT NULL REFERENCES inventory_products(sku),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
  PRIMARY KEY(order_id, sku)
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider,event_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory_products(status,checkout_enabled);
CREATE INDEX IF NOT EXISTS idx_order_status ON commerce_orders(status);
