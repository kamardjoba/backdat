import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL env var is required");

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

export async function ensureDb() {
  // базовые таблицы
  await pool.query(`
    CREATE TABLE IF NOT EXISTS actors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      photo_url TEXT,
      bio TEXT
    );
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      rows INT NOT NULL DEFAULT 10,
      cols INT NOT NULL DEFAULT 16
    );
    CREATE TABLE IF NOT EXISTS shows (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      venue_id INT REFERENCES venues(id),
      rating NUMERIC(3,1) DEFAULT 0,
      popularity INT DEFAULT 0,
      genres TEXT[] DEFAULT '{}',
      poster_url TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      show_id INT REFERENCES shows(id) ON DELETE CASCADE,
      dateISO TEXT NOT NULL,
      timeISO TEXT NOT NULL,
      basePrice INT NOT NULL DEFAULT 1000,
      dynamicFactor NUMERIC(4,2) NOT NULL DEFAULT 1.00
    );
    CREATE TABLE IF NOT EXISTS seat_occupancy (
      id SERIAL PRIMARY KEY,
      session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
      row INT NOT NULL,
      col INT NOT NULL,
      UNIQUE(session_id, row, col)
    );
    CREATE TABLE IF NOT EXISTS promos (
      code TEXT PRIMARY KEY,
      discount_percent INT NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
      valid_until TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      buyer_name TEXT,
      buyer_email TEXT,
      totals_json JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
      show_id INT,
      session_id INT,
      row INT,
      col INT,
      price INT
    );
  `);

  // сиды — только если пусто
  const [{ count: actorsCount }] = (await pool.query(`SELECT COUNT(*)::int AS count FROM actors`)).rows;
  const [{ count: venuesCount }] = (await pool.query(`SELECT COUNT(*)::int AS count FROM venues`)).rows;
  const [{ count: showsCount }]  = (await pool.query(`SELECT COUNT(*)::int AS count FROM shows`)).rows;
  const [{ count: promoCount }]  = (await pool.query(`SELECT COUNT(*)::int AS count FROM promos`)).rows;

  if (venuesCount === 0) {
    await pool.query(`
      INSERT INTO venues(name, rows, cols) VALUES
      ('Большая сцена', 12, 18),
      ('Малая сцена', 10, 14)
    `);
  }

  if (actorsCount === 0) {
    await pool.query(`
      INSERT INTO actors(name, photo_url, bio) VALUES
      ('Иван Петров', NULL, 'Народный артист'),
      ('Анна Смирнова', NULL, 'Заслуженная актриса'),
      ('Сергей Орлов', NULL, 'Лауреат премий')
    `);
  }

  if (showsCount === 0) {
    // возьмём venue_id = 1 для простоты
    await pool.query(`
      INSERT INTO shows(title, description, venue_id, rating, popularity, genres, poster_url)
      VALUES
      ('Ромео и Джульетта', 'Классическая трагедия', 1, 4.7, 95, ARRAY['drama','classic'], NULL),
      ('Щелкунчик', 'Новогодняя сказка', 1, 4.8, 98, ARRAY['ballet','family'], NULL);
    `);
    await pool.query(`
      INSERT INTO sessions(show_id, dateISO, timeISO, basePrice, dynamicFactor)
      VALUES
      (1, '2025-11-10', '19:00', 1500, 1.10),
      (1, '2025-11-12', '19:00', 1500, 1.00),
      (2, '2025-12-25', '18:00', 2000, 1.20);
    `);
    // несколько занятых мест для примера (session_id=1)
    await pool.query(`
      INSERT INTO seat_occupancy(session_id, row, col) VALUES
      (1, 3, 5), (1, 3, 6), (1, 4, 8)
      ON CONFLICT DO NOTHING;
    `);
  }

  if (promoCount === 0) {
    await pool.query(`
      INSERT INTO promos(code, discount_percent, valid_until) VALUES
      ('HELLO10', 10, NOW() + INTERVAL '30 days'),
      ('NEWYEAR20', 20, NOW() + INTERVAL '90 days');
    `);
  }
}