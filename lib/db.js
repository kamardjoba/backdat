import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL env var is required");
}

export const pool = new Pool({
  connectionString,
  // Для Railway/облачных Postgres обычно нужна SSL
  ssl: { rejectUnauthorized: false }
});

export async function ensureDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM items"
  );

  if (rows[0].count === 0) {
    await pool.query(
      "INSERT INTO items(name) VALUES ($1), ($2), ($3)",
      ["Hello from Railway", "It works!", "Database connected ✅"]
    );
  }
}