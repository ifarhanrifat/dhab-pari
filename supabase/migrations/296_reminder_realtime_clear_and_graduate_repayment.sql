-- Migration 296: two fixes to the Reminders page (migration 077/136).
--
-- 1. Real-time clearing. run_reminder_sweep() only runs once a week
--    (Sunday), so a consumer who paid their bill on Monday, or a donor who
--    submitted proof of a pledge payment on Tuesday, still saw their old
--    reminder sitting on the page — untouched — until the following Sunday
--    regenerated the whole queue from scratch. Three small AFTER triggers
--    now delete the specific reminder the moment the underlying debt is
--    actually gone, instead of waiting for the weekly sweep to notice.
--
-- 2. A 5th reminder tier: graduated Taleemi Wazifa students (wazifa_students
--    .status = 'graduated') who still owe money back on a loan-type award
--    (or a voluntary zakat-family settlement) — reusing wazifa_loan_position(),
--    the same computation the student's own portal statement already uses,
--    rather than re-deriving "what's owed" a second time.

-- ── 1. reminder_queue: new type + wazifa reference columns ─────────────────
ALTER TABLE reminder_queue DROP CONSTRAINT IF EXISTS reminder_queue_reminder_type_check;
ALTER TABLE reminder_queue ADD CONSTRAINT reminder_queue_reminder_type_check
  CHECK (reminder_type IN ('bill_weekly', 'bill_defaulter', 'donor_recurring', 'meeting_due',
    'donor_pledge_unpaid', 'wazifa_repayment_due'));
ALTER TABLE reminder_queue
  ADD COLUMN IF NOT EXISTS wazifa_student_id uuid REFERENCES wazifa_students(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS wazifa_award_id uuid REFERENCES wazifa_awards(id) ON DELETE CASCADE;

DROP POLICY IF EXISTS "reminder_queue_read" ON reminder_queue;
CREATE POLICY "reminder_queue_read" ON reminder_queue FOR SELECT TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply'))
    OR (reminder_type IN ('donor_recurring', 'donor_pledge_unpaid', 'wazifa_repayment_due') AND can_access_system('donors_projects'))
    OR (reminder_type = 'meeting_due')
  );
DROP POLICY IF EXISTS "reminder_queue_update" ON reminder_queue;
CREATE POLICY "reminder_queue_update" ON reminder_queue FOR UPDATE TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply') AND current_admin_permission('post_transactions'))
    OR (reminder_type IN ('donor_recurring', 'donor_pledge_unpaid', 'wazifa_repayment_due') AND can_access_system('donors_projects') AND current_admin_permission('post_transactions'))
    OR (reminder_type = 'meeting_due')
  )
  WITH CHECK (true);

INSERT INTO message_templates (key, label, body) VALUES (
  'wazifa_graduate_repayment_reminder', 'Graduated Student Repayment Reminder',
  'Dear %%name%%, congratulations on completing your studies. Your Taleemi Wazifa support for %%academic_year%% still has Rs. %%outstanding%% outstanding — your next instalment of Rs. %%amount%% was due on %%due_date%%. Please arrange repayment when you can so we can support more students.'
) ON CONFLICT (key) DO NOTHING;

-- ── 2. run_reminder_sweep(): Tier 5 — graduated students with a repayment due ──
-- Full body carried forward from migration 136 (still the only prior
-- definition), with Tier 5 appended.
CREATE OR REPLACE FUNCTION run_reminder_sweep() RETURNS void AS $$
DECLARE
  v_weekly_body text;
  v_defaulter_body text;
  v_donor_body text;
  v_pledge_body text;
  v_graduate_body text;
  v_restore_fee text;
  r record;
BEGIN
  SELECT COALESCE(body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.')
    INTO v_weekly_body FROM message_templates WHERE key = 'bill_reminder_weekly';
  SELECT COALESCE(body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.')
    INTO v_defaulter_body FROM message_templates WHERE key = 'bill_defaulter_warning';
  SELECT COALESCE(body, 'Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.')
    INTO v_donor_body FROM message_templates WHERE key = 'donor_recurring_reminder';
  SELECT COALESCE(body, 'Dear %%name%%, you announced a pledge of Rs. %%amount%% on %%date%%. We haven''t received your payment yet — please pay at your earliest convenience and submit it from your portal so we can confirm it.')
    INTO v_pledge_body FROM message_templates WHERE key = 'donor_pledge_reminder';
  SELECT COALESCE(body, 'Dear %%name%%, congratulations on completing your studies. Your Taleemi Wazifa support for %%academic_year%% still has Rs. %%outstanding%% outstanding — your next instalment of Rs. %%amount%% was due on %%due_date%%. Please arrange repayment when you can so we can support more students.')
    INTO v_graduate_body FROM message_templates WHERE key = 'wazifa_graduate_repayment_reminder';
  SELECT COALESCE(value, '5000') INTO v_restore_fee FROM site_settings WHERE key = 'defaulter_restore_fee';
  v_weekly_body := COALESCE(v_weekly_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.');
  v_defaulter_body := COALESCE(v_defaulter_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.');
  v_donor_body := COALESCE(v_donor_body, 'Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.');
  v_pledge_body := COALESCE(v_pledge_body, 'Dear %%name%%, you announced a pledge of Rs. %%amount%% on %%date%%. We haven''t received your payment yet — please pay at your earliest convenience.');
  v_graduate_body := COALESCE(v_graduate_body, 'Dear %%name%%, congratulations on completing your studies. Your Taleemi Wazifa support for %%academic_year%% still has Rs. %%outstanding%% outstanding — your next instalment of Rs. %%amount%% was due on %%due_date%%. Please arrange repayment when you can.');
  v_restore_fee := COALESCE(v_restore_fee, '5000');

  -- Scoped to exclude meeting_due — migration 111's own sweep owns that tier.
  DELETE FROM reminder_queue WHERE status = 'pending' AND reminder_type != 'meeting_due';

  FOR r IN
    WITH outstanding_calc AS (
      SELECT b.consumer_id,
        SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)) AS outstanding,
        MAX(b.due_date) AS latest_due_date
      FROM bills b
      JOIN consumers c ON c.consumer_id = b.consumer_id
      WHERE c.status = 'active'
      GROUP BY b.consumer_id
      HAVING SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)) > 0
    )
    SELECT c.consumer_id, c.name, COALESCE(NULLIF(c.whatsapp_number, ''), c.mobile) AS phone, oc.outstanding, oc.latest_due_date
    FROM outstanding_calc oc JOIN consumers c ON c.consumer_id = oc.consumer_id
    WHERE oc.consumer_id NOT IN (SELECT consumer_id FROM consumer_nonpayment_flags)
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, consumer_id)
    VALUES ('bill_weekly', r.name, r.phone,
      replace(replace(replace(replace(v_weekly_body,
        '%%name%%', r.name), '%%consumer_id%%', r.consumer_id),
        '%%outstanding%%', to_char(r.outstanding, 'FM999999990.00')),
        '%%due_date%%', COALESCE(to_char(r.latest_due_date, 'DD Mon YYYY'), 'N/A')),
      r.outstanding, r.consumer_id);
  END LOOP;

  FOR r IN
    SELECT f.consumer_id, c.name, COALESCE(NULLIF(c.whatsapp_number, ''), c.mobile) AS phone, f.total_outstanding
    FROM consumer_nonpayment_flags f JOIN consumers c ON c.consumer_id = f.consumer_id
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, consumer_id)
    VALUES ('bill_defaulter', r.name, r.phone,
      replace(replace(replace(replace(v_defaulter_body,
        '%%name%%', r.name), '%%consumer_id%%', r.consumer_id),
        '%%outstanding%%', to_char(r.total_outstanding, 'FM999999990.00')),
        '%%restore_fee%%', v_restore_fee),
      r.total_outstanding, r.consumer_id);
  END LOOP;

  FOR r IN
    SELECT id, COALESCE(donor_name, 'Donor') AS donor_name, donor_phone, amount_pkr, next_run_date
    FROM recurring_schedules
    WHERE is_active = true AND schedule_type = 'donation' AND next_run_date <= now() + interval '7 days'
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, recurring_schedule_id)
    VALUES ('donor_recurring', r.donor_name, r.donor_phone,
      replace(replace(replace(v_donor_body,
        '%%name%%', r.donor_name),
        '%%amount%%', to_char(r.amount_pkr, 'FM999999990.00')),
        '%%due_date%%', to_char(r.next_run_date, 'DD Mon YYYY')),
      r.amount_pkr, r.id);
  END LOOP;

  FOR r IN
    SELECT id, name, COALESCE(NULLIF(whatsapp_number, ''), phone) AS phone, amount_pkr, date, portal_user_id
    FROM donors
    WHERE payment_status = 'pledged' AND is_verified = false
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, donor_id)
    VALUES ('donor_pledge_unpaid', r.name, r.phone,
      replace(replace(replace(v_pledge_body,
        '%%name%%', r.name),
        '%%amount%%', to_char(r.amount_pkr, 'FM999999990.00')),
        '%%date%%', to_char(r.date, 'DD Mon YYYY')),
      r.amount_pkr, r.id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'pledge_reminder', 'Unpaid Pledge Reminder',
        'You pledged Rs. ' || to_char(r.amount_pkr, 'FM999999990.00') || ' — pay it anytime from your portal.',
        '/portal/statement');
    END IF;
  END LOOP;

  -- Tier 5: graduated students with a loan/settlement instalment due within
  -- the next 7 days (or already overdue). wazifa_loan_position() already
  -- knows which award type actually owes anything (a plain grant always
  -- comes back 0) — reused rather than re-derived here.
  FOR r IN
    SELECT s.id AS student_id, s.full_name, s.phone,
      a.id AS award_id, a.academic_year, a.installment_active,
      (wazifa_loan_position(a.id) ->> 'outstanding')::decimal AS outstanding,
      (wazifa_loan_position(a.id) ->> 'next_due_on')::date AS next_due_on
    FROM wazifa_students s
    JOIN wazifa_awards a ON a.student_id = s.id
    WHERE s.status = 'graduated' AND a.status <> 'cancelled'
  LOOP
    IF r.outstanding IS NULL OR r.outstanding <= 0 OR r.next_due_on IS NULL
       OR r.next_due_on > (now() AT TIME ZONE 'Asia/Karachi')::date + interval '7 days' THEN
      CONTINUE;
    END IF;

    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, wazifa_student_id, wazifa_award_id)
    VALUES ('wazifa_repayment_due', r.full_name, r.phone,
      replace(replace(replace(replace(replace(v_graduate_body,
        '%%name%%', r.full_name), '%%academic_year%%', r.academic_year),
        '%%outstanding%%', to_char(r.outstanding, 'FM999999990.00')),
        '%%amount%%', to_char(COALESCE((CASE WHEN r.installment_active
          THEN (SELECT amount_pkr - paid_pkr FROM wazifa_installment_charges WHERE award_id = r.award_id AND status IN ('due', 'part_paid') ORDER BY due_on LIMIT 1)
          ELSE (SELECT amount_pkr FROM wazifa_repayment_schedule WHERE award_id = r.award_id AND status IN ('due', 'part_paid') ORDER BY due_on LIMIT 1) END), r.outstanding), 'FM999999990.00')),
        '%%due_date%%', to_char(r.next_due_on, 'DD Mon YYYY')),
      r.outstanding, r.student_id, r.award_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── 3. Real-time clearing — delete the specific reminder the moment the
--    debt it was about is actually gone, instead of waiting for Sunday ────

-- 3a. Consumer bills: fires after every payment row (billing page, portal
-- payment-claim approval, collector settlement — every path posts through
-- this same table). Bill's paid_amount/status is already current by the
-- time this AFTER trigger runs, since trg_payment_ledger (BEFORE INSERT)
-- updated it earlier in the same statement.
CREATE OR REPLACE FUNCTION trg_payment_clear_reminder() RETURNS trigger AS $$
DECLARE
  v_still_outstanding decimal;
BEGIN
  SELECT COALESCE(SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)), 0)
    INTO v_still_outstanding FROM bills b WHERE b.consumer_id = NEW.consumer_id;

  IF v_still_outstanding <= 0 THEN
    DELETE FROM reminder_queue
    WHERE consumer_id = NEW.consumer_id AND status = 'pending'
      AND reminder_type IN ('bill_weekly', 'bill_defaulter');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS payment_clear_reminder_trigger ON payments;
CREATE TRIGGER payment_clear_reminder_trigger AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_payment_clear_reminder();

-- 3b. Donor pledges: fires once the donor's own payment_status moves off
-- 'pledged' (they submitted proof from the portal, or staff recorded it
-- directly) or once staff verifies/confirms the donation outright.
CREATE OR REPLACE FUNCTION trg_donor_clear_reminder() RETURNS trigger AS $$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM 'pledged' OR NEW.is_verified = true THEN
    DELETE FROM reminder_queue
    WHERE donor_id = NEW.id AND status = 'pending' AND reminder_type = 'donor_pledge_unpaid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS donor_clear_reminder_trigger ON donors;
CREATE TRIGGER donor_clear_reminder_trigger AFTER UPDATE OF payment_status, is_verified ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donor_clear_reminder();

-- 3c. Graduated students: fires once a repayment instalment is marked paid
-- (whichever of the two schedule tables the award actually uses) — if the
-- award has nothing left outstanding, the reminder for it goes too.
CREATE OR REPLACE FUNCTION trg_wazifa_repayment_clear_reminder() RETURNS trigger AS $$
DECLARE
  v_outstanding decimal;
BEGIN
  IF NEW.status = 'paid' THEN
    v_outstanding := (wazifa_loan_position(NEW.award_id) ->> 'outstanding')::decimal;
    IF COALESCE(v_outstanding, 0) <= 0 THEN
      DELETE FROM reminder_queue
      WHERE wazifa_award_id = NEW.award_id AND status = 'pending' AND reminder_type = 'wazifa_repayment_due';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS wazifa_repayment_schedule_clear_reminder_trigger ON wazifa_repayment_schedule;
CREATE TRIGGER wazifa_repayment_schedule_clear_reminder_trigger AFTER UPDATE OF status ON wazifa_repayment_schedule
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_repayment_clear_reminder();

DROP TRIGGER IF EXISTS wazifa_installment_charges_clear_reminder_trigger ON wazifa_installment_charges;
CREATE TRIGGER wazifa_installment_charges_clear_reminder_trigger AFTER UPDATE OF status ON wazifa_installment_charges
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_repayment_clear_reminder();
