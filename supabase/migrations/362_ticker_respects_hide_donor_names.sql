-- Migration 362: the donation thanks ticker (migration 205, guarded for
-- is_private by migration 360) exists specifically to name the donor
-- publicly — "X has donated Rs. Y for [project]". That's exactly what
-- hide_donor_names (migration 361) means to prevent, so a donation to a
-- project with hide_donor_names=true (without necessarily being fully
-- is_private) needs the same skip, not just the full-lockdown case.

CREATE OR REPLACE FUNCTION trg_donation_thanks_ticker() RETURNS trigger AS $$
DECLARE v_id uuid; v_hours int; v_is_private boolean; v_hide_names boolean;
BEGIN
  IF setting_text('donation_thanks_enabled', 'true') <> 'true' THEN RETURN NEW; END IF;
  IF NEW.is_verified IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_verified IS TRUE THEN RETURN NEW; END IF;

  IF NEW.project_id IS NOT NULL THEN
    SELECT is_private, hide_donor_names INTO v_is_private, v_hide_names FROM projects WHERE id = NEW.project_id;
    IF v_is_private OR v_hide_names THEN RETURN NEW; END IF;
  END IF;

  v_hours := COALESCE(nullif(setting_text('donation_thanks_hours', '24'), '')::int, 24);

  INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at)
  VALUES (
    donation_thanks_text(NEW.id, 'en'),
    donation_thanks_text(NEW.id, 'ur'),
    true, 0, now() + make_interval(hours => v_hours)
  ) RETURNING id INTO v_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
