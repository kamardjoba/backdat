// /index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool, ensureDb } from "./lib/db.js";
//import { calcPrice } from "./lib/pricing.js";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

import nodemailer from "nodemailer";

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change_me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";


function signToken(user){
  return jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function auth(req, res, next){
  const h = req.headers.authorization || "";
  const [, token] = h.split(" ");
  if(!token) return res.status(401).json({ error: "unauthorized" });
  try{
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  }catch(e){
    return res.status(401).json({ error: "invalid_token" });
  }
}

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


app.get("/api/artists", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, genre, bio, photo_url AS "photoUrl" FROM artists ORDER BY id DESC`);
  res.json(rows);
});








const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
const FROM_EMAIL = process.env.FROM_EMAIL || "Tickets <no-reply@example.com>";

async function sendOrderEmail(orderId) {
  // заказ + событие + площадка
  const { rows: ordRows } = await pool.query(`
    SELECT o.id, o.buyer_name, o.buyer_email, o.total, COALESCE(o.currency,'PLN') AS currency, o.created_at,
           e.id AS event_id, e.title, e.starts_at,
           v.name AS venue_name, v.city, v.address
    FROM orders o
    JOIN events e ON e.id = o.event_id
    JOIN venues v ON v.id = e.venue_id
    WHERE o.id = $1
  `, [orderId]);
  if (!ordRows.length) return;
  const o = ordRows[0];

  // места
  const { rows: seatRows } = await pool.query(`
    SELECT vs.row_number AS row, vs.seat_number AS col, vs.zone_code
    FROM order_items oi
    JOIN venue_seats vs ON vs.id = oi.seat_id
    WHERE oi.order_id = $1
    ORDER BY vs.row_number, vs.seat_number
  `, [orderId]);

  const seatsList = seatRows.map(s => `Ряд ${s.row}, Место ${s.col}${s.zone_code ? ` (Зона ${s.zone_code})` : ''}`).join('<br/>');
  const when = new Date(o.starts_at);
  const whenStr = when.toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif">
      <h2>Билеты успешно куплены 🎟</h2>
      <p>Здравствуйте, ${o.buyer_name || 'покупатель'}!</p>
      <p>Ваш заказ <b>#${o.id}</b> оплачен. Детали ниже:</p>

      <h3 style="margin:16px 0 8px">Событие</h3>
      <p><b>${o.title || 'Событие'}</b><br/>
         ${o.city || ''}${o.city ? ', ' : ''}${o.venue_name || ''}${o.address ? ', ' + o.address : ''}<br/>
         ${whenStr}
      </p>

      <h3 style="margin:16px 0 8px">Места</h3>
      <p>${seatsList || '—'}</p>

      <h3 style="margin:16px 0 8px">Итого</h3>
      <p><b>${o.total} ${o.currency}</b></p>

      <hr style="margin:20px 0;border:none;border-top:1px solid #eee" />
      <p style="color:#555">Спасибо за покупку! Это письмо — подтверждение оплаты. Билеты также доступны в личном кабинете.</p>
    </div>
  `;

  await mailer.sendMail({
    from: FROM_EMAIL,
    to: o.buyer_email,
    subject: `Ваши билеты — заказ #${o.id}`,
    html,
  });
}





app.get("/api/venues", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, city, address, rows_count AS "rows", cols_count AS "cols" FROM venues ORDER BY id DESC`);
  res.json(rows);
});


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


app.post("/api/auth/register", async (req,res)=>{
  const { email, password, name } = req.body || {};
  if(!email || !password) return res.status(400).json({ error:"bad_payload" });
  try{
    const hash = await bcrypt.hash(password, 12);
    const u = await pool.query(`
      INSERT INTO users(email, pass_hash, role) VALUES ($1,$2,'user')
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email, role
    `, [email.toLowerCase(), hash]);

    if(!u.rows.length) return res.status(409).json({ error:"email_taken" });


    const token = signToken(u.rows[0]);
    res.json({ token, user:{ id:u.rows[0].id, email:u.rows[0].email, name: name || "", role:u.rows[0].role } });
  }catch(e){ console.error(e); res.status(500).json({ error:"register_failed" }); }
});


app.post("/api/auth/login", async (req,res)=>{
  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ error:"bad_payload" });
  try{
    const q = await pool.query(`SELECT id, email, pass_hash, role FROM users WHERE email=$1`, [email.toLowerCase()]);
    const user = q.rows[0];
    if(!user) return res.status(401).json({ error:"bad_credentials" });
    const ok = await bcrypt.compare(password, user.pass_hash);
    if(!ok) return res.status(401).json({ error:"bad_credentials" });
    const token = signToken(user);
    res.json({ token, user:{ id:user.id, email:user.email, role:user.role } });
  }catch(e){ console.error(e); res.status(500).json({ error:"login_failed" }); }
});

// ME
app.get("/api/auth/me", auth, async (req,res)=>{
  const q = await pool.query(`SELECT id, email, role FROM users WHERE id=$1`, [req.user.id]);
  res.json(q.rows[0]);
});


app.put("/api/auth/me", auth, async (req,res)=>{
  const { name, phone } = req.body || {};
  // для простоты: профиль можно хранить в users (нужны колонки) или завести таблицу users_profile
  // Быстрое решение: добавим колонки в users (если хочешь):
  // ALTER TABLE users ADD COLUMN name TEXT, ADD COLUMN phone TEXT;
  const q = await pool.query(`UPDATE users SET name=COALESCE($2,name), phone=COALESCE($3,phone) WHERE id=$1
                              RETURNING id,email,role,name,phone`, [req.user.id, name ?? null, phone ?? null]);
  res.json(q.rows[0]);
});


app.get("/api/my/orders", auth, async (req,res)=>{
  try{
    const { rows } = await pool.query(`
      SELECT o.id, o.created_at, o.total, COALESCE(o.currency,'PLN') AS currency, o.status,
             e.id AS "eventId", e.starts_at AS "startsAt", e.title,
             v.id AS "venueId", v.name AS "venueName", v.city
      FROM orders o
      JOIN events e ON e.id = o.event_id
      JOIN venues v ON v.id = e.venue_id
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  }catch(e){
    console.error(e);
    res.status(500).json({ error:"fetch_orders_failed" });
  }
});

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

app.get("/api/events/:id/seats", async (req, res) => {
  const eventId = Number(req.params.id)
  if (!eventId) return res.status(400).json({ error: "bad_event_id" })

  try {
    // Сначала проверяем, существует ли событие и получаем venue_id
    const eventCheck = await pool.query(`
      SELECT e.id, e.venue_id, v.rows_count, v.cols_count
      FROM events e
      JOIN venues v ON v.id = e.venue_id
      WHERE e.id = $1
    `, [eventId])

    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ error: "event_not_found" })
    }

    const { venue_id, rows_count, cols_count } = eventCheck.rows[0]

    // Проверяем, есть ли места для этой площадки
    const seatsCount = await pool.query(`
      SELECT COUNT(*) as count FROM venue_seats WHERE venue_id = $1
    `, [venue_id])

    // Если мест нет, создаём их автоматически
    if (parseInt(seatsCount.rows[0].count) === 0 && rows_count && cols_count) {
      await pool.query("BEGIN")
      
      // Создаём дефолтные зоны, если их нет
      await pool.query(`
        INSERT INTO price_zones(venue_id, code, name, base_color)
        VALUES
          ($1,'VIP','VIP','#d97706'),
          ($1,'A','Zone A','#16a34a'),
          ($1,'B','Zone B','#2563eb')
        ON CONFLICT (venue_id, code) DO NOTHING
      `, [venue_id])

      // Создаём места для площадки
      for (let r = 1; r <= rows_count; r++) {
        const zone = r <= 3 ? "VIP" : r <= 7 ? "A" : "B"
        const values = []
        for (let c = 1; c <= cols_count; c++) {
          values.push(`(${venue_id},${r},${c},'${zone}','seat')`)
        }
        if (values.length > 0) {
          await pool.query(`
            INSERT INTO venue_seats(venue_id,row_number,seat_number,zone_code,seat_type)
            VALUES ${values.join(",")}
            ON CONFLICT (venue_id, row_number, seat_number) DO NOTHING
          `)
        }
      }

      // Инициализируем availability для всех мест события
      await pool.query(`
        INSERT INTO seat_availability(event_id, seat_id, status)
        SELECT $1, vs.id, 'available'
        FROM venue_seats vs
        WHERE vs.venue_id = $2
        ON CONFLICT DO NOTHING
      `, [eventId, venue_id])

      await pool.query("COMMIT")
    }

    // Получаем места с информацией о зонах
    const { rows } = await pool.query(`
      SELECT
        vs.id                         AS "seatId",
        vs.row_number                 AS row,
        vs.seat_number                AS seat,
        vs.zone_code                  AS zone,
        vs.seat_type                  AS "seatType",
        COALESCE(sa.status, 'available')              AS status,
        COALESCE(pr.base_price, 100)::numeric(10,2)   AS price,
        pz.name                       AS "zoneName",
        pz.base_color                 AS "zoneColor"
      FROM events e
      JOIN venue_seats vs
        ON vs.venue_id = e.venue_id
      LEFT JOIN seat_availability sa
        ON sa.event_id = e.id AND sa.seat_id = vs.id
      LEFT JOIN event_prices pr
        ON pr.event_id = e.id AND pr.zone_code = vs.zone_code
      LEFT JOIN price_zones pz
        ON pz.venue_id = e.venue_id AND pz.code = vs.zone_code
      WHERE e.id = $1
      ORDER BY vs.row_number, vs.seat_number
    `, [eventId])

    // Получаем информацию о зонах с ценами
    const zonesInfo = await pool.query(`
      SELECT 
        pz.code,
        pz.name,
        pz.base_color AS color,
        COALESCE(MIN(pr.base_price), 100)::numeric(10,2) AS "minPrice",
        COALESCE(MAX(pr.base_price), 100)::numeric(10,2) AS "maxPrice"
      FROM price_zones pz
      LEFT JOIN event_prices pr ON pr.event_id = $1 AND pr.zone_code = pz.code
      WHERE pz.venue_id = $2
      GROUP BY pz.code, pz.name, pz.base_color
      ORDER BY pz.code
    `, [eventId, venue_id])

    res.json({
      seats: rows,
      zones: zonesInfo.rows
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: "seats_fetch_failed", details: e.message })
  }
})

// Bulk create events (multiple dates/cities/venues for one artist)
app.post("/api/admin/events/bulk", async (req, res) => {
  const { artist_id, events } = req.body || {};
  if (!artist_id || !Array.isArray(events) || !events.length) {
    return res.status(400).json({ error: "bad_payload" });
  }

  try {
    await pool.query("BEGIN");
    const created = [];

    for (const ev of events) {
      let venueId = ev.venue_id;

      // Если venue не указан — создаём его на лету
      if (!venueId && ev.venue) {
        const { name, city, address, rows, cols } = ev.venue || {};
        if (!name || !city || !rows || !cols) {
          await pool.query("ROLLBACK");
          return res.status(400).json({ error: "bad_venue_payload" });
        }

        // создаём venue
        const v = await pool.query(`
          INSERT INTO venues(name, city, address, rows_count, cols_count, seating_map)
          VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)
          RETURNING id, name, city
        `, [name, city, address || "", Number(rows), Number(cols)]);
        venueId = v.rows[0].id;

        // генерируем места (как в /api/admin/venues)
        for (let r = 1; r <= Number(rows); r++) {
          for (let c = 1; c <= Number(cols); c++) {
            await pool.query(`
              INSERT INTO venue_seats(venue_id, row_number, seat_number, zone_code, seat_type)
              VALUES ($1, $2, $3, $4, 'seat')
            `, [venueId, r, c, r <= 3 ? "VIP" : r <= 7 ? "A" : "B"]);
          }
        }
      }

      if (!venueId) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "venue_required" });
      }
      if (!ev.starts_at) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "starts_at_required" });
      }

      // создаём событие
      const e = await pool.query(`
        INSERT INTO events(artist_id, venue_id, starts_at, title)
        VALUES ($1,$2,$3,$4)
        RETURNING id, artist_id AS "artistId", venue_id AS "venueId", starts_at AS "startsAt", title, status
      `, [Number(artist_id), Number(venueId), ev.starts_at, ev.title || null]);

      // инициализируем availability как available (опционально)
      // можно оптимизировать массовой вставкой, если нужно
      const seats = await pool.query(`
        SELECT id FROM venue_seats WHERE venue_id=$1
      `, [venueId]);
      const eventId = e.rows[0].id;
      for (const s of seats.rows) {
        await pool.query(`
          INSERT INTO seat_availability(event_id, seat_id, status)
          VALUES ($1, $2, 'available')
        `, [eventId, s.id]);
      }

      created.push(e.rows[0]);
    }

    await pool.query("COMMIT");
    res.status(201).json({ ok: true, events: created });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("bulk events error:", err);
    res.status(500).json({ error: "bulk_create_failed" });
  }
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

async function deleteArtistHandler(req, res) {
  const actorId = Number(req.params.id);
  if (!actorId) return res.status(400).json({ error: "bad_id" });

  // TODO: проверка авторизации админа
  // if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Блокирующая проверка: если по событиям артиста есть оплаченные заказы,
    // удаление запрещаем, чтобы не сломать историю покупок.
    const { rows: blockingOrders } = await client.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM orders o
        JOIN events e ON e.id = o.event_id
        WHERE e.artist_id = $1
      `,
      [actorId]
    );

    if ((blockingOrders[0]?.cnt || 0) > 0) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "artist_has_orders", detail: "У артиста есть события с оформленными заказами. Отмените/удалите заказы или переведите события в другой статус перед удалением." });
    }

    const candidateTables = [
      "event_artists",
      "artists_events",
      "events_artists",
      "artist_events",
      "artist_photo",
      "artist_photos",
      "artist_medias",
      "order_items",
      "tickets",
      "reservation_items",
      "seat_reservations"
    ];

    for (const tbl of candidateTables) {
      const tableCheck = await client.query("SELECT to_regclass($1) AS r", [`public.${tbl}`]);
      if (!tableCheck.rows[0] || !tableCheck.rows[0].r) {
        continue;
      }

      const colCheck = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='artist_id' LIMIT 1`,
        [tbl]
      );
      if (colCheck.rowCount === 0) {
        console.log(`Table ${tbl} exists but has no column artist_id — skipping delete by artist_id`);
        continue;
      }

      try {
        const delRes = await client.query(`DELETE FROM ${tbl} WHERE artist_id = $1`, [actorId]);
        console.log(`Deleted ${delRes.rowCount} rows from ${tbl} for artist ${actorId}`);
      } catch (e) {
        console.error(`Failed to delete from ${tbl} by artist_id:`, e.message);
      }
    }

    const { rowCount } = await client.query("DELETE FROM artists WHERE id = $1", [actorId]);
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "actor_not_found" });
    }

    await client.query("COMMIT");

    console.log(`Admin deleted actor ${actorId} successfully`);
    return res.json({ ok: true, deleted_actor_id: actorId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("admin delete actor failed:", err);
    return res.status(500).json({ error: "delete_failed", detail: err.message });
  } finally {
    client.release();
  }
}

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

// Детали заказа по ID (минимум — без чувствительных данных)
app.get("/api/orders/:id", async (req, res) => {
  const id = String(req.params.id);
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.created_at, o.status,
             COALESCE(o.currency,'PLN') AS currency,
             o.subtotal, o.discount, o.total,
             e.id AS "eventId", e.title, e.starts_at AS "startsAt",
             v.name AS "venueName", v.city, v.address
      FROM orders o
      JOIN events e ON e.id = o.event_id
      JOIN venues v ON v.id = e.venue_id
      WHERE o.id = $1
    `, [id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });

    const order = rows[0];
    const { rows: items } = await pool.query(`
      SELECT vs.row_number AS row, vs.seat_number AS seat, oi.price
      FROM order_items oi
      JOIN venue_seats vs ON vs.id = oi.seat_id
      WHERE oi.order_id = $1
      ORDER BY vs.row_number, vs.seat_number
    `, [id]);

    res.json({ ...order, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "order_fetch_failed" });
  }
});

// Create order (no payment provider here, just data)
// === ORDERS HANDLER — REPLACE ENTIRE /api/orders WITH THIS BLOCK ===
// Создать заказ: блокирует места, создаёт заказ со статусом 'paid', шлёт письмо покупателю
app.post("/api/orders", async (req, res) => {
  const { event_id, seat_ids, buyer, promo_code } = req.body || {};

  // валидация тела
  if (!event_id || !Array.isArray(seat_ids) || !seat_ids.length || !buyer?.name || !buyer?.email) {
    return res.status(400).json({ error: "bad_payload" });
  }

  // вытащим userId, если пришёл Bearer-токен — чтобы привязать заказ к аккаунту
  const authHeader = req.headers.authorization || "";
  let userId = null;
  if (authHeader.startsWith("Bearer ")) {
    try { userId = jwt.verify(authHeader.split(" ")[1], JWT_SECRET).id; }
    catch { userId = null; }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) проверим событие и статус
    const ev = await client.query(
      `SELECT id, venue_id, starts_at, status FROM events WHERE id=$1`,
      [event_id]
    );
    if (!ev.rows.length || ev.rows[0].status !== 'scheduled') {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "bad_event" });
    }

    // 2) загрузим цены по местам и убедимся, что они принадлежат этому событию
    const { rows: seatsData } = await client.query(`
      SELECT s.id AS seat_id, s.row_number AS row, s.seat_number AS col,
             COALESCE(pr.base_price, 100)::numeric(10,2) AS price
      FROM venue_seats s
      JOIN events e ON e.venue_id = s.venue_id
      LEFT JOIN event_prices pr ON pr.event_id = e.id AND pr.zone_code = s.zone_code
      WHERE e.id = $1 AND s.id = ANY($2)
    `, [event_id, seat_ids]);

    if (seatsData.length !== seat_ids.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "some_seats_not_found" });
    }

    // 3) убедимся в доступности мест
    const { rows: taken } = await client.query(`
      SELECT seat_id FROM seat_availability
      WHERE event_id=$1 AND seat_id = ANY($2) AND status <> 'available'
    `, [event_id, seat_ids]);

    if (taken.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "seat_unavailable", seats: taken.map(r => r.seat_id) });
    }

    const itemPrices = seatsData.map(s => Number(s.price));
const subtotal = itemPrices.reduce((a,b)=>a+b, 0);
let discount = 0;

if (promo_code) {
  const p = await client.query(
    `SELECT code, discount_pct, valid_until FROM promos WHERE code=$1`,
    [promo_code]
  );
  if (p.rows.length && (!p.rows[0].valid_until || new Date(p.rows[0].valid_until) > new Date())) {
    discount = Math.round(subtotal * (Number(p.rows[0].discount_pct)/100));
  }
}

const total = Math.max(0, subtotal - discount);

// >>> ДОБАВЬ ЭТО СРАЗУ ПОСЛЕ total <<<
const totals = {
  currency: 'PLN',
  subtotal,
  discount,
  total,
  eventId: event_id,
  items: seat_ids.map((sid, i) => ({
    seatId: sid,
    price: itemPrices[i]
  }))
};
// <<< ДОБАВЛЕНО

// 5) переведём выбранные места в 'booked'
// Сначала создаём записи для мест, которых нет в seat_availability
await client.query(`
  INSERT INTO seat_availability(event_id, seat_id, status)
  SELECT $1, unnest($2::int[]), 'booked'
  ON CONFLICT (event_id, seat_id) DO NOTHING
`, [event_id, seat_ids]);

// Затем обновляем статус на 'booked' для всех выбранных мест
await client.query(`
  UPDATE seat_availability
  SET status='booked', updated_at=NOW()
  WHERE event_id=$1 AND seat_id = ANY($2)
`, [event_id, seat_ids]);

// 6) создаём заказ со статусом 'paid'
const orderId = uuidv4();

// >>> ЗАМЕНИ СВОЙ INSERT НА ЭТОТ <<<
await client.query(`
  INSERT INTO orders(
    id, event_id, buyer_name, buyer_email, promo_code,
    subtotal, discount, total, status, user_id, currency, totals_json
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid',$9,$10,$11)
`, [
  orderId, event_id, buyer.name, buyer.email, promo_code || null,
  subtotal, discount, total, userId,
  'PLN',
  JSON.stringify(totals)
]);

    // 7) строки заказа
    for (let i = 0; i < seat_ids.length; i++) {
      await client.query(`
        INSERT INTO order_items(order_id, seat_id, price)
        VALUES ($1,$2,$3)
      `, [orderId, seat_ids[i], itemPrices[i]]);
    }

  
    await client.query("COMMIT");

    
    sendOrderEmail(orderId).catch(err => console.error("email failed:", err));

    res.status(201).json({ ok: true, order_id: orderId, total, currency: totals.currency });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("order error:", e);
    res.status(500).json({ error: "order_failed" });
  } finally {
    client.release();
  }
});

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
// Create event + init availability + prices
app.post("/api/admin/events", async (req, res) => {
  const { artist_id, venue_id, starts_at, title, prices } = req.body || {};
  if (!artist_id || !venue_id || !starts_at) return res.status(400).json({ error: "bad_payload" });

  try {
    await pool.query("BEGIN");

    // Проверяем, есть ли у площадки места, если нет - создаём их
    const seatsCheck = await pool.query(`
      SELECT COUNT(*) as count FROM venue_seats WHERE venue_id = $1
    `, [venue_id]);
    
    if (parseInt(seatsCheck.rows[0].count) === 0) {
      // Получаем размеры площадки
      const venueInfo = await pool.query(`
        SELECT rows_count, cols_count FROM venues WHERE id = $1
      `, [venue_id]);
      
      if (venueInfo.rows.length === 0) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "venue_not_found" });
      }

      const { rows_count, cols_count } = venueInfo.rows[0];
      
      // Создаём дефолтные зоны, если их нет
      await pool.query(`
        INSERT INTO price_zones(venue_id, code, name, base_color)
        VALUES
          ($1,'VIP','VIP','#d97706'),
          ($1,'A','Zone A','#16a34a'),
          ($1,'B','Zone B','#2563eb')
        ON CONFLICT (venue_id, code) DO NOTHING
      `, [venue_id]);

      // Создаём места для площадки (ряды 1-3 VIP, 4-7 A, остальное B)
      for (let r = 1; r <= rows_count; r++) {
        const zone = r <= 3 ? "VIP" : r <= 7 ? "A" : "B";
        const values = [];
        for (let c = 1; c <= cols_count; c++) {
          values.push(`(${venue_id},${r},${c},'${zone}','seat')`);
        }
        if (values.length > 0) {
          await pool.query(`
            INSERT INTO venue_seats(venue_id,row_number,seat_number,zone_code,seat_type)
            VALUES ${values.join(",")}
            ON CONFLICT (venue_id, row_number, seat_number) DO NOTHING
          `);
        }
      }
    }

    // создаём событие со статусом scheduled
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

    // инициализируем availability для всех мест площадки
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

// Delete artist (and cascade related rows via FK/cleanup tables)
app.delete("/api/admin/artists/:id", deleteArtistHandler);
// Backward-compatible alias expected by FE
app.delete("/api/admin/actors/:id", deleteArtistHandler);

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