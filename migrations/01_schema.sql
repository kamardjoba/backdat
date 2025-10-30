-- ARTISTS
CREATE TABLE IF NOT EXISTS artists (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  genre        TEXT,
  bio          TEXT,
  photo_url    TEXT,
  socials_json JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- VENUES
CREATE TABLE IF NOT EXISTS venues (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  address     TEXT,
  rows_count  INT NOT NULL,
  cols_count  INT NOT NULL,
  seating_map JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- SEATS (перманентная сетка мест площадки)
CREATE TABLE IF NOT EXISTS venue_seats (
  id          SERIAL PRIMARY KEY,
  venue_id    INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  row_number  INT NOT NULL,
  seat_number INT NOT NULL,
  zone_code   TEXT NOT NULL,
  seat_type   TEXT NOT NULL DEFAULT 'seat',
  UNIQUE(venue_id, row_number, seat_number)
);

-- ZONES (метаданные зон)
CREATE TABLE IF NOT EXISTS price_zones (
  id         SERIAL PRIMARY KEY,
  venue_id   INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name       TEXT,
  base_color TEXT DEFAULT '#999999',
  UNIQUE(venue_id, code)
);

-- EVENTS (концерты)
CREATE TABLE IF NOT EXISTS events (
  id           SERIAL PRIMARY KEY,
  artist_id    INT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  venue_id     INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  starts_at    TIMESTAMPTZ NOT NULL,
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'scheduled',
  dynamic_cfg  JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- PRICES for event (per zone)
CREATE TABLE IF NOT EXISTS event_prices (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  zone_code   TEXT NOT NULL,
  base_price  NUMERIC(10,2) NOT NULL,
  multiplier  NUMERIC(6,2) NOT NULL DEFAULT 1.00,
  UNIQUE(event_id, zone_code)
);

-- AVAILABILITY (быстрый статус мест на событии)
CREATE TABLE IF NOT EXISTS seat_availability (
  event_id     INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seat_id      INT NOT NULL REFERENCES venue_seats(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,  -- available/hold/booked
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (event_id, seat_id)
);

-- HOLDS (временная блокировка мест)
CREATE TABLE IF NOT EXISTS holds (
  id           UUID PRIMARY KEY,
  event_id     INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seat_id      INT NOT NULL REFERENCES venue_seats(id) ON DELETE CASCADE,
  user_token   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, seat_id)
);

-- PROMOS
CREATE TABLE IF NOT EXISTS promos (
  code          TEXT PRIMARY KEY,
  discount_pct  INT CHECK (discount_pct BETWEEN 0 AND 100),
  valid_from    TIMESTAMPTZ NOT NULL,
  valid_until   TIMESTAMPTZ NOT NULL,
  max_usage     INT,
  used_count    INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS promos_valid_idx ON promos(valid_until);

CREATE TABLE IF NOT EXISTS promo_usages (
  id        SERIAL PRIMARY KEY,
  code      TEXT REFERENCES promos(code) ON DELETE SET NULL,
  order_id  UUID,
  used_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY,
  event_id      INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  buyer_name    TEXT NOT NULL,
  buyer_email   TEXT NOT NULL,
  promo_code    TEXT REFERENCES promos(code),
  subtotal      NUMERIC(10,2) NOT NULL,
  discount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  total         NUMERIC(10,2) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id        SERIAL PRIMARY KEY,
  order_id  UUID REFERENCES orders(id) ON DELETE CASCADE,
  seat_id   INT NOT NULL REFERENCES venue_seats(id),
  price     NUMERIC(10,2) NOT NULL
);

-- PAYMENTS (без интеграции — храним факт)
CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  provider_id   TEXT,
  amount        NUMERIC(10,2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'PLN',
  status        TEXT NOT NULL,
  payload_json  JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- USERS / AUDIT (резерв под админку)
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  meta_json   JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);