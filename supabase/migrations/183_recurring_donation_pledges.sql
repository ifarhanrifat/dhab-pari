-- Migration 183: make a recurring donation behave like the announcement it is.
--
-- Two faults in the donation branch of run_recurring_schedule, both invisible
-- until you follow a donor through a second month:
--
--   1. payment_status was never set, so it fell to the column default 'paid'.
--      A schedule the donor set up in the portal therefore generated a row
--      claiming money had already been handed over, when in fact nothing had.
--      It showed as "Awaiting confirmation" instead of "Announced", and every
--      month quietly added to the amount the committee appeared to be sitting
--      on unconfirmed.
--
--   2. portal_user_id was never set. The donor's own statement lists pledges
--      with `WHERE portal_user_id = <me>`, so the generated announcement showed
--      up nowhere in their portal — no entry, no amount, and no "Pay Now"
--      button, because that button lives on the pledge row. The donor had no
--      way to see or settle what they had promised.
--
-- Staff-created schedules are unchanged: when a collector sets one up they are
-- recording money actually collected, so those still post verified and paid.
CREATE OR REPLACE FUNCTION run_recurring_schedule(p_schedule_id uuid) RETURNS void AS $$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_new_id uuid;
  v_next timestamptz;
  v_due_date date;
  v_complaint record;
  v_project varchar;
BEGIN
  SELECT * INTO s FROM recurring_schedules
  WHERE id = p_schedule_id AND is_active = true AND next_run_date <= now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_due_date := make_date(EXTRACT(YEAR FROM s.next_run_date)::int, EXTRACT(MONTH FROM s.next_run_date)::int, 7);

  IF s.schedule_type = 'bill' THEN
    INSERT INTO bills (consumer_id, month, year, amount_pkr, discount_amount, due_date, description, recurring_schedule_id)
    VALUES (s.consumer_id, EXTRACT(MONTH FROM s.next_run_date)::int, EXTRACT(YEAR FROM s.next_run_date)::int,
            s.amount_pkr, s.discount_amount, v_due_date, s.particular, s.id)
    ON CONFLICT (consumer_id, month, year) DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
      FOR v_complaint IN
        SELECT id FROM complaints WHERE system = 'water_supply' AND consumer_id = s.consumer_id AND status != 'verified' AND waiver_active = true
      LOOP
        PERFORM apply_complaint_waiver_to_bill(v_new_id, v_complaint.id);
      END LOOP;
    END IF;

  ELSIF s.schedule_type = 'donation' THEN
    INSERT INTO donors (
      name, name_ur, phone, donor_type, amount_pkr, date, payment_method, project_id,
      is_verified, is_anonymous, recurring_schedule_id, submitted_via,
      portal_user_id, payment_status
    )
    VALUES (
      s.donor_name, s.donor_name_ur, s.donor_phone, s.donor_type, s.amount_pkr, s.next_run_date::date,
      s.payment_method, s.project_id,
      s.created_by_portal_user_id IS NULL, false, s.id,
      CASE WHEN s.created_by_portal_user_id IS NULL THEN 'staff' ELSE 'public' END,
      -- so it reaches the donor's own statement and carries a Pay Now button
      s.created_by_portal_user_id,
      -- a donor-set schedule promises money; it does not deliver it
      CASE WHEN s.created_by_portal_user_id IS NULL THEN 'paid' ELSE 'pledged' END
    )
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL AND s.created_by_portal_user_id IS NULL THEN
      PERFORM assign_donor_numbers_internal(v_new_id);
    END IF;

    -- Tell the donor a new instalment is due. Without this the announcement
    -- appears silently and they only find out if they happen to open the portal.
    IF v_new_id IS NOT NULL AND s.created_by_portal_user_id IS NOT NULL THEN
      SELECT title INTO v_project FROM projects WHERE id = s.project_id;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (
        s.created_by_portal_user_id, 'recurring_due',
        'Your monthly donation is due',
        'Rs. ' || trim(to_char(s.amount_pkr, 'FM999999999990')) ||
          COALESCE(' for ' || v_project, '') ||
          ' — announced on ' || to_char(s.next_run_date, 'DD/MM/YYYY') || '. Open My Giving to pay.',
        '/portal/statement'
      );
    END IF;

  ELSIF s.schedule_type = 'expense' THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, recurring_schedule_id)
    VALUES (s.system, 'expense', s.next_run_date::date, COALESCE(s.particular, 'Recurring expense'), s.amount_pkr,
            s.from_account_id, s.to_account_id, s.party_name, s.id)
    RETURNING id INTO v_new_id;
  END IF;

  v_next := CASE s.frequency
    WHEN 'every_minute' THEN s.next_run_date + INTERVAL '1 minute'
    WHEN 'daily' THEN s.next_run_date + INTERVAL '1 day'
    WHEN 'weekly' THEN s.next_run_date + INTERVAL '7 days'
    WHEN 'monthly' THEN s.next_run_date + INTERVAL '1 month'
    WHEN 'semi_annual' THEN s.next_run_date + INTERVAL '6 months'
    WHEN 'yearly' THEN s.next_run_date + INTERVAL '1 year'
  END;

  UPDATE recurring_schedules SET
    next_run_date = v_next,
    last_run_at = now(),
    last_generated_type = s.schedule_type,
    last_generated_id = v_new_id
  WHERE id = p_schedule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('recurring_due', 'A recurring donation instalment falls due', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- Repair the rows already generated the wrong way: unverified, unpaid-in-fact
-- recurring donations that were recorded as 'paid' and orphaned from their
-- donor. Only rows created by a schedule, only ones still unverified, so
-- nothing a human confirmed is touched.
UPDATE donors d SET
  payment_status = 'pledged',
  portal_user_id = COALESCE(d.portal_user_id, rs.created_by_portal_user_id)
FROM recurring_schedules rs
WHERE d.recurring_schedule_id = rs.id
  AND rs.created_by_portal_user_id IS NOT NULL
  AND d.is_verified = false
  AND d.payment_status IS DISTINCT FROM 'pledged';
