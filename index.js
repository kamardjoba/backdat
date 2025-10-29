import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool, ensureDb } from "./lib/db.js";

dotenv.config();
const app = express();

app.use(cors());            // пока оставим открытым, потом можно ограничить доменом Netlify
app.use(express.json());

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
  