-- 00_compat.sql
-- Доба́вляем отсутствующие колонки в venues и переносим данные из старых имён, если они есть.

-- 1) Добавить отсутствующие колонки
ALTER TABLE IF EXISTS venues
  ADD COLUMN IF NOT EXISTS city       TEXT,
  ADD COLUMN IF NOT EXISTS address    TEXT,
  ADD COLUMN IF NOT EXISTS rows_count INT,
  ADD COLUMN IF NOT EXISTS cols_count INT,
  ADD COLUMN IF NOT EXISTS seating_map JSONB;

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