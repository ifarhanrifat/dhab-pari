-- Migration 267: a donor announcing Rs 10,000 and actually sending Rs 9,000
-- had nowhere to go. confirm_donation() lets the amount be edited at
-- confirm time, but amount_pkr is the only figure there is -- edit it down
-- and the original ask is gone, with no record it was ever 10,000.
-- pool_confirm_payment() (Kafalat/Wazifa/Sadqa) is worse: no amount
-- parameter at all, so a real Rs 9,000 receipt against a Rs 10,000
-- announcement literally could not be recorded as anything other than the
-- full announced figure.
--
-- Fix: announced_amount_pkr is a snapshot taken once, at the moment a
-- pledge/announcement is made, and never touched again. amount_pkr keeps
-- meaning exactly what it already means everywhere in this codebase --
-- the real, confirmed, currently-payable-into-the-ledger figure -- so
-- every existing function that reads it for reporting/posting needs no
-- change at all. The only new thing is a label, computed by comparing the
-- two: 'partial' when confirmed-but-short, same as 'announced'/'awaiting'/
-- 'confirmed' already work.
ALTER TABLE donors ADD COLUMN IF NOT EXISTS announced_amount_pkr decimal;
UPDATE donors SET announced_amount_pkr = amount_pkr WHERE announced_amount_pkr IS NULL;
ALTER TABLE donors ALTER COLUMN announced_amount_pkr SET NOT NULL;
ALTER TABLE donors ALTER COLUMN announced_amount_pkr SET DEFAULT NULL;

CREATE OR REPLACE FUNCTION trg_donors_snapshot_announced() RETURNS trigger AS $$
BEGIN
  IF NEW.announced_amount_pkr IS NULL THEN
    NEW.announced_amount_pkr := NEW.amount_pkr;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS donors_snapshot_announced ON donors;
CREATE TRIGGER donors_snapshot_announced BEFORE INSERT ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donors_snapshot_announced();

ALTER TABLE pool_payments ADD COLUMN IF NOT EXISTS announced_amount_pkr decimal;
UPDATE pool_payments SET announced_amount_pkr = amount_pkr WHERE announced_amount_pkr IS NULL;
ALTER TABLE pool_payments ALTER COLUMN announced_amount_pkr SET NOT NULL;
ALTER TABLE pool_payments ALTER COLUMN announced_amount_pkr SET DEFAULT NULL;

CREATE OR REPLACE FUNCTION trg_pool_payments_snapshot_announced() RETURNS trigger AS $$
BEGIN
  IF NEW.announced_amount_pkr IS NULL THEN
    NEW.announced_amount_pkr := NEW.amount_pkr;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pool_payments_snapshot_announced ON pool_payments;
CREATE TRIGGER pool_payments_snapshot_announced BEFORE INSERT ON pool_payments
  FOR EACH ROW EXECUTE FUNCTION trg_pool_payments_snapshot_announced();

-- The accountant can now confirm a different amount than what was
-- announced -- amount_pkr becomes the real, actually-received figure
-- (exactly what every downstream expense/requirement calculation already
-- assumes it means), announced_amount_pkr stays exactly what was asked
-- for.
CREATE OR REPLACE FUNCTION pool_confirm_payment(
  p_payment_id uuid, p_method varchar DEFAULT NULL, p_confirmed_amount decimal DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  p pool_payments%ROWTYPE; pl support_pools%ROWTYPE;
  c pool_commitments%ROWTYPE; v_donor_name varchar; v_donor_name_ur varchar; v_donor_phone varchar;
  v_anon boolean; v_portal_user_id uuid; v_posted jsonb; v_amount decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'This is already %.', p.status USING ERRCODE = 'P0001';
  END IF;
  IF p_confirmed_amount IS NOT NULL AND p_confirmed_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be more than zero.' USING ERRCODE = 'P0001';
  END IF;
  v_amount := COALESCE(p_confirmed_amount, p.amount_pkr);
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
    v_donor_phone, v_anon, v_amount, COALESCE(p_method, p.method, 'bank'), v_portal_user_id,
    p.for_month, NULL, p.kafalat_child_id, p.wazifa_student_id, p.sadqa_object_id);

  UPDATE pool_payments
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
         donor_id = (v_posted->>'donor_id')::uuid,
         method = COALESCE(p_method, method, 'bank'),
         amount_pkr = v_amount
   WHERE id = p_payment_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'amount', v_amount, 'announced_amount', p.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_confirm_payment(uuid, varchar, decimal) TO authenticated;

-- What the donor's own "My Giving" page needs: recent confirmed pool
-- payments, pledged vs received, so a shortfall is visible instead of a
-- single ambiguous number.
CREATE OR REPLACE FUNCTION my_recent_pool_receipts() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool', pl.name, 'pool_ur', pl.name_ur, 'for_month', p.for_month,
    'confirmed_at', p.confirmed_at, 'amount_pkr', p.amount_pkr, 'announced_amount_pkr', p.announced_amount_pkr,
    'particular', pl.name || COALESCE(
      (SELECT ' — ' || first_name FROM kafalat_children WHERE id = p.kafalat_child_id),
      (SELECT ' — ' || full_name FROM wazifa_students WHERE id = p.wazifa_student_id),
      (SELECT ' — ' || item_name FROM sadqa_objects WHERE id = p.sadqa_object_id), '')
  ) ORDER BY p.confirmed_at DESC), '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.status = 'confirmed'
    AND (p.commitment_id IN (SELECT id FROM pool_commitments WHERE portal_user_id = current_portal_user_id())
         OR p.announced_by_portal_user_id = current_portal_user_id())
    AND p.confirmed_at > now() - interval '6 months';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_recent_pool_receipts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_recent_pool_receipts() TO authenticated;
