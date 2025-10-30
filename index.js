import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { pool, ensureDb } from "./lib/db.js";

dotenv.config();
const app = express();


app.use(cors());            // пока оставим открытым, потом можно ограничить доменом Netlify
app.use(express.json());
const upload = multer({ dest: "uploads/" });

// Быстрый пинг сервера
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Эндпоинт, который отдаёт данные из БД
app.get("/api/items", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, created_at FROM items ORDER BY id"
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

app.get("/api/actors", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, photo_url AS "photoUrl", bio FROM actors ORDER BY id`);
  res.json(rows);
});

import { v2 as cloudinary } from "cloudinary";
cloudinary.config({ secure: true });

app.post("/api/admin/actors", upload.single("photo"), async (req, res) => {
  try {
    const { name, bio } = req.body;
    if (!name) return res.status(400).json({ error: "name_required" });

    let photoUrl = null;
    if (req.file) {
      const uploadRes = await cloudinary.uploader.upload(req.file.path, {
        folder: "actors",
      });
      photoUrl = uploadRes.secure_url;
    }

    const { rows } = await pool.query(
      `INSERT INTO actors(name, bio, photo_url)
       VALUES ($1, $2, $3)
       RETURNING id, name, bio, photo_url AS "photoUrl"`,
      [name, bio || "", photoUrl]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("add actor error", e);
    res.status(500).json({ error: "db_error" });
  }
});

app.delete("/api/admin/actors/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "bad_id" });
  await pool.query(`DELETE FROM actors WHERE id = $1`, [id]);
  res.json({ ok: true });
});

app.get("/api/venues", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, rows, cols FROM venues ORDER BY id`);
  res.json(rows);
});

app.get("/api/shows", async (req, res) => {
  const shows = (await pool.query(`
    SELECT s.id, s.title, s.description, s.venue_id AS "venueId", s.rating, s.popularity, s.genres, s.poster_url AS "posterUrl"
    FROM shows s ORDER BY s.popularity DESC, s.id
  `)).rows;

  const sessions = (await pool.query(`
    SELECT id, show_id AS "showId", dateISO, timeISO, basePrice, dynamicFactor FROM sessions ORDER BY id
  `)).rows;

  const sessionsByShow = sessions.reduce((acc, ss) => {
    (acc[ss.showId] ||= []).push({
      id: ss.id,
      dateISO: ss.dateISO, timeISO: ss.timeISO,
      basePrice: ss.basePrice, dynamicFactor: Number(ss.dynamicFactor)
    });
    return acc;
  }, {});

  const out = shows.map(sh => ({
    ...sh,
    sessions: sessionsByShow[sh.id] || []
  }));

  res.json(out);
});

app.get("/api/occupied-seats", async (req, res) => {
  const sessionId = Number(req.query.sessionId);
  if (!sessionId) return res.status(400).json({ error: "sessionId_required" });
  const { rows } = await pool.query(`
    SELECT row, col FROM seat_occupancy WHERE session_id = $1 ORDER BY row, col
  `, [sessionId]);
  res.json(rows);
});

app.post("/api/promos/validate", async (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: "code_required" });
  const { rows } = await pool.query(`
    SELECT code, discount_percent AS "discountPercent", valid_until AS "validUntil"
    FROM promos WHERE LOWER(code)=LOWER($1) AND valid_until > NOW()
  `, [code]);
  if (rows.length === 0) return res.json(null);
  res.json(rows[0]);
});

app.post("/api/orders", async (req, res) => {
  try {
    const { orderId, form, items, totals } = req.body || {};
    if (!orderId || !items?.length || !totals) {
      return res.status(400).json({ error: "bad_payload" });
    }

    await pool.query('BEGIN');

    // сохраним заказ
    await pool.query(`
      INSERT INTO orders(id, buyer_name, buyer_email, totals_json)
      VALUES ($1, $2, $3, $4)
    `, [orderId, form?.name || null, form?.email || null, totals]);

    // позиции заказа и блокировка мест
    for (const it of items) {
      const row = it.seat?.row ?? null;
      const col = it.seat?.col ?? null;
      await pool.query(`
        INSERT INTO order_items(order_id, show_id, session_id, row, col, price)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [orderId, it.showId, it.sessionId, row, col, it.price || 0]);

      if (row != null && col != null) {
        await pool.query(`
          INSERT INTO seat_occupancy(session_id, row, col)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [it.sessionId, row, col]);
      }
    }

    await pool.query('COMMIT');
    res.status(201).json({ id: orderId });
  } catch (e) {
    await pool.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: "order_failed" });
  }
});

// Добавление новой записи через POST
app.post("/api/items", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "Name is required" });
    }

    const { rows } = await pool.query(
      "INSERT INTO items(name) VALUES ($1) RETURNING id, name, created_at",
      [name]
    );

    res.status(201).json(rows[0]); // возвращаем добавленную запись
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

const PORT = process.env.PORT || 3000;

ensureDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
  