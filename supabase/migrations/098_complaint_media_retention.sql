-- Migration 098: complaint voice messages and photo attachments are only kept
-- for 1 month after posting — after that they're removed from storage to keep
-- the shared 'attachments' bucket from growing unbounded. The complaint's text
-- timeline (who said what, when) is untouched and stays forever; only the
-- binary photo_url/voice_url on that specific update is cleared, and a short
-- system note is left in its place so staff aren't left wondering where an
-- attachment went. Assignees can view/listen to attachments normally any time
-- before the 1-month mark — nothing about viewing access changes, only the
-- expiry.
--
-- Scoped narrowly to complaint_updates rows specifically (not a blanket sweep
-- of the 'attachments' bucket by age) because that bucket is shared with bill
-- and purchase attachments (migration 053), which must never be auto-deleted.
--
-- Note: this deletes the storage.objects metadata row directly via SQL (the
-- same bucket/path FileAttachment.tsx and VoiceRecorder.tsx already write via
-- getPublicUrl()'s .../storage/v1/object/public/attachments/<path> format),
-- which immediately breaks the public URL and removes it from the dashboard's
-- file browser. It does not call the Storage REST API itself, so on Supabase
-- Cloud the underlying object bytes may not be reclaimed from the bucket's
-- billed usage until the platform's own reconciliation catches the orphaned
-- object — a known gap with deleting storage.objects rows via raw SQL instead
-- of the Storage API, since actually freeing billed bytes would need a
-- service-role authenticated HTTP call (via pg_net + a Vault-stored secret),
-- which needs one manual one-time setup step in the Supabase dashboard and is
-- intentionally left out of this migration rather than guessed at.

CREATE OR REPLACE FUNCTION run_complaint_media_cleanup() RETURNS void AS $$
DECLARE
  r record;
  v_path text;
  v_removed text[];
BEGIN
  FOR r IN
    SELECT id, complaint_id, photo_url, voice_url FROM complaint_updates
    WHERE created_at < now() - interval '1 month'
      AND (photo_url IS NOT NULL OR voice_url IS NOT NULL)
  LOOP
    v_removed := ARRAY[]::text[];

    IF r.photo_url IS NOT NULL THEN
      v_path := regexp_replace(r.photo_url, '^.*/storage/v1/object/public/attachments/', '');
      DELETE FROM storage.objects WHERE bucket_id = 'attachments' AND name = v_path;
      v_removed := v_removed || 'photo';
    END IF;

    IF r.voice_url IS NOT NULL THEN
      v_path := regexp_replace(r.voice_url, '^.*/storage/v1/object/public/attachments/', '');
      DELETE FROM storage.objects WHERE bucket_id = 'attachments' AND name = v_path;
      v_removed := v_removed || 'voice message';
    END IF;

    UPDATE complaint_updates SET photo_url = NULL, voice_url = NULL WHERE id = r.id;

    INSERT INTO complaint_updates (complaint_id, kind, body)
    VALUES (r.complaint_id, 'comment', 'Attachment(s) removed automatically — ' || array_to_string(v_removed, ' and ') || ' expired after the 1-month retention period.');
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

SELECT cron.schedule('complaint-media-cleanup', '0 4 * * *', $$SELECT run_complaint_media_cleanup()$$);
