-- зоны и площадка
INSERT INTO venues(name, city, address, rows_count, cols_count, seating_map)
VALUES ('Main Arena', 'Warsaw', 'Downtown 1', 12, 18, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- zones
INSERT INTO price_zones(venue_id, code, name, base_color)
SELECT v.id, z.code, z.name, z.color
FROM (VALUES ('VIP','VIP','#d97706'), ('A','Zone A','#16a34a'), ('B','Zone B','#2563eb')) AS z(code,name,color),
     (SELECT id FROM venues WHERE name='Main Arena' LIMIT 1) v
ON CONFLICT DO NOTHING;

-- seats grid (простая схема: ряды 1-3 VIP, 4-7 A, 8-12 B)
DO $$
DECLARE
  v_id INT := (SELECT id FROM venues WHERE name='Main Arena' LIMIT 1);
  r INT; c INT; zone TEXT;
BEGIN
  IF v_id IS NOT NULL THEN
    FOR r IN 1..12 LOOP
      zone := CASE WHEN r <= 3 THEN 'VIP' WHEN r <= 7 THEN 'A' ELSE 'B' END;
      FOR c IN 1..18 LOOP
        INSERT INTO venue_seats(venue_id, row_number, seat_number, zone_code, seat_type)
        VALUES (v_id, r, c, zone, 'seat')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END IF;
END$$;

-- artist
INSERT INTO artists(name, genre, bio, photo_url)
VALUES ('Imagine Dragons', 'Rock', 'American pop rock band', NULL)
ON CONFLICT DO NOTHING;

-- event (с ближайшей датой)
INSERT INTO events(artist_id, venue_id, starts_at, title, status)
SELECT a.id, v.id, NOW() + INTERVAL '14 days', 'Imagine Dragons — Live', 'scheduled'
FROM artists a, venues v
WHERE a.name='Imagine Dragons' AND v.name='Main Arena'
ON CONFLICT DO NOTHING;

-- event prices по зонам
INSERT INTO event_prices(event_id, zone_code, base_price, multiplier)
SELECT e.id, 'VIP', 299.00, 1.10 FROM events e WHERE e.title LIKE 'Imagine Dragons%' ON CONFLICT DO NOTHING;
INSERT INTO event_prices(event_id, zone_code, base_price, multiplier)
SELECT e.id, 'A',   199.00, 1.00 FROM events e WHERE e.title LIKE 'Imagine Dragons%' ON CONFLICT DO NOTHING;
INSERT INTO event_prices(event_id, zone_code, base_price, multiplier)
SELECT e.id, 'B',   129.00, 1.00 FROM events e WHERE e.title LIKE 'Imagine Dragons%' ON CONFLICT DO NOTHING;

-- availability инициализация
DO $$
DECLARE
  e_id INT := (SELECT id FROM events WHERE title LIKE 'Imagine Dragons%' LIMIT 1);
BEGIN
  IF e_id IS NOT NULL THEN
    INSERT INTO seat_availability(event_id, seat_id, status)
    SELECT e_id, vs.id, 'available'
    FROM venue_seats vs
    WHERE vs.venue_id = (SELECT venue_id FROM events WHERE id = e_id)
    ON CONFLICT DO NOTHING;
  END IF;
END$$;

-- промо
INSERT INTO promos(code, discount_pct, valid_from, valid_until, max_usage)
VALUES ('HELLO10', 10, NOW(), NOW() + INTERVAL '60 days', 100)
ON CONFLICT DO NOTHING;