-- Migration 222: Mushtarka Kafalat — carrying it together.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why a pool at all
-- ═════════════════════════════════════════════════════════════════════════
-- kafalat_shares lets a donor take a percentage of one named child, minimum
-- ten. For a Chakwal child that is about Rs 10,500 a year — and, worse, it
-- makes one person feel personally responsible for one specific child. That
-- is the pressure that makes people hesitate before signing up at all.
--
-- Rs 2,000 a month is a decision somebody makes once. Rs 100,000 a year is a
-- decision they postpone. Same money, different question.
--
-- The named sponsorship in migration 211 stays exactly as it is. Somebody who
-- wants a bond with one child should have it. The pool is for everyone else,
-- and it is what stands behind a named child whose sponsor stops paying.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The one mechanic that is deliberately NOT built
-- ═════════════════════════════════════════════════════════════════════════
-- The obvious design divides the total by the number of donors, so everybody's
-- share moves as people join and leave. Rising shares would break it. Almost
-- all of this is a manual monthly transfer rather than an auto-debit, so
-- raising a share means asking fifty people to change what they send. Most
-- will not — many will not read the message — and then there is a shortfall
-- AND fifty pledges quietly out of step with what the system believes.
--
-- So a donor's own amount never changes without them agreeing. What moves is
-- the share advertised to the NEXT person. The recruitment line still works —
-- the more of us there are, the less each of us pays — without the mechanic
-- that would erode trust.

CREATE TABLE IF NOT EXISTS support_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar NOT NULL UNIQUE,
  name varchar NOT NULL,
  name_ur varchar,
  description text,
  description_ur text,

  kind varchar NOT NULL
    CHECK (kind IN ('kafalat', 'wazifa', 'project', 'general')),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,

  -- Zakat, Ushr and Esal-e-Sawab are deliberately absent. Zakat needs tamleek
  -- — ownership handed to a poor person — so it cannot sit in a pool that pays
  -- a school, and the committee may not top it up out of its own money without
  -- silently turning ordinary donations into zakat. Esal-e-Sawab is dedicated
  -- to the object it was given for. Both are refused by the ring-fence trigger
  -- in migration 218 as well as by this constraint.
  fund_type varchar NOT NULL DEFAULT 'kafalat'
    CHECK (fund_type IN ('general', 'sadqa', 'kafalat')),

  -- Left null, the target is computed from the register each month, so it
  -- follows reality instead of a number somebody forgot to update.
  manual_monthly_target_pkr decimal,

  -- What a new donor is invited to give. Recomputed as the pool grows; never
  -- applied backwards to somebody who already joined.
  suggested_share_pkr decimal NOT NULL DEFAULT 2000 CHECK (suggested_share_pkr > 0),
  min_share_pkr decimal NOT NULL DEFAULT 500,

  -- Months of cost held back. Without it, the gap between one donor lapsing
  -- and another joining lands on a child in the middle of a semester, and the
  -- promise that the pool covers them is a wish rather than a fact.
  reserve_months decimal NOT NULL DEFAULT 2,

  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES support_pools(id) ON DELETE CASCADE,

  donor_name varchar NOT NULL,
  donor_name_ur varchar,
  donor_phone varchar,
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  is_anonymous boolean NOT NULL DEFAULT false,

  -- Fixed at what the donor agreed. Only they change it.
  monthly_amount_pkr decimal NOT NULL CHECK (monthly_amount_pkr > 0),
  funded_by varchar NOT NULL DEFAULT 'sadqa'
    CHECK (funded_by IN ('sadqa', 'general')),

  started_on date NOT NULL DEFAULT current_date,
  ended_on date,
  status varchar NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'lapsed', 'ended', 'cancelled')),
  lapsed_at timestamptz,
  lapse_reason text,

  recurring_schedule_id uuid REFERENCES recurring_schedules(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pool_commitments_pool_idx ON pool_commitments(pool_id, status);
CREATE INDEX IF NOT EXISTS pool_commitments_user_idx ON pool_commitments(portal_user_id);

-- Money actually received. A commitment is a promise; this is the fact.
CREATE TABLE IF NOT EXISTS pool_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES support_pools(id) ON DELETE CASCADE,
  commitment_id uuid REFERENCES pool_commitments(id) ON DELETE SET NULL,
  for_month date NOT NULL,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  paid_on date NOT NULL DEFAULT current_date,
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  donor_id uuid REFERENCES donors(id) ON DELETE SET NULL,
  -- A one-off gift funds the month but leaves the recruitment ask open, so the
  -- two are never mistaken for each other.
  is_one_time boolean NOT NULL DEFAULT false,
  note text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pool_payments_month_idx ON pool_payments(pool_id, for_month);

-- One row per pool per month: what was needed, what came in, what was short.
CREATE TABLE IF NOT EXISTS pool_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES support_pools(id) ON DELETE CASCADE,
  month date NOT NULL,

  required_pkr decimal NOT NULL DEFAULT 0,
  committed_pkr decimal NOT NULL DEFAULT 0,
  received_pkr decimal NOT NULL DEFAULT 0,
  shortfall_pkr decimal NOT NULL DEFAULT 0,
  donors_active int NOT NULL DEFAULT 0,
  donors_needed int NOT NULL DEFAULT 0,

  status varchar NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'short', 'covered_by_committee', 'closed')),

  -- The committee standing behind its own promise, for this month and no
  -- other. See pool_cover_shortfall() below.
  committee_covered_pkr decimal NOT NULL DEFAULT 0,
  covered_voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  covered_at timestamptz,
  covered_by uuid REFERENCES admin_users(id),
  cover_note text,
  -- Set once the day-after appeal has gone out, so it goes out exactly once
  -- per cover.
  reappealed_at timestamptz,

  closed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE (pool_id, month)
);

CREATE INDEX IF NOT EXISTS pool_months_open_idx ON pool_months(pool_id, status);

-- ═════════════════════════════════════════════════════════════════════════
-- The unrestricted side of the books
-- ═════════════════════════════════════════════════════════════════════════
-- Covering a shortfall does not move cash out of the committee — the money is
-- already in the bank. What changes is that some of it stops being free and
-- becomes earmarked for this pool. Booking it as an expense here would count
-- it twice: once now, and again when the school's fee is actually paid. The
-- cash leaves later, when the fee does.
--
-- So the cover is a transfer between funds. This account is the giving side:
-- its debit balance is the running total the committee has put in from its own
-- unrestricted money — a figure worth reading on its own.
INSERT INTO accounts (code, name, name_ur, type, system, fund_type, description, is_protected) VALUES
  ('DP-GEN', 'General Fund (unrestricted)', 'جنرل فنڈ (غیر مخصوص)', 'restricted_fund', 'donors_projects', 'general',
   'Money the committee may spend on anything. Debited when the committee earmarks some of it to cover a pool shortfall; the debit balance is the total covered from committee funds to date.',
   true)
ON CONFLICT (code, system) DO NOTHING;

-- What the committee could actually cover if it had to.
--
-- Not the balance of DP-GEN — nothing ever credits that account, because a
-- general donation posts to cash and stops there. The honest figure is the
-- money on hand minus the money already spoken for.
CREATE OR REPLACE FUNCTION unrestricted_balance() RETURNS decimal AS $$
  SELECT COALESCE((
    SELECT SUM(l.debit - l.credit) FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     WHERE a.system = 'donors_projects' AND a.type IN ('cash', 'bank')
  ), 0) - COALESCE((
    SELECT SUM(l.credit - l.debit) FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     WHERE a.system = 'donors_projects' AND a.type = 'restricted_fund' AND a.fund_type <> 'general'
  ), 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION unrestricted_balance() TO authenticated;

ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_voucher_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
  CHECK (voucher_type IN ('expense', 'income', 'contra', 'withdrawal', 'deposit',
    'security_deposit', 'security_deposit_refund', 'advance', 'advance_settlement',
    'complaint_waiver', 'project_transfer',
    'zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
    'kafalat_payment', 'wazifa_payment', 'wazifa_repayment', 'wazifa_contribution',
    'pool_shortfall_cover'));

INSERT INTO voucher_counters (system, voucher_type, prefix) VALUES
  ('donors_projects', 'pool_shortfall_cover', 'DP-PSC-V')
ON CONFLICT (system, voucher_type) DO NOTHING;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS pool_id uuid REFERENCES support_pools(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pool_month_id uuid REFERENCES pool_months(id) ON DELETE SET NULL;

ALTER TABLE pool_payments
  ADD COLUMN IF NOT EXISTS voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- What the pool needs each month
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pool_monthly_target(p_pool_id uuid) RETURNS decimal AS $$
DECLARE p support_pools%ROWTYPE; v decimal;
BEGIN
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF p.manual_monthly_target_pkr IS NOT NULL THEN RETURN p.manual_monthly_target_pkr; END IF;

  IF p.kind = 'kafalat' THEN
    -- Every active child's annual package, spread over twelve months.
    SELECT COALESCE(SUM(kafalat_package_total(c.id, NULL::varchar)), 0) / 12
      INTO v FROM kafalat_children c WHERE c.status = 'active';
  ELSIF p.kind = 'wazifa' THEN
    -- What the committee is actually paying out. A qarz-e-hasana repayment is
    -- a receivable coming back, not a reduction in this year's cost, so it is
    -- deliberately not netted off here.
    SELECT COALESCE(SUM(a.awarded_amount_pkr), 0) / 12
      INTO v FROM wazifa_awards a WHERE a.status = 'active';
  ELSIF p.kind = 'project' AND p.project_id IS NOT NULL THEN
    SELECT COALESCE(monthly_operating_cost_pkr, 0) INTO v FROM projects WHERE id = p.project_id;
  ELSE
    v := 0;
  END IF;
  RETURN COALESCE(round(v), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- The live picture, and the recruitment message with it.
CREATE OR REPLACE FUNCTION pool_position(p_pool_id uuid) RETURNS jsonb AS $$
DECLARE
  p support_pools%ROWTYPE;
  v_target decimal; v_committed decimal; v_donors int;
  v_month date; v_received decimal; v_reserve decimal; v_gap decimal;
  v_covered decimal;
BEGIN
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;
  v_target := pool_monthly_target(p_pool_id);

  SELECT COALESCE(SUM(monthly_amount_pkr), 0), count(*)
    INTO v_committed, v_donors
    FROM pool_commitments WHERE pool_id = p_pool_id AND status = 'active';

  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_received
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month;

  SELECT COALESCE(SUM(committee_covered_pkr), 0) INTO v_covered
    FROM pool_months WHERE pool_id = p_pool_id AND month = v_month;

  -- The gap that matters for recruitment is measured against standing
  -- commitments, never against what happened to arrive this month. A month the
  -- committee paid for out of its own pocket is still a month with too few
  -- donors, and the ask has to keep saying so.
  v_gap := GREATEST(v_target - v_committed, 0);

  v_reserve := CASE WHEN v_target > 0 THEN fund_balance(p.fund_type) / v_target ELSE 0 END;

  RETURN jsonb_build_object(
    'pool_id', p.id, 'code', p.code, 'name', p.name, 'name_ur', p.name_ur, 'kind', p.kind,
    'fund_type', p.fund_type,
    'month', v_month,
    'required', v_target,
    'committed', v_committed,
    'received_this_month', v_received,
    'committee_covered_this_month', v_covered,
    'donors', v_donors,
    'coverage_percent', CASE WHEN v_target > 0
                             THEN LEAST(round(v_committed / v_target * 100, 1), 100) ELSE 100 END,
    'gap', v_gap,
    -- What the next person is asked for, and how many more like them close it.
    'suggested_share', p.suggested_share_pkr,
    'min_share', p.min_share_pkr,
    'donors_needed', CASE WHEN v_gap > 0 THEN ceil(v_gap / GREATEST(p.suggested_share_pkr, 1))::int ELSE 0 END,
    -- Only a real figure once somebody is actually giving.
    'share_if_all_split', CASE WHEN v_donors > 0 AND v_target > 0
                               THEN round(v_target / v_donors) ELSE p.suggested_share_pkr END,
    'reserve_months', round(v_reserve, 1),
    'reserve_target_months', p.reserve_months,
    'is_short', v_gap > 0
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_position(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION pool_monthly_target(uuid) TO authenticated;

-- Every pool still short of donors.
--
-- This is what the portal banner reads. Nothing here is dismissible and there
-- is no per-user read flag: a pool drops off this list when enough people have
-- joined, and not one moment before. That is the whole mechanism behind
-- "it stays in every donor's portal until the donors join".
CREATE OR REPLACE FUNCTION pool_alerts() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'donors_needed')::int DESC), '[]'::jsonb)
  FROM (SELECT pool_position(id) AS x FROM support_pools WHERE is_active) y
  WHERE (x->>'is_short')::boolean;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_alerts() TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Joining
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pool_join(
  p_pool_id uuid, p_monthly_amount decimal, p_funded_by varchar DEFAULT 'sadqa',
  p_is_anonymous boolean DEFAULT false, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  p support_pools%ROWTYPE; u portal_users%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That pool is not open.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO u FROM portal_users WHERE id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Please sign in first.' USING ERRCODE = 'P0001'; END IF;

  IF p_monthly_amount < p.min_share_pkr THEN
    RAISE EXCEPTION 'The smallest monthly share for this pool is Rs %.',
      trim(to_char(p.min_share_pkr, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM pool_commitments
              WHERE pool_id = p_pool_id AND portal_user_id = u.id
                AND status IN ('active', 'lapsed')) THEN
    RAISE EXCEPTION 'You already have a monthly share in this pool. Change that one instead of adding a second.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO pool_commitments (
    pool_id, donor_name, donor_name_ur, donor_phone, portal_user_id,
    is_anonymous, monthly_amount_pkr, funded_by, note
  ) VALUES (
    p_pool_id, u.full_name, u.name_ur, u.mobile, u.id,
    p_is_anonymous, p_monthly_amount, p_funded_by, p_note
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('commitment_id', v_id, 'position', pool_position(p_pool_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_join(uuid, decimal, varchar, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_join(uuid, decimal, varchar, boolean, text) TO authenticated;

-- The donor's own amount, changed only by the donor. Nothing else in this
-- migration writes monthly_amount_pkr.
CREATE OR REPLACE FUNCTION pool_change_my_share(
  p_commitment_id uuid, p_monthly_amount decimal
) RETURNS jsonb AS $$
DECLARE c pool_commitments%ROWTYPE; p support_pools%ROWTYPE;
BEGIN
  SELECT * INTO c FROM pool_commitments
   WHERE id = p_commitment_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO p FROM support_pools WHERE id = c.pool_id;

  IF p_monthly_amount < p.min_share_pkr THEN
    RAISE EXCEPTION 'The smallest monthly share for this pool is Rs %.',
      trim(to_char(p.min_share_pkr, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  UPDATE pool_commitments SET monthly_amount_pkr = p_monthly_amount, updated_at = now()
   WHERE id = p_commitment_id;
  RETURN jsonb_build_object('ok', true, 'position', pool_position(c.pool_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Leaving is one click and no explanation is demanded. A donor who has to
-- argue with a form to stop is a donor who never joins the next thing.
CREATE OR REPLACE FUNCTION pool_leave(p_commitment_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE c pool_commitments%ROWTYPE;
BEGIN
  SELECT * INTO c FROM pool_commitments
   WHERE id = p_commitment_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001'; END IF;

  UPDATE pool_commitments
     SET status = 'ended', ended_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         lapse_reason = p_reason, updated_at = now()
   WHERE id = p_commitment_id;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_pool_commitments() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'pool', p.name, 'pool_ur', p.name_ur, 'pool_id', p.id,
    'monthly_amount', c.monthly_amount_pkr, 'status', c.status,
    'funded_by', c.funded_by, 'started_on', c.started_on,
    'paid_this_month', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                                  WHERE commitment_id = c.id
                                    AND for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date), 0),
    'months_given', (SELECT count(DISTINCT for_month) FROM pool_payments WHERE commitment_id = c.id),
    'total_given', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments WHERE commitment_id = c.id), 0)
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  FROM pool_commitments c JOIN support_pools p ON p.id = c.pool_id
  WHERE c.portal_user_id = current_portal_user_id()
    AND c.status <> 'cancelled';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_pool_commitments() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION pool_change_my_share(uuid, decimal) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION pool_leave(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pool_commitments() TO authenticated;
GRANT EXECUTE ON FUNCTION pool_change_my_share(uuid, decimal) TO authenticated;
GRANT EXECUTE ON FUNCTION pool_leave(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Money in
-- ═════════════════════════════════════════════════════════════════════════
-- Recorded as an ordinary donation as well, so the giver's own ledger, the
-- receipt, the restricted-fund posting and the thank-you all happen through
-- the machinery that already exists rather than a second copy of it.
CREATE OR REPLACE FUNCTION pool_record_payment(
  p_commitment_id uuid, p_amount decimal, p_method varchar,
  p_for_month date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c pool_commitments%ROWTYPE; p support_pools%ROWTYPE;
  v_month date; v_donor_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM pool_commitments WHERE id = p_commitment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commitment not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO p FROM support_pools WHERE id = c.pool_id;

  v_month := COALESCE(date_trunc('month', p_for_month)::date,
                      date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date);

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified,
                      payment_method, is_anonymous, fund_type, portal_user_id,
                      payment_status, notes, submitted_via)
  VALUES (c.donor_name, c.donor_name_ur, c.donor_phone, p_amount,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true,
          p_method, c.is_anonymous,
          -- The pool's fund, not the donor's preference: money given to the
          -- kafalat pool is kafalat money whatever box was ticked.
          p.fund_type, c.portal_user_id, 'paid',
          p.name || ' — ' || to_char(v_month, 'Mon YYYY') || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, method,
                             donor_id, note, created_by)
  VALUES (c.pool_id, p_commitment_id, v_month, p_amount, p_method, v_donor_id,
          p_note, current_admin_user_id());

  -- Somebody who had lapsed and has now paid is simply active again — no
  -- second sign-up, no re-approval.
  UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
   WHERE id = p_commitment_id AND status = 'lapsed';

  RETURN jsonb_build_object('for_month', v_month, 'amount', p_amount, 'donor_id', v_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_record_payment(uuid, decimal, varchar, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_record_payment(uuid, decimal, varchar, date, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Closing a month
-- ═════════════════════════════════════════════════════════════════════════
-- Run on the last day of the month. It works out what came in, marks anybody
-- who paid nothing as lapsed, and leaves the shortfall sitting in front of the
-- accountant.
--
-- It does not move money on its own. The committee spending its own funds is a
-- decision a person makes and puts their name to, not something a scheduled
-- job does overnight.
CREATE OR REPLACE FUNCTION pool_close_month(p_pool_id uuid, p_month date DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  p support_pools%ROWTYPE;
  v_month date; v_target decimal; v_committed decimal; v_received decimal;
  v_short decimal; v_donors int; v_id uuid; v_covered decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pool not found' USING ERRCODE = 'P0001'; END IF;

  v_month := COALESCE(date_trunc('month', p_month)::date,
                      date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date);
  IF v_month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date THEN
    RAISE EXCEPTION 'That month has not started yet.' USING ERRCODE = 'P0001';
  END IF;

  v_target := pool_monthly_target(p_pool_id);

  SELECT COALESCE(SUM(monthly_amount_pkr), 0), count(*) INTO v_committed, v_donors
    FROM pool_commitments WHERE pool_id = p_pool_id AND status = 'active';
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_received
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month;
  SELECT COALESCE(committee_covered_pkr, 0) INTO v_covered
    FROM pool_months WHERE pool_id = p_pool_id AND month = v_month;

  -- The gap the donors left, recorded before any committee money is counted.
  -- Netting the cover off here would erase the very thing this row exists to
  -- remember: re-running the close would turn "we were 7,000 short and the
  -- committee paid it" into "we were fine and the committee gave 7,000 anyway".
  -- What is still outstanding is shortfall_pkr - committee_covered_pkr.
  v_short := GREATEST(v_target - v_received, 0);

  -- A commitment that brought nothing this month is lapsed rather than
  -- deleted, so the person can pay again and be active without signing up
  -- twice — and so the accountant can see who to ring.
  UPDATE pool_commitments c SET status = 'lapsed', lapsed_at = now(), updated_at = now()
   WHERE c.pool_id = p_pool_id AND c.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM pool_payments pp
                      WHERE pp.commitment_id = c.id AND pp.for_month = v_month);

  INSERT INTO pool_months (pool_id, month, required_pkr, committed_pkr, received_pkr,
                           shortfall_pkr, donors_active, donors_needed, status)
  VALUES (p_pool_id, v_month, v_target, v_committed, v_received, v_short, v_donors,
          CASE WHEN v_target > v_committed
               THEN ceil((v_target - v_committed) / GREATEST(p.suggested_share_pkr, 1))::int
               ELSE 0 END,
          CASE WHEN v_short <= 0 THEN 'closed'
               WHEN COALESCE(v_covered, 0) >= v_short THEN 'covered_by_committee'
               ELSE 'short' END)
  ON CONFLICT (pool_id, month) DO UPDATE SET
    required_pkr = EXCLUDED.required_pkr, committed_pkr = EXCLUDED.committed_pkr,
    received_pkr = EXCLUDED.received_pkr, shortfall_pkr = EXCLUDED.shortfall_pkr,
    donors_active = EXCLUDED.donors_active, donors_needed = EXCLUDED.donors_needed,
    -- Derived from the money, so re-running the close is idempotent: a covered
    -- month stays covered and cannot be reopened for a second cover, and a
    -- month that a late payment has since filled closes properly.
    status = EXCLUDED.status
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('month', v_month, 'required', v_target, 'received', v_received,
                            'shortfall', v_short, 'pool_month_id', v_id,
                            'donors_lapsed', (SELECT count(*) FROM pool_commitments
                                               WHERE pool_id = p_pool_id AND status = 'lapsed'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_close_month(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_close_month(uuid, date) TO authenticated;

-- Close every active pool. Meant for a month-end scheduled run; also the one
-- button the accountant presses on the last day.
CREATE OR REPLACE FUNCTION pool_close_all_months(p_month date DEFAULT NULL) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(pool_close_month(id, p_month)), '[]'::jsonb)
    FROM support_pools WHERE is_active;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_close_all_months(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_close_all_months(date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- The committee standing behind its own promise
-- ═════════════════════════════════════════════════════════════════════════
-- Nobody joined in time and a child would otherwise be stopped, so the
-- committee covers it from its own unrestricted money.
--
-- Three things this deliberately is NOT:
--
--   Not a cash payment. The money is already in the committee's bank. What
--   changes is that some of it stops being free to spend and becomes earmarked
--   for this pool. Booking an expense here would count it twice — once now and
--   again when the school's fee is actually paid. Both legs are subsidiary
--   rows, so the trial balance and the cash position are untouched, which is
--   exactly what happened.
--
--   Not a donor. No commitment row is created and nothing is added to
--   committed_pkr. The pool is still short of the people it needs, and every
--   figure the donors see keeps saying so.
--
--   Not a standing arrangement. It settles one named month and expires with
--   it. Next month opens with the same gap and the same ask. Enforced here:
--   one month at a time, never a future month, never more than the shortfall
--   that month actually had.
--
-- Confirmed by a person, deliberately. No receipt or proof is asked for —
-- there is no counterparty, this is the committee moving its own money from
-- one pocket to another — but a name and a timestamp go on it, and the voucher
-- says which pool and which month in plain words.
CREATE OR REPLACE FUNCTION pool_cover_shortfall(
  p_pool_month_id uuid, p_amount decimal DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  m pool_months%ROWTYPE; p support_pools%ROWTYPE;
  v_amount decimal; v_remaining decimal; v_general uuid; v_fund uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_available decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO m FROM pool_months WHERE id = p_pool_month_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO p FROM support_pools WHERE id = m.pool_id;

  IF m.month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date THEN
    RAISE EXCEPTION 'A future month cannot be covered in advance. Each month is settled on its own.'
      USING ERRCODE = 'P0001';
  END IF;

  v_remaining := m.shortfall_pkr - m.committee_covered_pkr;
  v_amount := COALESCE(p_amount, v_remaining);

  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'This month is already settled — there is nothing left to cover.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF v_amount > v_remaining THEN
    RAISE EXCEPTION 'The shortfall for % is Rs % — the committee cannot cover more than that.',
      to_char(m.month, 'Mon YYYY'),
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  v_general := fund_account_id('general');
  v_fund := fund_account_id(p.fund_type);
  IF v_general IS NULL OR v_fund IS NULL THEN
    RAISE EXCEPTION 'The general or restricted fund account is missing.' USING ERRCODE = 'P0001';
  END IF;

  -- Refuse to promise money the committee does not have. Measured against cash
  -- and bank less what is already spoken for, not against a fund account that
  -- nothing ever credits.
  v_available := unrestricted_balance();
  IF v_amount > v_available THEN
    RAISE EXCEPTION
      'The committee has Rs % of unrestricted money — it cannot cover Rs %. Raise the money first, or cover part of it.',
      trim(to_char(v_available, 'FM999,999,999,990')),
      trim(to_char(v_amount, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, pool_id, pool_month_id, fund_type, project_id)
  VALUES ('donors_projects', 'pool_shortfall_cover',
    (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Committee covering the ' || to_char(m.month, 'Mon YYYY') || ' shortfall for ' || p.name
      || ' — one month only, from committee funds, no donor attached'
      || COALESCE(' · ' || p_note, ''),
    v_amount, v_general, v_fund, 'Dhab Pari Committee', p.id, m.id, p.fund_type, p.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE pool_months
     SET committee_covered_pkr = committee_covered_pkr + v_amount,
         status = CASE WHEN committee_covered_pkr + v_amount >= shortfall_pkr
                       THEN 'covered_by_committee' ELSE 'short' END,
         covered_voucher_id = v_voucher_id, covered_at = now(),
         covered_by = current_admin_user_id(), cover_note = p_note,
         -- Cleared so the day-after appeal fires again for this cover.
         reappealed_at = NULL,
         closed_at = now()
   WHERE id = p_pool_month_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_amount,
                            'month', m.month, 'pool', p.name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_cover_shortfall(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_cover_shortfall(uuid, decimal, text) TO authenticated;

-- ── The legs ─────────────────────────────────────────────────────────────
-- General fund down, restricted fund up. Both accounts are type
-- restricted_fund, so migration 221's trigger flags the rows is_memo: they
-- balance against each other, and the cash and the trial balance are untouched.
--
-- This needs its own branch because the generic path at the bottom of
-- post_voucher_ledger_legs debits to_account and credits from_account, which
-- is the right convention for cash (from = the account money leaves, credited)
-- and the wrong one for funds (a fund gaining money is a credit). Writing the
-- legs explicitly is clearer than inverting from/to and leaving every reader of
-- the voucher to work out why it says "from Kafalat".
CREATE OR REPLACE FUNCTION post_pool_voucher_legs(p_voucher vouchers) RETURNS void AS $$
BEGIN
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
  VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular,
          p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
  VALUES (p_voucher.to_account_id, p_voucher.voucher_date, p_voucher.particular,
          0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION post_pool_voucher_legs(vouchers) TO authenticated;

-- Re-declared from migration 218 with one branch added, the same way 218
-- re-declared 206's. Everything below the pool branch is 218's body verbatim.
CREATE OR REPLACE FUNCTION post_voucher_ledger_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_bill_number varchar;
  v_line_total decimal;
  v_advance_amount decimal;
  v_diff decimal;
  v_advance_account_id uuid;
  v_project_account_id uuid;
  v_to_project_account_id uuid;
  v_project_amount decimal;
  v_from_title text;
  v_to_title text;
  r RECORD;
BEGIN
  IF p_voucher.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = p_voucher.bill_id;
  END IF;

  IF p_voucher.reverses_voucher_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    SELECT l.account_id, p_voucher.voucher_date, p_voucher.particular,
           l.credit, l.debit, 'voucher', p_voucher.id, p_voucher.receipt_no, l.bill_number
      FROM ledger_entries l
     WHERE l.reference_type = 'voucher' AND l.reference_id = p_voucher.reverses_voucher_id;
    RETURN;
  END IF;

  IF p_voucher.voucher_type = 'pool_shortfall_cover' THEN
    PERFORM post_pool_voucher_legs(p_voucher);
    RETURN;
  END IF;

  IF p_voucher.voucher_type IN ('zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
                                'kafalat_payment', 'wazifa_payment', 'wazifa_repayment',
                                'wazifa_contribution') THEN
    PERFORM post_welfare_voucher_legs(p_voucher);
    RETURN;
  END IF;

  IF p_voucher.voucher_type = 'project_transfer' THEN
    SELECT title INTO v_from_title FROM projects WHERE id = p_voucher.project_id;
    SELECT title INTO v_to_title FROM projects WHERE id = p_voucher.transfer_to_project_id;
    v_project_account_id := ensure_project_account(p_voucher.project_id);
    v_to_project_account_id := ensure_project_account(p_voucher.transfer_to_project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_project_account_id, p_voucher.voucher_date,
            COALESCE(p_voucher.particular, '') || ' — transferred to ' || COALESCE(v_to_title, 'another project'),
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_to_project_account_id, p_voucher.voucher_date,
            COALESCE(p_voucher.particular, '') || ' — received from ' || COALESCE(v_from_title, 'another project'),
            0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no);
    RETURN;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher.id;

  IF p_voucher.voucher_type = 'advance_settlement' THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    SELECT amount_pkr INTO v_advance_amount FROM vouchers WHERE id = p_voucher.settles_voucher_id;
    v_diff := v_advance_amount - v_line_total;
    SELECT id INTO v_advance_account_id FROM accounts WHERE system = p_voucher.system AND code = 'WS-4003';
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_advance_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_advance_amount, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    IF v_diff > 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, v_diff, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    ELSIF v_diff < 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, -v_diff, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END IF;
    UPDATE vouchers SET settled_at = now() WHERE id = p_voucher.settles_voucher_id;
    v_project_amount := v_line_total;

  ELSIF v_line_total > 0 THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_line_total, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := v_line_total;

  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, p_voucher.particular, p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := p_voucher.amount_pkr;
  END IF;

  IF p_voucher.system = 'donors_projects' AND p_voucher.voucher_type = 'expense' AND p_voucher.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(p_voucher.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_project_account_id, p_voucher.voucher_date, p_voucher.particular, v_project_amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Reversing a cover has to unwind the month as well as the ledger.
--
-- reverse_voucher() mirrors the ledger rows, so the money goes back correctly
-- on its own. But without this the pool_months row would still read
-- "covered_by_committee" with the committee's 7,000 against it, and the
-- accountant's queue would quietly stop showing a month that is short again.
CREATE OR REPLACE FUNCTION trg_pool_cover_reversed() RETURNS trigger AS $$
DECLARE v vouchers%ROWTYPE; v_left decimal;
BEGIN
  IF NEW.reverses_voucher_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v FROM vouchers WHERE id = NEW.reverses_voucher_id;
  IF NOT FOUND OR v.voucher_type <> 'pool_shortfall_cover' OR v.pool_month_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT GREATEST(committee_covered_pkr - v.amount_pkr, 0) INTO v_left
    FROM pool_months WHERE id = v.pool_month_id;

  UPDATE pool_months
     SET committee_covered_pkr = v_left,
         status = CASE WHEN shortfall_pkr <= 0 THEN 'closed'
                       WHEN v_left >= shortfall_pkr THEN 'covered_by_committee'
                       ELSE 'short' END,
         covered_voucher_id = CASE WHEN v_left > 0 THEN covered_voucher_id ELSE NULL END,
         covered_at = CASE WHEN v_left > 0 THEN covered_at ELSE NULL END,
         covered_by = CASE WHEN v_left > 0 THEN covered_by ELSE NULL END,
         cover_note = CASE WHEN v_left > 0 THEN cover_note ELSE NULL END,
         reappealed_at = NULL
   WHERE id = v.pool_month_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS pool_cover_reversed ON vouchers;
CREATE TRIGGER pool_cover_reversed AFTER INSERT ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_pool_cover_reversed();

-- ═════════════════════════════════════════════════════════════════════════
-- The ask, and the ask again
-- ═════════════════════════════════════════════════════════════════════════
-- The committee covering a month is not good news and must never read like it.
-- It means the village did not turn up and the committee's own reserves
-- absorbed it — which it cannot do twice. So the appeal goes back out the very
-- next day, naming the number of people still needed.
CREATE OR REPLACE FUNCTION pool_appeal_text(p_pool_id uuid, p_urdu boolean DEFAULT false)
RETURNS text AS $$
DECLARE x jsonb; v_needed int; v_share text; v_name text;
BEGIN
  x := pool_position(p_pool_id);
  IF x IS NULL OR NOT (x->>'is_short')::boolean THEN RETURN NULL; END IF;
  v_needed := (x->>'donors_needed')::int;
  v_share := trim(to_char((x->>'suggested_share')::decimal, 'FM999,999,990'));
  v_name := COALESCE(NULLIF(x->>(CASE WHEN p_urdu THEN 'name_ur' ELSE 'name' END), ''), x->>'name');

  IF p_urdu THEN
    RETURN v_name || ' کے لیے مزید ' || v_needed || ' ساتھیوں کی ضرورت ہے۔ ماہانہ '
        || v_share || ' روپے۔ جتنے زیادہ ساتھی، اتنا کم بوجھ ہر ایک پر۔';
  END IF;
  RETURN v_name || ' still needs ' || v_needed || ' more people at Rs ' || v_share
      || ' a month. The more of us there are, the less each of us pays.';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_appeal_text(uuid, boolean) TO anon, authenticated;

-- Sends the appeal into every active portal user's notifications.
--
-- Runs from a scheduled job, and is safe to run as often as you like: it fires
-- the day after a committee cover (once per cover), and otherwise at most once
-- every 28 days per pool. Ringing everybody the moment any one donor lapses is
-- how a committee teaches its village to ignore it.
CREATE OR REPLACE FUNCTION pool_daily_appeal() RETURNS jsonb AS $$
DECLARE
  r record; v_sent int := 0; v_total int := 0; v_pools int := 0; v_today date;
  v_body text; v_title text;
BEGIN
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;

  FOR r IN
    SELECT p.id, p.name, p.name_ur,
           -- The most recent cover still awaiting its day-after appeal.
           (SELECT m.id FROM pool_months m
             WHERE m.pool_id = p.id AND m.covered_at IS NOT NULL
               AND m.reappealed_at IS NULL
               AND (m.covered_at AT TIME ZONE 'Asia/Karachi')::date < v_today
             ORDER BY m.covered_at DESC LIMIT 1) AS cover_month_id
      FROM support_pools p
     WHERE p.is_active
       AND (pool_position(p.id)->>'is_short')::boolean
  LOOP
    -- Either the day after a cover, or the periodic reminder — never both, and
    -- never more than once every four weeks otherwise.
    IF r.cover_month_id IS NULL
       AND EXISTS (SELECT 1 FROM portal_notifications
                    WHERE event_type = 'pool_appeal'
                      AND link LIKE '%' || r.id::text || '%'
                      AND created_at > now() - interval '28 days') THEN
      CONTINUE;
    END IF;

    v_title := CASE WHEN r.cover_month_id IS NOT NULL
                    THEN 'The committee covered last month — we still need you'
                    ELSE 'Still short: ' || r.name END;

    v_body := COALESCE(pool_appeal_text(r.id, true), '') || E'\n\n'
           || COALESCE(pool_appeal_text(r.id, false), '')
           || CASE WHEN r.cover_month_id IS NOT NULL
                   THEN E'\n\nLast month''s gap was paid out of the committee''s own funds so that no child was stopped. That was a one-off for that month alone and cannot be repeated.'
                   ELSE '' END;

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT pu.id, 'pool_appeal', v_title, v_body, '/portal/support?pool=' || r.id::text
      FROM portal_users pu WHERE pu.is_active;
    GET DIAGNOSTICS v_sent = ROW_COUNT;
    v_total := v_total + v_sent;

    IF r.cover_month_id IS NOT NULL THEN
      UPDATE pool_months SET reappealed_at = now() WHERE id = r.cover_month_id;
    END IF;
    v_pools := v_pools + 1;
  END LOOP;

  RETURN jsonb_build_object('pools_appealed', v_pools, 'notifications_sent', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_daily_appeal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_daily_appeal() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- What the donor accountant sees
-- ═════════════════════════════════════════════════════════════════════════
-- One screen: which months are short, who lapsed and their phone number, and
-- how much unrestricted money is actually available to cover with. The names
-- and numbers matter more than the total — a shortfall is usually four people
-- who forgot, not a collapse in support.
CREATE OR REPLACE FUNCTION pool_shortfall_queue() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'unrestricted_available', unrestricted_balance(),
    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'pool_month_id', m.id, 'pool_id', p.id, 'pool', p.name, 'pool_ur', p.name_ur,
        'month', m.month, 'required', m.required_pkr, 'received', m.received_pkr,
        'shortfall', m.shortfall_pkr, 'covered', m.committee_covered_pkr,
        'remaining', m.shortfall_pkr - m.committee_covered_pkr,
        'donors_active', m.donors_active, 'donors_needed', m.donors_needed,
        'status', m.status
      ) ORDER BY m.month DESC)
        FROM pool_months m JOIN support_pools p ON p.id = m.pool_id
       WHERE m.status = 'short' AND m.shortfall_pkr > m.committee_covered_pkr
    ), '[]'::jsonb),
    'lapsed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'commitment_id', c.id, 'pool', p.name, 'name', c.donor_name,
        'phone', c.donor_phone, 'amount', c.monthly_amount_pkr, 'since', c.lapsed_at
      ) ORDER BY c.lapsed_at DESC)
        FROM pool_commitments c JOIN support_pools p ON p.id = c.pool_id
       WHERE c.status = 'lapsed'
    ), '[]'::jsonb),
    'covers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'month', m.month, 'pool', p.name, 'amount', m.committee_covered_pkr,
        'voucher_no', v.voucher_no, 'at', m.covered_at,
        'by', (SELECT full_name FROM admin_users WHERE id = m.covered_by)
      ) ORDER BY m.covered_at DESC)
        FROM pool_months m JOIN support_pools p ON p.id = m.pool_id
        LEFT JOIN vouchers v ON v.id = m.covered_voucher_id
       WHERE m.committee_covered_pkr > 0
    ), '[]'::jsonb)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_shortfall_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_shortfall_queue() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE support_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool_months ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_pools_read ON support_pools;
CREATE POLICY support_pools_read ON support_pools FOR SELECT USING (is_active);
DROP POLICY IF EXISTS support_pools_admin ON support_pools;
CREATE POLICY support_pools_admin ON support_pools FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS pool_commitments_admin ON pool_commitments;
CREATE POLICY pool_commitments_admin ON pool_commitments FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
-- A donor sees their own pledge and nobody else's. Who gives what is not
-- village information.
DROP POLICY IF EXISTS pool_commitments_own ON pool_commitments;
CREATE POLICY pool_commitments_own ON pool_commitments FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS pool_payments_admin ON pool_payments;
CREATE POLICY pool_payments_admin ON pool_payments FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS pool_months_admin ON pool_months;
CREATE POLICY pool_months_admin ON pool_months FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

REVOKE ALL ON pool_commitments FROM anon;
REVOKE ALL ON pool_payments FROM anon;
REVOKE ALL ON pool_months FROM anon;
GRANT SELECT ON support_pools TO anon;

-- Two pools to start from, both editable in the admin screen. Targets are
-- computed from the register, so they follow reality rather than a number
-- somebody forgot to update.
INSERT INTO support_pools (code, name, name_ur, kind, fund_type, suggested_share_pkr, min_share_pkr, description, description_ur)
VALUES
  ('POOL-KFL', 'Mushtarka Kafalat — all our school children', 'مشترکہ کفالت — ہمارے تمام سکول کے بچے',
   'kafalat', 'kafalat', 2000, 500,
   'Every registered child''s fees, uniform, books and transport, carried together by many people instead of one person per child.',
   'ہر رجسٹرڈ بچے کی فیس، یونیفارم، کتابیں اور آمد و رفت — ایک بچے کے لیے ایک شخص کے بجائے سب مل کر اٹھاتے ہیں۔'),
  ('POOL-WZF', 'Mushtarka Taleemi Wazifa — all our students', 'مشترکہ تعلیمی وظیفہ — ہمارے تمام طلبہ',
   'wazifa', 'sadqa', 2000, 500,
   'College and university fees for every student the committee is supporting, shared between all of us.',
   'کمیٹی کے زیرِ کفالت تمام طلبہ کی کالج و یونیورسٹی فیس، ہم سب میں تقسیم۔')
ON CONFLICT (code) DO NOTHING;
