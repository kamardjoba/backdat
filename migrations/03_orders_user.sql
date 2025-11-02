ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);