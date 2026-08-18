-- Migration 276: the zakat-track's interim support — 1 to 12 months, paid
-- monthly, stoppable at any point on a real report the student has left.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Reusing wazifa_instalments rather than inventing a parallel payment path
-- ═════════════════════════════════════════════════════════════════════════
-- The temptation was a whole new payout table with its own posting
-- function, mirroring wazifa_pay_instalment() line for line. Better not to:
-- an interim-grant month IS a wazifa_instalment — purpose 'stipend' already
-- exists for exactly this, pay_to institution/student/hostel already exists
-- (migration 274), and wazifa_pay_instalment() already posts the voucher,
-- routes zakat-funded amounts to the student (tamleek), and lands on the
-- student's own subsidiary account. This table is the *policy* — how many
-- months, how much, where to — and its monthly job raises ordinary
-- wazifa_instalments rows against that policy. Paying one is unchanged;
-- nothing new to learn on the accountant's side.
CREATE TABLE IF NOT EXISTS wazifa_interim_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  months_awarded int NOT NULL CHECK (months_awarded BETWEEN 1 AND 12),
  monthly_amount_pkr decimal NOT NULL CHECK (monthly_amount_pkr > 0),
  pay_to varchar NOT NULL DEFAULT 'institution' CHECK (pay_to IN ('institution', 'student', 'hostel')),
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  started_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Karachi')::date,
  stopped_reason text,
  stopped_by uuid REFERENCES admin_users(id),
  stopped_at timestamptz,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_interim_grant_award_idx ON wazifa_interim_grant(award_id, status);

ALTER TABLE wazifa_interim_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY wazifa_interim_grant_admin ON wazifa_interim_grant FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
CREATE POLICY wazifa_interim_grant_own ON wazifa_interim_grant FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_interim_grant.award_id AND s.portal_user_id = current_portal_user_id()));

-- Which wazifa_instalments row belongs to which grant, so the monthly job
-- knows how many months it has already raised and the stop action knows
-- what to cancel.
ALTER TABLE wazifa_instalments ADD COLUMN IF NOT EXISTS interim_grant_id uuid REFERENCES wazifa_interim_grant(id) ON DELETE SET NULL;

-- ── Starting one — only for a confirmed zakat-family award, only a loan
--    (there is nothing to defer repayment on for a grant, and grants no
--    longer exist as of migration 274 anyway, but the check stays explicit
--    rather than relying on that alone) ──────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_start_interim_grant(
  p_award_id uuid, p_months int, p_monthly_amount decimal, p_pay_to varchar DEFAULT 'institution'
) RETURNS jsonb AS $$
DECLARE aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; v_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  IF NOT st.is_zakat_family THEN
    RAISE EXCEPTION 'Interim support is for a confirmed zakat family — screen and confirm the match first.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT aw.is_loan THEN
    RAISE EXCEPTION 'This award was not decided as repayable.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM wazifa_interim_grant WHERE award_id = p_award_id AND status = 'active') THEN
    RAISE EXCEPTION 'An interim support plan is already active for this award.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO wazifa_interim_grant (award_id, months_awarded, monthly_amount_pkr, pay_to, created_by)
  VALUES (p_award_id, p_months, p_monthly_amount, p_pay_to, current_admin_user_id())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('grant_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_start_interim_grant(uuid, int, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_start_interim_grant(uuid, int, decimal, varchar) TO authenticated;

-- ── Raising the month, capped at what was actually awarded ───────────────
CREATE OR REPLACE FUNCTION wazifa_interim_grant_run() RETURNS jsonb AS $$
DECLARE v_month date; v_count int := 0; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT g.id AS grant_id, g.award_id, g.monthly_amount_pkr, g.pay_to,
           (SELECT count(*) FROM wazifa_instalments i WHERE i.interim_grant_id = g.id
             AND i.status <> 'cancelled') AS raised_so_far,
           g.months_awarded
      FROM wazifa_interim_grant g
     WHERE g.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM wazifa_instalments i WHERE i.interim_grant_id = g.id
                         AND i.due_on >= v_month AND i.due_on < v_month + interval '1 month'
                         AND i.status <> 'cancelled')
  LOOP
    IF r.raised_so_far >= r.months_awarded THEN
      UPDATE wazifa_interim_grant SET status = 'completed' WHERE id = r.grant_id;
      CONTINUE;
    END IF;

    INSERT INTO wazifa_instalments (award_id, purpose, description, due_on, amount_pkr, pay_to, interim_grant_id)
    VALUES (r.award_id, 'stipend', 'Interim support — month ' || (r.raised_so_far + 1) || ' of ' || r.months_awarded,
            v_month, r.monthly_amount_pkr, r.pay_to, r.grant_id);
    v_count := v_count + 1;

    IF r.raised_so_far + 1 >= r.months_awarded THEN
      UPDATE wazifa_interim_grant SET status = 'completed' WHERE id = r.grant_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('raised', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_interim_grant_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_interim_grant_run() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('wazifa-interim-grant-run', '25 4 * * *', 'SELECT wazifa_interim_grant_run()');
  RAISE NOTICE 'pg_cron: zakat-track interim support raised daily at 09:25 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run wazifa_interim_grant_run() by hand. %', SQLERRM;
END $$;

-- ── Stopping one — the whole reason this exists as a plan rather than a
--    lump sum. Cancels only what has not been paid yet; a month already
--    paid stays paid. ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_stop_interim_grant(p_grant_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE v_cancelled int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Write why this is being stopped — the file should say what was reported.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_instalments SET status = 'cancelled'
   WHERE interim_grant_id = p_grant_id AND status = 'scheduled';
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE wazifa_interim_grant
     SET status = 'stopped', stopped_reason = p_reason,
         stopped_by = current_admin_user_id(), stopped_at = now()
   WHERE id = p_grant_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not an active interim support plan.' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object('ok', true, 'unpaid_months_cancelled', v_cancelled);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_stop_interim_grant(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_stop_interim_grant(uuid, text) TO authenticated;
