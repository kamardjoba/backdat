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
