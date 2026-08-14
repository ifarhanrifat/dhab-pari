-- Migration 226: who keeps it working, and what that costs each month.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Three answers, three different behaviours
-- ═════════════════════════════════════════════════════════════════════════
-- Migration 210 already recorded the choice; nothing acted on it. A donor who
-- picked "I will look after it" was never billed, and a committee that
-- accepted twenty coolers had no mechanism for the electricity.
--
--   donor      The running cost is charged to them monthly. They are warned
--              before the month turns, the charge appears on the 1st as
--              announced — not as money received — and it stays announced
--              until they actually pay it.
--
--   committee  The committee carries it. Where that is a real monthly number
--              it is put on the website as a shared recurring cost so other
--              villagers can take a piece of it, which is exactly what the
--              Mushtarka Kafalat pool from migration 222 already does.
--
--   endowed    A lump sum was given and the committee draws it down. The
--              donor is deliberately never messaged about this object again —
--              that silence is what they paid for.

ALTER TABLE sadqa_objects
  ADD COLUMN IF NOT EXISTS maintenance_monthly_pkr decimal,
  ADD COLUMN IF NOT EXISTS maintenance_starts_on date,
  ADD COLUMN IF NOT EXISTS maintenance_pool_id uuid REFERENCES support_pools(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS endowment_drawn_pkr decimal NOT NULL DEFAULT 0;

-- The monthly figure, derived from the annual one unless it was set by hand.
CREATE OR REPLACE FUNCTION sadqa_monthly_cost(p_object_id uuid) RETURNS decimal AS $$
  SELECT COALESCE(maintenance_monthly_pkr, round(annual_running_cost_pkr / 12), 0)
    FROM sadqa_objects WHERE id = p_object_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION sadqa_monthly_cost(uuid) TO authenticated;

-- ── What the donor owes, month by month ──────────────────────────────────
-- A separate table rather than reusing `donors`, because an upkeep charge is
-- the committee billing the donor, not the donor giving. It only becomes a
-- donation when it is paid.
CREATE TABLE IF NOT EXISTS sadqa_upkeep_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES sadqa_objects(id) ON DELETE CASCADE,
  month date NOT NULL,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  -- 'announced' is the same word the donation labels use, so the donor sees
  -- one vocabulary across their whole statement rather than two.
  status varchar NOT NULL DEFAULT 'announced'
    CHECK (status IN ('announced', 'paid', 'waived', 'cancelled')),
  due_on date NOT NULL,
  paid_on date,
  donor_id uuid REFERENCES donors(id) ON DELETE SET NULL,
  waived_reason text,
  reminded_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE (object_id, month)
);

CREATE INDEX IF NOT EXISTS sadqa_upkeep_month_idx ON sadqa_upkeep_charges(object_id, status);

-- ═════════════════════════════════════════════════════════════════════════
-- The monthly run
-- ═════════════════════════════════════════════════════════════════════════
-- Two jobs in one, deliberately, because they are two halves of the same
-- promise: warn before the month turns, then raise the charge when it does.
-- Both are idempotent, so running the job twice on the same day changes
-- nothing.
CREATE OR REPLACE FUNCTION sadqa_upkeep_run() RETURNS jsonb AS $$
DECLARE
  r record; v_today date; v_next_month date; v_charged int := 0; v_warned int := 0;
  v_amount decimal;
BEGIN
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_next_month := (date_trunc('month', v_today) + interval '1 month')::date;

  -- ── The warning, in the last five days of the month ──────────────────
  IF v_today >= (v_next_month - interval '5 days')::date THEN
    FOR r IN
      SELECT o.id, o.item_name, o.object_no, o.portal_user_id
        FROM sadqa_objects o
       WHERE o.maintenance_mode = 'donor'
         AND o.portal_user_id IS NOT NULL
         AND o.status IN ('installed', 'in_service', 'needs_repair')
         AND sadqa_monthly_cost(o.id) > 0
         AND NOT EXISTS (SELECT 1 FROM sadqa_upkeep_charges c
                          WHERE c.object_id = o.id AND c.month = v_next_month)
    LOOP
      v_amount := sadqa_monthly_cost(r.id);
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'sadqa_upkeep_due',
              'Upkeep due on the 1st — ' || r.item_name,
              'اگلے مہینے کی پہلی تاریخ کو ' || trim(to_char(v_amount, 'FM999,999,990'))
                || ' روپے دیکھ بھال کی مد میں واجب الادا ہوں گے۔' || E'\n\n'
                || 'Rs ' || trim(to_char(v_amount, 'FM999,999,990'))
                || ' for the upkeep of ' || r.item_name || ' (' || r.object_no
                || ') falls due on the 1st.',
              '/portal/esal-e-sawab');
      v_warned := v_warned + 1;
    END LOOP;
  END IF;

  -- ── The charge, once the month has turned ────────────────────────────
  FOR r IN
    SELECT o.id, o.item_name, o.object_no, o.portal_user_id
      FROM sadqa_objects o
     WHERE o.maintenance_mode = 'donor'
       AND o.status IN ('installed', 'in_service', 'needs_repair')
       AND sadqa_monthly_cost(o.id) > 0
       AND COALESCE(o.maintenance_starts_on, o.installed_on, o.created_at::date)
             <= date_trunc('month', v_today)::date
       AND NOT EXISTS (SELECT 1 FROM sadqa_upkeep_charges c
                        WHERE c.object_id = o.id AND c.month = date_trunc('month', v_today)::date)
  LOOP
    v_amount := sadqa_monthly_cost(r.id);
    INSERT INTO sadqa_upkeep_charges (object_id, month, amount_pkr, due_on, status)
    VALUES (r.id, date_trunc('month', v_today)::date, v_amount,
            date_trunc('month', v_today)::date, 'announced');
    v_charged := v_charged + 1;
  END LOOP;

  RETURN jsonb_build_object('warned', v_warned, 'charged', v_charged, 'as_at', v_today);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION sadqa_upkeep_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sadqa_upkeep_run() TO authenticated;

-- Paying one. Only now does it become a donation and touch the ledger — an
-- announced charge is a statement of what is coming, not money.
CREATE OR REPLACE FUNCTION sadqa_pay_upkeep(
  p_charge_id uuid, p_method varchar, p_proof_url text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE c sadqa_upkeep_charges%ROWTYPE; o sadqa_objects%ROWTYPE; v_donor_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM sadqa_upkeep_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'announced' THEN
    RAISE EXCEPTION 'This charge is already %.', c.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = c.object_id;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified, payment_method,
                      is_anonymous, fund_type, portal_user_id, payment_status,
                      payment_proof_url, notes, submitted_via)
  VALUES (o.donor_name, o.donor_name_ur, o.donor_phone, c.amount_pkr,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method,
          o.donor_is_anonymous, 'esal_e_sawab', o.portal_user_id, 'paid', p_proof_url,
          'Sadqa-e-Jariya upkeep — ' || o.item_name || ' (' || o.object_no || ') · '
            || to_char(c.month, 'Mon YYYY') || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  -- Same label as every other line on their statement.
  UPDATE ledger_entries
     SET particular = 'Sadqa-e-Jariya upkeep — ' || o.item_name || ' (' || o.object_no || ') · '
                      || to_char(c.month, 'Mon YYYY')
   WHERE reference_type = 'donation' AND reference_id = v_donor_id;

  UPDATE sadqa_upkeep_charges
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, donor_id = v_donor_id
   WHERE id = p_charge_id;

  RETURN jsonb_build_object('paid', c.amount_pkr, 'month', c.month, 'donor_id', v_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION sadqa_pay_upkeep(uuid, varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sadqa_pay_upkeep(uuid, varchar, text, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Committee-borne upkeep, shared out
-- ═════════════════════════════════════════════════════════════════════════
-- Accepting the cost is not the same as being able to pay it. Where the
-- committee has taken on a real monthly bill, this puts it on the website as
-- a pool other villagers can join — the same machinery as Mushtarka Kafalat,
-- so it appears in every donor's portal until enough people have joined.
CREATE OR REPLACE FUNCTION sadqa_publish_upkeep_pool(p_object_id uuid, p_share_pkr decimal DEFAULT 500)
RETURNS jsonb AS $$
DECLARE o sadqa_objects%ROWTYPE; v_pool uuid; v_monthly decimal; v_code varchar;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.maintenance_mode <> 'committee' THEN
    RAISE EXCEPTION 'Only an object the committee has taken on can be shared out this way.'
      USING ERRCODE = 'P0001';
  END IF;
  IF o.maintenance_pool_id IS NOT NULL THEN
    RETURN jsonb_build_object('pool_id', o.maintenance_pool_id, 'already', true);
  END IF;

  v_monthly := sadqa_monthly_cost(p_object_id);
  IF v_monthly <= 0 THEN
    RAISE EXCEPTION 'This object has no running cost recorded, so there is nothing to share.'
      USING ERRCODE = 'P0001';
  END IF;

  v_code := 'POOL-' || o.object_no;
  INSERT INTO support_pools (code, name, name_ur, kind, fund_type,
                             manual_monthly_target_pkr, suggested_share_pkr, min_share_pkr,
                             description, description_ur)
  VALUES (v_code,
          'Upkeep — ' || o.item_name, COALESCE(o.item_name_ur, o.item_name),
          -- Never ask one person for more than the whole bill: a share of
          -- 200 against a 125 monthly cost reads as though nobody checked.
          'general', 'sadqa', v_monthly,
          LEAST(GREATEST(p_share_pkr, 100), v_monthly), LEAST(100, v_monthly),
          'The monthly running cost of ' || o.item_name
            || ', given in memory of ' || o.dedicated_to
            || '. The committee accepted this object; sharing the bill keeps it working.',
          NULL)
  RETURNING id INTO v_pool;

  UPDATE sadqa_objects SET maintenance_pool_id = v_pool, updated_at = now() WHERE id = p_object_id;
  RETURN jsonb_build_object('pool_id', v_pool, 'monthly', v_monthly, 'code', v_code);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION sadqa_publish_upkeep_pool(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sadqa_publish_upkeep_pool(uuid, decimal) TO authenticated;

-- ── What the donor sees about their own upkeep ───────────────────────────
CREATE OR REPLACE FUNCTION my_sadqa_upkeep() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'object_no', o.object_no, 'item_name', o.item_name,
    'month', c.month, 'amount', c.amount_pkr, 'status', c.status,
    'due_on', c.due_on, 'paid_on', c.paid_on
  ) ORDER BY c.month DESC), '[]'::jsonb)
  FROM sadqa_upkeep_charges c JOIN sadqa_objects o ON o.id = c.object_id
  WHERE o.portal_user_id = current_portal_user_id()
    -- An endowed object is silent by design; its charges are never the
    -- donor's to see or settle.
    AND o.maintenance_mode = 'donor';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_sadqa_upkeep() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_sadqa_upkeep() TO authenticated;

ALTER TABLE sadqa_upkeep_charges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sadqa_upkeep_admin ON sadqa_upkeep_charges;
CREATE POLICY sadqa_upkeep_admin ON sadqa_upkeep_charges FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
DROP POLICY IF EXISTS sadqa_upkeep_own ON sadqa_upkeep_charges;
CREATE POLICY sadqa_upkeep_own ON sadqa_upkeep_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM sadqa_objects o WHERE o.id = sadqa_upkeep_charges.object_id
                   AND o.portal_user_id = current_portal_user_id()
                   AND o.maintenance_mode = 'donor'));
REVOKE ALL ON sadqa_upkeep_charges FROM anon;
