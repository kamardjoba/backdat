-- 00_compat.sql
-- Доба́вляем отсутствующие колонки в venues и переносим данные из старых имён, если они есть.

-- 1) Добавить отсутствующие колонки
ALTER TABLE IF EXISTS venues
  ADD COLUMN IF NOT EXISTS city       TEXT,
  ADD COLUMN IF NOT EXISTS address    TEXT,
  ADD COLUMN IF NOT EXISTS rows_count INT,
  ADD COLUMN IF NOT EXISTS cols_count INT,
  ADD COLUMN IF NOT EXISTS seating_map JSONB;

-- === COMPAT: PROMOS (добавляем недостающие поля, если таблица уже существовала) ===
ALTER TABLE IF EXISTS promos
  ADD COLUMN IF NOT EXISTS discount_pct INT,
  ADD COLUMN IF NOT EXISTS valid_from   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_until  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_usage    INT,
  ADD COLUMN IF NOT EXISTS used_count   INT DEFAULT 0;

-- Индекс по сроку действия (если нет)
CREATE INDEX IF NOT EXISTS promos_valid_idx ON promos(valid_until);

-- 2) Если раньше были колонки "rows"/"cols", перенесём их значения в rows_count/cols_count (не затирая существующие)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='venues' AND column_name='rows'
  ) THEN
    EXECUTE 'UPDATE venues SET rows_count = COALESCE(rows_count, rows)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='venues' AND column_name='cols'
  ) THEN
    EXECUTE 'UPDATE venues SET cols_count = COALESCE(cols_count, cols)';
  END IF;
END$$;

-- 3) Если seating_map пусто, зададим пустой jsonb по умолчанию (не обязателен, но удобно)
UPDATE venues SET seating_map = '{}'::jsonb WHERE seating_map IS NULL;

-- Примечание:
-- Мы НЕ навешиваем здесь NOT NULL, чтобы миграция прошла мягко.
-- Основная схема в 01_schema.sql может иметь строгие ограничения; сначала выравниваем структуру.