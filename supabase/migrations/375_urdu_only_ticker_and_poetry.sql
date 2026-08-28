-- Migration 375: the news ticker (both the auto-generated donation
-- "thank you" messages and anything a publisher/admin writes by hand) is
-- now Urdu-only — no English version at all. message/message_ur both
-- stay in the schema (message is still NOT NULL, shared with older
-- rows), but from here on both columns get the same Urdu text; the
-- frontend (AnnouncementBar, /admin/ticker — see the app code changes
-- alongside this migration) only ever renders message_ur.
--
-- Poetry (news_posts, category='poetry') gets the same treatment,
-- handled entirely app-side (PostsManager.tsx mirrors title_ur/content_ur
-- into the NOT NULL title/content columns on save) — this migration just
-- backfills the one existing poem so it isn't left showing English until
-- someone happens to re-save it.

CREATE OR REPLACE FUNCTION trg_donation_thanks_ticker() RETURNS trigger AS $$
DECLARE v_id uuid; v_hours int; v_is_private boolean; v_hide_names boolean; v_text text;
BEGIN
  IF setting_text('donation_thanks_enabled', 'true') <> 'true' THEN RETURN NEW; END IF;
  IF NEW.is_verified IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_verified IS TRUE THEN RETURN NEW; END IF;

  IF NEW.project_id IS NOT NULL THEN
    SELECT is_private, hide_donor_names INTO v_is_private, v_hide_names FROM projects WHERE id = NEW.project_id;
    IF v_is_private OR v_hide_names THEN RETURN NEW; END IF;
  END IF;

  v_hours := COALESCE(nullif(setting_text('donation_thanks_hours', '24'), '')::int, 24);
  v_text := donation_thanks_text(NEW.id, 'ur');

  INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at)
  VALUES (v_text, v_text, true, 0, now() + make_interval(hours => v_hours))
  RETURNING id INTO v_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

UPDATE news_posts SET title = title_ur, content = content_ur
 WHERE category = 'poetry' AND title_ur IS NOT NULL AND content_ur IS NOT NULL;
