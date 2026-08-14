-- Migration 231: a donor announces, the accountant confirms — the same
-- lifecycle already proven for Esal-e-Sawab receipts, now for pool giving.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why announce and confirm are two different acts
-- ═════════════════════════════════════════════════════════════════════════
-- pool_record_payment() (migration 222) has always been accountant-entered:
-- money has already landed, and a staff member types it up. That covers cash
-- handed over in person, but it means every bank-transfer donor's pledge only
-- becomes visible to them once someone else has typed it — nothing shows on
-- their own portal in the meantime.
--
-- Announcing closes that gap. A donor states what they intend to give — one
-- time or every month, never less than the pool's minimum — and it appears on
-- their own portal immediately, labelled Mushtarka Kafalat, so they have
-- something to point to and something to act on. It is not yet money: no
-- ledger entry, no fund credit, nothing counted in what the pool has raised.
-- It becomes real the moment the accountant confirms it, the same as every
-- other announced-then-confirmed flow already in this codebase (donor pledges
-- in migration 133, Esal-e-Sawab receipts in migration 225).
--
-- And because it is only an announcement, the donor may withdraw it
-- themselves at any time before it is confirmed — one tap, no explanation
-- demanded, the same principle pool_leave() already applies to the ongoing
-- commitment underneath it.

ALTER TABLE pool_payments
  ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('announced', 'confirmed', 'cancelled')),
  ADD COLUMN IF NOT EXISTS announced_by_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS announced_at timestamptz,
  ADD COLUMN IF NOT EXISTS proof_url text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  -- Shown on the public board only when the donor has said yes to that —
  -- recognition offered, never assumed. Names of people who have merely
  -- pledged are never published; only those who have actually paid, and only
  -- if they ticked this.
  ADD COLUMN IF NOT EXISTS show_name_publicly boolean NOT NULL DEFAULT false;

-- A recurring commitment cannot carry two live announcements for the same
-- month — re-running the monthly job or a donor double-tapping must not
-- double their bill. A cancelled row does not count, so the same month can be
-- announced again after being withdrawn.
CREATE UNIQUE INDEX IF NOT EXISTS pool_payments_one_per_month
  ON pool_payments(commitment_id, for_month) WHERE status <> 'cancelled' AND commitment_id IS NOT NULL;

-- Existing rows all came from the accountant-entered path and are already
-- real; they default to 'confirmed' and back-fill confirmed_at from when they
-- were created, so nothing already on the books looks unconfirmed.
UPDATE pool_payments SET confirmed_at = created_at, confirmed_by = created_by
 WHERE status = 'confirmed' AND confirmed_at IS NULL;

-- Rs 1,000 rather than the general Rs 500 default — a Kafalat share this
-- small feels like a token rather than a share of a specific child's year,
-- and a token is a harder thing to keep paying every month.
UPDATE support_pools SET min_share_pkr = 1000 WHERE code = 'POOL-KFL' AND min_share_pkr < 1000;

-- ═════════════════════════════════════════════════════════════════════════
-- Announcing
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pool_announce(
  p_pool_id uuid, p_amount decimal, p_recurring boolean,
  p_funded_by varchar DEFAULT 'sadqa', p_show_name_publicly boolean DEFAULT false
) RETURNS jsonb AS $$
DECLARE
  pl support_pools%ROWTYPE; u portal_users%ROWTYPE;
  v_commitment_id uuid; v_month date; v_id uuid;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That pool is not open.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO u FROM portal_users WHERE id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Please sign in first.' USING ERRCODE = 'P0001'; END IF;

  IF p_amount < pl.min_share_pkr THEN
    RAISE EXCEPTION 'The smallest amount for this pool is Rs %.',
      trim(to_char(pl.min_share_pkr, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  IF p_recurring THEN
    SELECT id INTO v_commitment_id FROM pool_commitments
     WHERE pool_id = p_pool_id AND portal_user_id = u.id AND status IN ('active', 'lapsed');

    IF v_commitment_id IS NULL THEN
      INSERT INTO pool_commitments (pool_id, donor_name, donor_name_ur, donor_phone, portal_user_id,
                                    monthly_amount_pkr, funded_by)
      VALUES (p_pool_id, u.full_name, u.name_ur, u.mobile, u.id, p_amount, p_funded_by)
      RETURNING id INTO v_commitment_id;
    ELSE
      -- The first announcement sets the ongoing amount; it does not silently
      -- change it later. Someone wanting a different figure uses
      -- pool_change_my_share() first, which is the one place that amount is
      -- allowed to move — and only at the donor's own hand.
      IF EXISTS (SELECT 1 FROM pool_commitments
                  WHERE id = v_commitment_id AND monthly_amount_pkr <> p_amount) THEN
        RAISE EXCEPTION
          'Your standing amount for this pool is already set. Change it from "My monthly shares" first if you want a different figure.'
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
       WHERE id = v_commitment_id AND status = 'lapsed';
    END IF;
  ELSE
    v_commitment_id := NULL;
  END IF;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, is_one_time,
                             status, announced_by_portal_user_id, announced_at, show_name_publicly)
  VALUES (p_pool_id, v_commitment_id, v_month, p_amount, NOT p_recurring,
          'announced', u.id, now(), p_show_name_publicly)
  ON CONFLICT (commitment_id, for_month) WHERE status <> 'cancelled' AND commitment_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This month is already announced for this pool.' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('payment_id', v_id, 'commitment_id', v_commitment_id,
                            'month', v_month, 'position', pool_position(p_pool_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_announce(uuid, decimal, boolean, varchar, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_announce(uuid, decimal, boolean, varchar, boolean) TO authenticated;

-- Recurring pledges re-announce themselves. Idempotent — the unique index
-- above means running this twice in a day, or missing a day and catching up,
-- changes nothing that was already announced.
CREATE OR REPLACE FUNCTION pool_announce_recurring_month() RETURNS jsonb AS $$
DECLARE v_month date; v_count int;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, is_one_time,
                             status, announced_by_portal_user_id, announced_at)
  SELECT c.pool_id, c.id, v_month, c.monthly_amount_pkr, false,
         'announced', c.portal_user_id, now()
    FROM pool_commitments c
   WHERE c.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM pool_payments p
                      WHERE p.commitment_id = c.id AND p.for_month = v_month AND p.status <> 'cancelled')
  ON CONFLICT (commitment_id, for_month) WHERE status <> 'cancelled' AND commitment_id IS NOT NULL
    DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('announced', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_announce_recurring_month() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_announce_recurring_month() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('pool-announce-recurring', '0 4 * * *', 'SELECT pool_announce_recurring_month()');
  RAISE NOTICE 'pg_cron: recurring pool pledges re-announced daily at 09:00 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run pool_announce_recurring_month() from the Pools screen. %', SQLERRM;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- Withdrawing an announcement — the donor's own hand, any time before it is
-- confirmed
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pool_cancel_announcement(p_payment_id uuid) RETURNS jsonb AS $$
DECLARE p pool_payments%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id;
  IF NOT FOUND OR p.announced_by_portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001';
  END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'This has already been confirmed and can no longer be withdrawn from here.'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE pool_payments SET status = 'cancelled', cancelled_at = now() WHERE id = p_payment_id;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_cancel_announcement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_cancel_announcement(uuid) TO authenticated;

-- The donor's own evidence, attached whenever they are ready — optional, but
-- it is the fastest way for the accountant's queue to move.
CREATE OR REPLACE FUNCTION pool_attach_proof(p_payment_id uuid, p_proof_url text, p_method varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE p pool_payments%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id;
  IF NOT FOUND OR p.announced_by_portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001';
  END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'Already confirmed.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE pool_payments SET proof_url = p_proof_url, method = COALESCE(p_method, method) WHERE id = p_payment_id;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_attach_proof(uuid, text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_attach_proof(uuid, text, varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Confirming — the one place money actually becomes real
-- ═════════════════════════════════════════════════════════════════════════
-- Shared by both paths: the accountant typing up cash handed over in person
-- (pool_record_payment, unchanged signature) and confirming a donor's own
-- announcement (pool_confirm_payment, new). Whichever door the money came
-- through, it becomes a real donation, a real fund credit, and — for a
-- Kafalat pool — a real reduction against the measuring account, in exactly
-- one place, so those three can never drift out of step with each other.
CREATE OR REPLACE FUNCTION pool_post_confirmed_payment(
  p_pool_id uuid, p_commitment_id uuid, p_donor_name varchar, p_donor_name_ur varchar,
  p_donor_phone varchar, p_is_anonymous boolean, p_amount decimal, p_method varchar,
  p_portal_user_id uuid, p_month date, p_note text
) RETURNS jsonb AS $$
DECLARE pl support_pools%ROWTYPE; v_donor_id uuid; v_year varchar;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified,
                      payment_method, is_anonymous, fund_type, portal_user_id,
                      payment_status, notes, submitted_via)
  VALUES (p_donor_name, p_donor_name_ur, p_donor_phone, p_amount,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method, p_is_anonymous,
          pl.fund_type, p_portal_user_id, 'paid',
          pl.name || ' — ' || to_char(p_month, 'Mon YYYY') || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  IF p_commitment_id IS NOT NULL THEN
    UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
     WHERE id = p_commitment_id AND status = 'lapsed';
  END IF;

  IF pl.kind = 'kafalat' THEN
    v_year := kafalat_current_year();
    PERFORM kafalat_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'));
  END IF;

  RETURN jsonb_build_object('donor_id', v_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION pool_record_payment(
  p_commitment_id uuid, p_amount decimal, p_method varchar,
  p_for_month date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c pool_commitments%ROWTYPE; v_month date; v_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM pool_commitments WHERE id = p_commitment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commitment not found' USING ERRCODE = 'P0001'; END IF;

  v_month := COALESCE(date_trunc('month', p_for_month)::date,
                      date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date);

  v_posted := pool_post_confirmed_payment(c.pool_id, p_commitment_id, c.donor_name, c.donor_name_ur,
    c.donor_phone, c.is_anonymous, p_amount, p_method, c.portal_user_id, v_month, p_note);

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, method,
                             donor_id, note, created_by, status, confirmed_at, confirmed_by)
  VALUES (c.pool_id, p_commitment_id, v_month, p_amount, p_method,
          (v_posted->>'donor_id')::uuid, p_note, current_admin_user_id(),
          'confirmed', now(), current_admin_user_id())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('for_month', v_month, 'amount', p_amount,
                            'donor_id', v_posted->>'donor_id', 'payment_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Confirming an announcement the donor already made, rather than typing a new
-- one from scratch.
CREATE OR REPLACE FUNCTION pool_confirm_payment(p_payment_id uuid, p_method varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  p pool_payments%ROWTYPE; pl support_pools%ROWTYPE;
  c pool_commitments%ROWTYPE; v_donor_name varchar; v_donor_name_ur varchar; v_donor_phone varchar;
  v_anon boolean; v_portal_user_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'This is already %.', p.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO pl FROM support_pools WHERE id = p.pool_id;

  IF p.commitment_id IS NOT NULL THEN
    SELECT * INTO c FROM pool_commitments WHERE id = p.commitment_id;
    v_donor_name := c.donor_name; v_donor_name_ur := c.donor_name_ur; v_donor_phone := c.donor_phone;
    v_anon := c.is_anonymous; v_portal_user_id := c.portal_user_id;
  ELSE
    SELECT full_name, name_ur, mobile INTO v_donor_name, v_donor_name_ur, v_donor_phone
      FROM portal_users WHERE id = p.announced_by_portal_user_id;
    v_anon := false; v_portal_user_id := p.announced_by_portal_user_id;
  END IF;

  v_posted := pool_post_confirmed_payment(p.pool_id, p.commitment_id, v_donor_name, v_donor_name_ur,
    v_donor_phone, v_anon, p.amount_pkr, COALESCE(p_method, p.method, 'bank'), v_portal_user_id,
    p.for_month, NULL);

  UPDATE pool_payments
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
         donor_id = (v_posted->>'donor_id')::uuid,
         method = COALESCE(p_method, method, 'bank')
   WHERE id = p_payment_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'amount', p.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_confirm_payment(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_confirm_payment(uuid, varchar) TO authenticated;

-- Declining an announcement instead — a wrong amount, a duplicate, a name the
-- accountant cannot match to anything in the bank statement. Distinct from a
-- donor's own withdrawal so the reason is on record.
CREATE OR REPLACE FUNCTION pool_decline_announcement(p_payment_id uuid, p_reason text) RETURNS jsonb AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE pool_payments SET status = 'cancelled', cancelled_at = now(), note = COALESCE(note || ' · ', '') || p_reason
   WHERE id = p_payment_id AND status = 'announced';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or already resolved.' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_decline_announcement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_decline_announcement(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- What each side sees
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION my_pool_announcements() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool_id', p.pool_id, 'pool', pl.name, 'pool_ur', pl.name_ur,
    'amount', p.amount_pkr, 'is_one_time', p.is_one_time, 'month', p.for_month,
    'status', p.status, 'has_proof', p.proof_url IS NOT NULL,
    'show_name_publicly', p.show_name_publicly, 'announced_at', p.announced_at
  ) ORDER BY p.announced_at DESC)
  , '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.announced_by_portal_user_id = current_portal_user_id()
    AND p.status IN ('announced', 'confirmed')
    AND p.announced_at > now() - interval '2 years';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_pool_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pool_announcements() TO authenticated;

-- The accountant's queue — announced pledges waiting for a tap, oldest first
-- so nobody is kept waiting longer than somebody who announced after them.
CREATE OR REPLACE FUNCTION pool_announcement_queue() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool', pl.name, 'donor_name',
    COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)),
    'donor_phone',
    COALESCE((SELECT mobile FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_phone FROM pool_commitments WHERE id = p.commitment_id)),
    'amount', p.amount_pkr, 'is_one_time', p.is_one_time, 'month', p.for_month,
    'proof_url', p.proof_url, 'announced_at', p.announced_at
  ) ORDER BY p.announced_at), '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.status = 'announced';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_announcement_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_announcement_queue() TO authenticated;

-- The public board: totals always, names only where offered and only once
-- paid. A pledge is not a debt and is never named here — only the figure
-- that recruits, and the people who have actually finished paying.
CREATE OR REPLACE FUNCTION pool_public_board(p_pool_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'position', pool_position(p_pool_id),
    'recent_paid', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', x.name, 'amount', x.amount_pkr, 'month', x.for_month)
                       ORDER BY x.confirmed_at DESC)
        FROM (
          SELECT COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
                          (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)) AS name,
                 p.amount_pkr, p.for_month, p.confirmed_at
            FROM pool_payments p
           WHERE p.pool_id = p_pool_id AND p.status = 'confirmed' AND p.show_name_publicly
           ORDER BY p.confirmed_at DESC LIMIT 50
        ) x
    ), '[]'::jsonb)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_public_board(uuid) TO anon, authenticated;

-- ── Permissions ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS pool_payments_read_own ON pool_payments;
CREATE POLICY pool_payments_read_own ON pool_payments FOR SELECT TO authenticated
  USING (announced_by_portal_user_id = current_portal_user_id()
         OR EXISTS (SELECT 1 FROM pool_commitments c
                     WHERE c.id = pool_payments.commitment_id
                       AND c.portal_user_id = current_portal_user_id()));

-- ═════════════════════════════════════════════════════════════════════════
-- Fixing what announcing broke: three readers that trusted every row in
-- pool_payments was real money
-- ═════════════════════════════════════════════════════════════════════════
-- Found by driving the flow end to end: two donors announced Rs 2,000 and
-- Rs 3,000 for the current month, neither confirmed, and pool_position()
-- reported "received_this_month": 5000. Nobody had actually paid anything.
--
-- Before this migration every pool_payments row WAS real money — the table
-- only had one writer, the accountant. Adding the announced state means a
-- second class of row now lives in the same table, and every place that
-- summed pool_payments without asking which kind it was summing inherited
-- the same defect the "cash received" button had: a status that looks like
-- money without any money behind it.
--
-- Three places needed the filter added:
--
--   pool_position() — 'received_this_month' counted announced pledges as
--     received, so a coverage bar and a donor count could both read "fully
--     covered" on a month where not one rupee had actually arrived.
--
--   my_pool_commitments() — 'paid_this_month', 'months_given' and
--     'total_given' all counted announcements, so a donor's own portal would
--     have told them they had paid for months they had only promised.
--
--   pool_close_month() — worse than a display bug: the lapse check used
--     "a pool_payments row exists for this month" to decide whether somebody
--     had paid. An announced-but-never-confirmed pledge satisfied that check,
--     so that donor would never be flagged lapsed, never appear in the
--     accountant's list of who to ring, and the shortfall the committee saw
--     would be understated by exactly what they had promised and not sent.
CREATE OR REPLACE FUNCTION pool_position(p_pool_id uuid) RETURNS jsonb AS $$
DECLARE
  p support_pools%ROWTYPE;
  v_target decimal; v_committed decimal; v_donors int;
  v_month date; v_received decimal; v_announced decimal; v_reserve decimal; v_gap decimal;
  v_covered decimal;
BEGIN
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;
  v_target := pool_monthly_target(p_pool_id);

  SELECT COALESCE(SUM(monthly_amount_pkr), 0), count(*)
    INTO v_committed, v_donors
    FROM pool_commitments WHERE pool_id = p_pool_id AND status = 'active';

  -- Real money only. An announcement is a promise, not a receipt.
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_received
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month AND status = 'confirmed';

  -- Reported alongside it rather than folded in, so the accountant's own
  -- dashboard can see "5,000 announced, 0 confirmed" instead of one number
  -- that quietly means either.
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_announced
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month AND status = 'announced';

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
    'announced_this_month', v_announced,
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

CREATE OR REPLACE FUNCTION my_pool_commitments() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'pool', p.name, 'pool_ur', p.name_ur, 'pool_id', p.id,
    'monthly_amount', c.monthly_amount_pkr, 'status', c.status,
    'funded_by', c.funded_by, 'started_on', c.started_on,
    'paid_this_month', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                                  WHERE commitment_id = c.id AND status = 'confirmed'
                                    AND for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date), 0),
    'announced_this_month', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                                  WHERE commitment_id = c.id AND status = 'announced'
                                    AND for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date), 0),
    'months_given', (SELECT count(DISTINCT for_month) FROM pool_payments
                      WHERE commitment_id = c.id AND status = 'confirmed'),
    'total_given', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                              WHERE commitment_id = c.id AND status = 'confirmed'), 0)
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  FROM pool_commitments c JOIN support_pools p ON p.id = c.pool_id
  WHERE c.portal_user_id = current_portal_user_id()
    AND c.status <> 'cancelled';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

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
  -- Real money only — an unconfirmed announcement must not read as paid, or
  -- the month closes as covered when nothing has actually landed.
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_received
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month AND status = 'confirmed';
  SELECT COALESCE(committee_covered_pkr, 0) INTO v_covered
    FROM pool_months WHERE pool_id = p_pool_id AND month = v_month;

  -- The gap the donors left, recorded before any committee money is counted.
  -- Netting the cover off here would erase the very thing this row exists to
  -- remember: re-running the close would turn "we were 7,000 short and the
  -- committee paid it" into "we were fine and the committee gave 7,000 anyway".
  -- What is still outstanding is shortfall_pkr - committee_covered_pkr.
  v_short := GREATEST(v_target - v_received, 0);

  -- A commitment with no CONFIRMED payment this month is lapsed. An
  -- announcement sitting unconfirmed is exactly the case this has to catch —
  -- someone who said they would pay and did not is precisely who the
  -- accountant needs to ring, not someone the close should quietly excuse.
  UPDATE pool_commitments c SET status = 'lapsed', lapsed_at = now(), updated_at = now()
   WHERE c.pool_id = p_pool_id AND c.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM pool_payments pp
                      WHERE pp.commitment_id = c.id AND pp.for_month = v_month AND pp.status = 'confirmed');

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
