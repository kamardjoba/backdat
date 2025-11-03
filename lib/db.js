// /lib/db.js
import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function ensureOrdersEventId() {
  try {
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_id INT REFERENCES events(id);
      CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id);
    `);
    console.log('✅ orders.event_id проверен/создан')
  } catch (err) {
    console.error('❌ Ошибка при миграции orders.event_id:', err)
  }
}
ensureOrdersEventId();

// --- авто-миграции при старте ---
// === AUTO MIGRATIONS: bring 'orders' schema up to date ===
async function runMigrations() {
  try {
    await pool.query(`
      -- orders: базовые поля, которые использует код
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_id   INT REFERENCES events(id);
      CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id);

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id    INT REFERENCES users(id);
      CREATE INDEX IF NOT EXISTS idx_orders_user  ON orders(user_id);

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT;

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal   NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount   NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS total      NUMERIC(10,2) DEFAULT 0;

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency   TEXT DEFAULT 'PLN';

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS status     TEXT DEFAULT 'paid';
      -- Можно включить ограничение статуса, но только если в таблице нет других значений:
      -- DO $$ BEGIN
      --   IF NOT EXISTS (
      --     SELECT 1 FROM information_schema.constraint_column_usage
      --     WHERE table_name='orders' AND constraint_name='orders_status_chk'
      --   ) THEN
      --     ALTER TABLE orders
      --     ADD CONSTRAINT orders_status_chk CHECK (status IN ('paid','pending','failed','refunded'));
      --   END IF;
      -- END $$;

      -- на всякий случай для order_items
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price NUMERIC(10,2) DEFAULT 0;

      -- seat_availability иногда забывают инициализировать — не миграция, но полезный бэкфилл:
      -- создадим availability для всех событий/мест, где его нет
      INSERT INTO seat_availability(event_id, seat_id, status)
      SELECT e.id, vs.id, 'available'
      FROM events e
      JOIN venue_seats vs ON vs.venue_id = e.venue_id
      LEFT JOIN seat_availability sa ON sa.event_id = e.id AND sa.seat_id = vs.id
      WHERE sa.seat_id IS NULL
      ON CONFLICT DO NOTHING;
    `);

    console.log('✅ DB migrations checked');
  } catch (e) {
    console.error('❌ DB migrations failed:', e);
  }
}
runMigrations();

// === MIGRATION: ensure orders.user_id exists ===
async function ensureOrdersUserId() {
  try {
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    `);
    console.log("✅ Migration check: user_id column exists in orders");
  } catch (e) {
    console.error("⚠️ Migration failed:", e);
  }
}
ensureOrdersUserId();
// === END MIGRATION ===

export async function runSqlFile(filepath) {
  const sql = fs.readFileSync(filepath, "utf8");
  await pool.query(sql);
}

export async function ensureDb() {
  const dir = path.resolve(process.cwd(), "migrations");
  // ⚠️ порядок важен: совместимость -> схема -> сиды
  const files = ["00_compat.sql", "01_schema.sql", "02_seed.sql"];
  for (const f of files) {
    const full = path.join(dir, f);
    console.log("Applying migration:", f);
    await runSqlFile(full);
  }
  console.log("✅ Migrations applied");
}
