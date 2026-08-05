-- Migration 099: 098's cleanup function tried `DELETE FROM storage.objects`
-- directly — Supabase blocks that outright (storage.protect_delete() trigger:
-- "Direct deletion from storage tables is not allowed. Use the Storage API
-- instead."), confirmed by testing against the live database. Since the whole
-- function ran as one transaction, that error would have aborted EVERY row in
-- a given night's run, silently skipping even the safe part (clearing the
-- URLs) — not a partial success, a total no-op every night.
--
-- Actually deleting the underlying file bytes requires an authenticated call
-- to the Storage REST API (via pg_net + a service-role secret in Supabase
-- Vault) — infrastructure this migration deliberately does not set up, since
-- it needs one manual step in the Supabase dashboard (storing the service
-- role key in Vault) that only the project owner can safely do; it should
-- never be pasted into a chat or committed to a migration file.
--
-- Until that's set up, this does the part that's fully within reach and
-- matches what's actually user-visible: after 1 month, the photo/voice link
-- on that complaint update is cleared (so it stops rendering/being servable
-- in the app), and a note is left explaining why. The file itself stays in
-- the 'attachments' bucket (not billed-storage-neutral, just app-inaccessible)
-- until a Storage-API-based follow-up is added.
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
    IF r.photo_url IS NOT NULL THEN v_removed := v_removed || 'photo'; END IF;
    IF r.voice_url IS NOT NULL THEN v_removed := v_removed || 'voice message'; END IF;

    UPDATE complaint_updates SET photo_url = NULL, voice_url = NULL WHERE id = r.id;

    INSERT INTO complaint_updates (complaint_id, kind, body)
    VALUES (r.complaint_id, 'comment', 'Attachment(s) removed automatically — ' || array_to_string(v_removed, ' and ') || ' expired after the 1-month retention period.');
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
