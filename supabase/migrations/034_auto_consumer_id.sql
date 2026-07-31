-- Migration 034: Auto-generate consumer_id (continuing the existing DP-NNNN
-- pattern) instead of letting it be typed manually — a mistyped or duplicated ID
-- would silently corrupt every downstream link (bills, payments, accounts all key
-- off this value).

CREATE SEQUENCE IF NOT EXISTS consumer_id_seq;
SELECT setval('consumer_id_seq', GREATEST(
  COALESCE((SELECT MAX(CAST(substring(consumer_id FROM 'DP-(\d+)$') AS int)) FROM consumers WHERE consumer_id ~ '^DP-\d+$'), 1000),
  1000
));

CREATE OR REPLACE FUNCTION next_consumer_id() RETURNS varchar AS $$
  SELECT 'DP-' || nextval('consumer_id_seq')::text;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION trg_consumer_assign_id() RETURNS trigger AS $$
BEGIN
  IF NEW.consumer_id IS NULL OR trim(NEW.consumer_id) = '' THEN
    NEW.consumer_id := next_consumer_id();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS consumer_assign_id_trigger ON consumers;
CREATE TRIGGER consumer_assign_id_trigger BEFORE INSERT ON consumers
  FOR EACH ROW EXECUTE FUNCTION trg_consumer_assign_id();
