// /index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool, ensureDb } from "./lib/db.js";
import { calcPrice } from "./lib/pricing.js";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOLD_TTL = Number(process.env.HOLD_TTL_SECONDS || 600);

app.use(cors());
app.use(express.json());

// Cloudinary
cloudinary.config({ secure: true });
const upload = multer({ dest: "uploads/" });

// Health
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Ensure DB (migrations)
await ensureDb();

/* ============================
 *      PUBLIC  API
 * ============================ */

// Artists
app.get("/api/artists", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, genre, bio, photo_url AS "photoUrl" FROM artists ORDER BY id DESC`);
  res.json(rows);
});

// Venues
app.get("/api/venues", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, city, address, rows_count AS "rows", cols_count AS "cols" FROM venues ORDER BY id DESC`);
  res.json(rows);
});

// Events (list upcoming)
app.get("/api/events", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.id, e.starts_at AS "startsAt", e.title, e.status,
           a.id AS "artistId", a.name AS "artistName", a.photo_url AS "artistPhoto",
           v.id AS "venueId", v.name AS "venueName", v.city
    FROM events e
    JOIN artists a ON a.id = e.artist_id
    JOIN venues v  ON v.id = e.venue_id
    WHERE e.starts_at > NOW() AND e.status = 'scheduled'
    ORDER BY e.starts_at ASC
  `);
  res.json(rows);
});

// Event details
app.get("/api/events/:id", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.id, e.starts_at AS "startsAt", e.title, e.status, e.dynamic_cfg AS "dynamicCfg",
           a.id AS "artistId", a.name AS "artistName", a.genre, a.bio, a.photo_url AS "artistPhoto",
           v.id AS "venueId", v.name AS "venueName", v.city, v.address, v.rows_count AS "rows", v.cols_count AS "cols"
    FROM events e
    JOIN artists a ON a.id = e.artist_id
    JOIN venues v  ON v.id = e.venue_id
    WHERE e.id = $1
    LIMIT 1
  `, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  res.json(rows[0]);
});

// Seats map with availability and price
app.get("/api/events/:id/seats", async (req, res) => {
  const eventId = Number(req.params.id);
  const prices = await pool.query(`SELECT zone_code, base_price, multiplier FROM event_prices WHERE event_id=$1`, [eventId]);
  const priceMap = Object.fromEntries(prices.rows.map(p => [p.zone_code, calcPrice(p)]));

  const { rows } = await pool.query(`
    SELECT sa.seat_id AS "seatId", vs.row_number AS row, vs.seat_number AS seat,
           vs.zone_code AS zone, sa.status
    FROM seat_availability sa
    JOIN venue_seats vs ON vs.id = sa.seat_id
    WHERE sa.event_id = $1
    ORDER BY vs.row_number, vs.seat_number
  `, [eventId]);

  const out = rows.map(r => ({ ...r, price: priceMap[r.zone] ?? null }));
  res.json(out);
});

// Create hold(s)
app.post("/api/holds", async (req, res) => {
  const { event_id, seat_ids, user_token } = req.body || {};
  if (!event_id || !Array.isArray(seat_ids) || !seat_ids.length || !user_token) {
    return res.status(400).json({ error: "bad_payload" });
  }
  const expiresAt = new Date(Date.now() + HOLD_TTL * 1000);
  const holdIds = [];

  try {
    await pool.query("BEGIN");
    for (const seatId of seat_ids) {
      // только если место свободно
      const { rows: avail } = await pool.query(
        `SELECT status FROM seat_availability WHERE event_id=$1 AND seat_id=$2 FOR UPDATE`,
        [event_id, seatId]
      );
      if (!avail.length || avail[0].status !== "available") continue;

      const id = uuidv4();
      await pool.query(`
        INSERT INTO holds(id, event_id, seat_id, user_token, expires_at)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING
      `, [id, event_id, seatId, user_token, expiresAt]);

      await pool.query(`
        UPDATE seat_availability SET status='hold', updated_at=NOW()
        WHERE event_id=$1 AND seat_id=$2
      `, [event_id, seatId]);

      holdIds.push(id);
    }
    await pool.query("COMMIT");
    res.json({ ok: true, holdIds, expiresAt });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "hold_failed" });
  }
});

// Renew holds
app.post("/api/holds/renew", async (req, res) => {
  const { hold_ids, user_token } = req.body || {};
  if (!Array.isArray(hold_ids) || !hold_ids.length || !user_token) {
    return res.status(400).json({ error: "bad_payload" });
  }
  const expiresAt = new Date(Date.now() + HOLD_TTL * 1000);
  await pool.query(`
    UPDATE holds SET expires_at=$1
    WHERE id = ANY($2) AND user_token=$3
  `, [expiresAt, hold_ids, user_token]);
  res.json({ ok: true, expiresAt });
});

// Validate promo
app.post("/api/promos/validate", async (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: "code_required" });

  const { rows } = await pool.query(`
    SELECT code, discount_pct AS "discountPct", valid_from AS "validFrom", valid_until AS "validUntil",
           max_usage, used_count
    FROM promos
    WHERE LOWER(code)=LOWER($1) AND valid_from<=NOW() AND valid_until>=NOW()
  `, [code]);

  res.json(rows[0] || null);
});

// Create order (no payment provider here, just data)
app.post("/api/orders", async (req, res) => {
  const { event_id, seat_ids, buyer, promo_code, user_token } = req.body || {};
  if (!event_id || !Array.isArray(seat_ids) || !seat_ids.length || !buyer?.name || !buyer?.email || !user_token) {
    return res.status(400).json({ error: "bad_payload" });
  }

  // цены по зонам
  const prices = await pool.query(`SELECT zone_code, base_price, multiplier FROM event_prices WHERE event_id=$1`, [event_id]);
  const priceMap = Object.fromEntries(prices.rows.map(p => [p.zone_code, calcPrice(p)]));

  try {
    await pool.query("BEGIN");

    // проверим, что места в hold именно у этого пользователя
    const { rows: seats } = await pool.query(`
      SELECT h.id AS hold_id, h.seat_id, vs.zone_code AS zone
      FROM holds h
      JOIN venue_seats vs ON vs.id = h.seat_id
      WHERE h.event_id=$1 AND h.user_token=$2 AND h.expires_at>NOW() AND h.seat_id = ANY($3)
    `, [event_id, user_token, seat_ids]);

    if (seats.length !== seat_ids.length) {
      await pool.query("ROLLBACK");
      return res.status(409).json({ error: "hold_mismatch" });
    }

    // расчёт суммы
    const itemPrices = seats.map(s => priceMap[s.zone] ?? 0);
    const subtotal = itemPrices.reduce((a, b) => a + b, 0);
    let discount = 0;

    if (promo_code) {
      const { rows: promos } = await pool.query(`
        SELECT code, discount_pct AS pct, max_usage, used_count
        FROM promos
        WHERE LOWER(code)=LOWER($1) AND valid_from<=NOW() AND valid_until>=NOW()
        LIMIT 1
      `, [promo_code]);
      if (promos.length) {
        const p = promos[0];
        if (p.max_usage == null || p.used_count < p.max_usage) {
          discount = Math.round(subtotal * (Number(p.pct) / 100) * 100) / 100;
          await pool.query(`UPDATE promos SET used_count = used_count + 1 WHERE code=$1`, [p.code]);
          await pool.query(`INSERT INTO promo_usages(code, order_id) VALUES ($1, $2)`, [p.code, uuidv4()]); // пробный usage id, ниже перезапишем корректно
        }
      }
    }
    const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);

    // создаём заказ
    const orderId = uuidv4();
    const orderIns = await pool.query(`
      INSERT INTO orders(id, event_id, buyer_name, buyer_email, promo_code, subtotal, discount, total, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
      RETURNING id
    `, [orderId, event_id, buyer.name, buyer.email, promo_code || null, subtotal, discount, total]);

    // переносим позиции + бронируем места
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      const price = itemPrices[i];
      await pool.query(`
        INSERT INTO order_items(order_id, seat_id, price)
        VALUES ($1,$2,$3)
      `, [orderId, s.seat_id, price]);

      await pool.query(`
        UPDATE seat_availability SET status='booked', updated_at=NOW()
        WHERE event_id=$1 AND seat_id=$2
      `, [event_id, s.seat_id]);
    }

    // очищаем holds для этих мест
    await pool.query(`
      DELETE FROM holds WHERE event_id=$1 AND seat_id = ANY($2)
    `, [event_id, seat_ids]);

    await pool.query("COMMIT");
    res.status(201).json({ id: orderIns.rows[0].id, subtotal, discount, total, status: "pending" });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "order_failed" });
  }
});

/* ============================
 *        ADMIN  API
 * (добавь авторизацию позже)
 * ============================ */

// Add artist (with photo)
app.post("/api/admin/artists", upload.single("photo"), async (req, res) => {
  try {
    const { name, genre, bio } = req.body || {};
    if (!name) return res.status(400).json({ error: "name_required" });

    let photoUrl = null;
    if (req.file) {
      const up = await cloudinary.uploader.upload(req.file.path, { folder: "artists" });
      photoUrl = up.secure_url;
      fs.unlink(req.file.path, () => {});
    }

    const { rows } = await pool.query(`
      INSERT INTO artists(name, genre, bio, photo_url)
      VALUES ($1,$2,$3,$4)
      RETURNING id, name, genre, bio, photo_url AS "photoUrl"
    `, [name, genre || "", bio || "", photoUrl]);

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "artist_create_failed" });
  }
});

// Create venue + generate seats + default zones (A/B/VIP)
app.post("/api/admin/venues", async (req, res) => {
  const { name, city, address, rows, cols } = req.body || {};
  if (!name || !city || !rows || !cols) return res.status(400).json({ error: "bad_payload" });

  try {
    await pool.query("BEGIN");
    const v = await pool.query(`
      INSERT INTO venues(name, city, address, rows_count, cols_count, seating_map)
      VALUES ($1,$2,$3,$4,$5,'{}'::jsonb) RETURNING id
    `, [name, city, address || null, rows, cols]);

    const venueId = v.rows[0].id;

    // дефолтные зоны
    await pool.query(`
      INSERT INTO price_zones(venue_id, code, name, base_color)
      VALUES
        ($1,'VIP','VIP','#d97706'),
        ($1,'A','Zone A','#16a34a'),
        ($1,'B','Zone B','#2563eb')
    `, [venueId]);

    // seats grid (ряды 1-3 VIP, 4-7 A, остальное B)
    for (let r = 1; r <= rows; r++) {
      const zone = r <= 3 ? "VIP" : r <= 7 ? "A" : "B";
      const values = [];
      for (let c = 1; c <= cols; c++) {
        values.push(`(${venueId},${r},${c},'${zone}','seat')`);
      }
      await pool.query(`
        INSERT INTO venue_seats(venue_id,row_number,seat_number,zone_code,seat_type)
        VALUES ${values.join(",")}
      `);
    }

    await pool.query("COMMIT");
    res.status(201).json({ id: venueId });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "venue_create_failed" });
  }
});

// Create event + init availability + prices
app.post("/api/admin/events", async (req, res) => {
  const { artist_id, venue_id, starts_at, title, prices } = req.body || {};
  if (!artist_id || !venue_id || !starts_at) return res.status(400).json({ error: "bad_payload" });

  try {
    await pool.query("BEGIN");
    const ev = await pool.query(`
      INSERT INTO events(artist_id, venue_id, starts_at, title, status)
      VALUES ($1,$2,$3,$4,'scheduled') RETURNING id
    `, [artist_id, venue_id, starts_at, title || null]);
    const eventId = ev.rows[0].id;

    // цены по зонам (prices: [{zone_code, base_price, multiplier}])
    if (Array.isArray(prices)) {
      for (const p of prices) {
        await pool.query(`
          INSERT INTO event_prices(event_id, zone_code, base_price, multiplier)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (event_id, zone_code) DO UPDATE
          SET base_price=EXCLUDED.base_price, multiplier=EXCLUDED.multiplier
        `, [eventId, p.zone_code, p.base_price, p.multiplier || 1.0]);
      }
    }

    // инициализируем availability
    await pool.query(`
      INSERT INTO seat_availability(event_id, seat_id, status)
      SELECT $1, vs.id, 'available'
      FROM venue_seats vs
      WHERE vs.venue_id = $2
      ON CONFLICT DO NOTHING
    `, [eventId, venue_id]);

    await pool.query("COMMIT");
    res.status(201).json({ id: eventId });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "event_create_failed" });
  }
});

/* ============================
 *   CLEANER for expired holds
 * ============================ */
async function cleanupExpiredHolds() {
  try {
    await pool.query("BEGIN");
    // какие холды протухли
    const { rows: expired } = await pool.query(`
      SELECT id, event_id, seat_id FROM holds WHERE expires_at < NOW()
    `);
    if (expired.length) {
      const byEvent = expired.reduce((acc, x) => {
        (acc[x.event_id] ||= []).push(x.seat_id);
        return acc;
      }, {});
      // вернуть места в available
      for (const [eventId, seatIds] of Object.entries(byEvent)) {
        await pool.query(`
          UPDATE seat_availability SET status='available', updated_at=NOW()
          WHERE event_id=$1 AND seat_id = ANY($2)
        `, [Number(eventId), seatIds]);
      }
      // удалить холды
      await pool.query(`DELETE FROM holds WHERE expires_at < NOW()`);
    }
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("cleanupExpiredHolds error:", e);
  }
}
setInterval(cleanupExpiredHolds, 30 * 1000); // каждые 30 сек

app.listen(PORT, () => console.log(`🎵 Server listening on ${PORT}`));