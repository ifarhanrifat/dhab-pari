-- Migration 360: the donation "thank you" ticker (migration 205) posts a
-- public message naming the donor and the project the moment ANY donation
-- is confirmed — it had no idea migration 359's is_private existed, so a
-- donation to a private/medical project would still announce itself
-- (donor name, amount, and the project's real title) to every visitor,
-- completely undermining the privacy the project row itself is protected
-- by. Caught live: the ticker was still showing "... for پرجیکٹ 8، فنڈ
-- ریزنگ قمر بھٹی میڈیکل ٹریٹمنٹ" after that project was marked private.

CREATE OR REPLACE FUNCTION trg_donation_thanks_ticker() RETURNS trigger AS $$
DECLARE v_id uuid; v_hours int; v_is_private boolean;
BEGIN
  IF setting_text('donation_thanks_enabled', 'true') <> 'true' THEN RETURN NEW; END IF;
  IF NEW.is_verified IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_verified IS TRUE THEN RETURN NEW; END IF;

  IF NEW.project_id IS NOT NULL THEN
    SELECT is_private INTO v_is_private FROM projects WHERE id = NEW.project_id;
    IF v_is_private THEN RETURN NEW; END IF;
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

-- Clean up whatever already leaked, from before this guard existed —
-- deactivate rather than delete, keeping the row as an audit trail.
UPDATE news_ticker SET is_active = false
WHERE is_active
  AND EXISTS (
    SELECT 1 FROM projects p
    WHERE p.is_private = true
      AND (news_ticker.message LIKE '%' || p.title || '%' OR news_ticker.message_ur LIKE '%' || COALESCE(p.title_ur, p.title) || '%')
  );
