-- Migration 064: Three additions to the field-collector workflow, all reusing
-- existing permission boundaries rather than introducing new roles/flags (per
-- explicit analysis before building this — a collector viewer already has
-- water_supply access and can already legally insert a 'manual' complaint).
--
--   1. Auto-notify a sector's collector(s) the moment a consumer newly
--      qualifies for the Non-Payment Report — the report itself stays a live,
--      client-computed view (migration/report page, unchanged), but a daily
--      sweep tracks who's flagged in a small table so it can tell "newly
--      flagged" apart from "still flagged from yesterday" and only notify
--      once per occurrence, not every single day.
--   2. A SECURITY DEFINER RPC letting a collector record a phone/WhatsApp
--      number for a consumer who doesn't have one on file yet — direct client
--      UPDATEs on `consumers` require `manage_parties`, which viewer-role
--      collectors don't have (by design, viewer is hard-blocked from every
--      permission in current_admin_permission()); this reuses the exact same
--      per-consumer authorization check the collector payment-insert RLS
--      already uses (current_admin_can_collect_for_consumer, migration 056).
--   3. A `category` column on `complaints` so a collector's quick "select the
--      issue from a dropdown" logging is filterable later, while the
--      complaint_text itself stays freely editable (per the spec: "select the
--      issue... then save it or edit it again").

-- 1a. Tracking table — not the source of truth for the report (the report
-- page keeps computing live), purely a "have we already notified about this
-- occurrence" ledger.
CREATE TABLE IF NOT EXISTS consumer_nonpayment_flags (
  consumer_id varchar PRIMARY KEY REFERENCES consumers(consumer_id) ON DELETE CASCADE,
  sector varchar,
  total_outstanding decimal NOT NULL DEFAULT 0,
  first_flagged_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE consumer_nonpayment_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "consumer_nonpayment_flags_read" ON consumer_nonpayment_flags FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
-- No client write policy — only the SECURITY DEFINER sweep function below
-- ever inserts/updates/deletes these rows.

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('consumer_flagged_nonpayment', 'A consumer newly qualifies for the 2-month Non-Payment Report', true, true)
ON CONFLICT (event_type) DO NOTHING;

-- 1b. The sweep — re-implements the exact same "flag" condition as the report
-- page (src/app/admin/(dashboard)/reports/non-payment/page.tsx): of an active
-- consumer's most recent two bills, both must be unpaid/partial AND for
-- consecutive calendar months. The total notified is summed across ALL of
-- that consumer's still-outstanding bills, not just the triggering two — the
-- same fix just applied to the report page itself, so the notified amount
-- and the report's displayed amount never disagree.
CREATE OR REPLACE FUNCTION run_nonpayment_flag_sweep() RETURNS void AS $$
DECLARE
  v_popup_enabled boolean;
  r record;
  h record;
BEGIN
  DROP TABLE IF EXISTS _np_current;
  CREATE TEMP TABLE _np_current AS
  WITH bill_calc AS (
    SELECT
      b.consumer_id,
      GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0) AS outstanding,
      ROW_NUMBER() OVER (PARTITION BY b.consumer_id ORDER BY b.year DESC, b.month DESC) AS rn,
      (b.year * 12 + b.month) AS ym
    FROM bills b
    JOIN consumers c ON c.consumer_id = b.consumer_id
    WHERE c.status = 'active'
  ),
  latest_two AS (
    SELECT consumer_id,
      COUNT(*) AS cnt,
      MAX(ym) FILTER (WHERE rn = 1) AS ym1,
      MAX(ym) FILTER (WHERE rn = 2) AS ym2,
      BOOL_AND(outstanding > 0) FILTER (WHERE rn <= 2) AS both_unpaid
    FROM bill_calc
    WHERE rn <= 2
    GROUP BY consumer_id
  ),
  flagged AS (
    SELECT lt.consumer_id
    FROM latest_two lt
    WHERE lt.cnt = 2 AND lt.both_unpaid AND (lt.ym1 - lt.ym2) = 1
  )
  SELECT bc.consumer_id, c.sector, SUM(bc.outstanding) AS total_outstanding
  FROM bill_calc bc
  JOIN consumers c ON c.consumer_id = bc.consumer_id
  WHERE bc.outstanding > 0 AND bc.consumer_id IN (SELECT consumer_id FROM flagged)
  GROUP BY bc.consumer_id, c.sector;

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'consumer_flagged_nonpayment';

  -- Newly flagged since the last sweep -> insert + notify sector collectors.
  FOR r IN SELECT * FROM _np_current WHERE consumer_id NOT IN (SELECT consumer_id FROM consumer_nonpayment_flags) LOOP
    INSERT INTO consumer_nonpayment_flags (consumer_id, sector, total_outstanding)
    VALUES (r.consumer_id, r.sector, r.total_outstanding);

    IF v_popup_enabled IS DISTINCT FROM false AND r.sector IS NOT NULL THEN
      FOR h IN
        SELECT id FROM admin_users
        WHERE is_active = true AND can_collect_payments = true AND r.sector = ANY(assigned_sectors)
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (h.id, 'consumer_flagged_nonpayment', 'Non-payment: ' || r.consumer_id,
          'Rs. ' || to_char(r.total_outstanding, 'FM999999990.00') || ' outstanding in ' || r.sector, '/admin/reports/non-payment');
      END LOOP;
    END IF;
  END LOOP;

  -- Still flagged from before -> just refresh the amount, no re-notify.
  UPDATE consumer_nonpayment_flags f
  SET total_outstanding = c.total_outstanding, last_checked_at = now()
  FROM _np_current c
  WHERE f.consumer_id = c.consumer_id;

  -- No longer meets the criteria (paid up) -> clear, so a future relapse
  -- notifies fresh instead of staying silent forever.
  DELETE FROM consumer_nonpayment_flags
  WHERE consumer_id NOT IN (SELECT consumer_id FROM _np_current);

  DROP TABLE _np_current;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

SELECT cron.schedule('nonpayment-flag-sweep', '0 8 * * *', $$SELECT run_nonpayment_flag_sweep()$$);

-- 2. Let a collector add a phone/WhatsApp number for a consumer who doesn't
-- have one, without granting them the broader manage_parties permission.
CREATE OR REPLACE FUNCTION set_consumer_contact_number(p_consumer_id varchar, p_mobile varchar) RETURNS void AS $$
BEGIN
  IF NOT (current_admin_permission('manage_parties') OR current_admin_can_collect_for_consumer(p_consumer_id)) THEN
    RAISE EXCEPTION 'Not authorized to update this consumer''s contact number.';
  END IF;
  UPDATE consumers SET
    mobile = p_mobile,
    whatsapp_number = COALESCE(NULLIF(whatsapp_number, ''), p_mobile)
  WHERE consumer_id = p_consumer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. Complaint category for the collector's quick-log dropdown.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS category varchar;
