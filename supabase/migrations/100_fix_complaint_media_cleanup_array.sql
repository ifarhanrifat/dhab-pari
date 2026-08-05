-- Migration 100: 099's `v_removed := v_removed || 'photo'` raised "malformed
-- array literal" — Postgres resolved `||` against an untyped string literal
-- as array-literal-parsing rather than element-append, since text[] || unknown
-- is ambiguous. Caught by testing before the nightly cron ever ran. array_append()
-- is unambiguous.
CREATE OR REPLACE FUNCTION run_complaint_media_cleanup() RETURNS void AS $$
DECLARE
  r record;
  v_removed text[];
BEGIN
  FOR r IN
    SELECT id, complaint_id, photo_url, voice_url FROM complaint_updates
    WHERE created_at < now() - interval '1 month'
      AND (photo_url IS NOT NULL OR voice_url IS NOT NULL)
  LOOP
    v_removed := ARRAY[]::text[];
    IF r.photo_url IS NOT NULL THEN v_removed := array_append(v_removed, 'photo'); END IF;
    IF r.voice_url IS NOT NULL THEN v_removed := array_append(v_removed, 'voice message'); END IF;

    UPDATE complaint_updates SET photo_url = NULL, voice_url = NULL WHERE id = r.id;

    INSERT INTO complaint_updates (complaint_id, kind, body)
    VALUES (r.complaint_id, 'comment', 'Attachment(s) removed automatically — ' || array_to_string(v_removed, ' and ') || ' expired after the 1-month retention period.');
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
