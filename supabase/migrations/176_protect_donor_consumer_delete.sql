-- Migration 176: refuse to delete a donor or a consumer that money is attached to.
--
-- Enforced with BEFORE DELETE triggers rather than checks in the admin screens,
-- because a rule that only lives in one page is not a rule: the same delete can
-- arrive from the donors list, the bulk-select bar, the account statement page,
-- the transactions workspace, or a direct PostgREST call. The database is the
-- one place all of them pass through.
--
-- Consumers were the more dangerous of the two: bills and payments are
-- ON DELETE CASCADE, so removing one consumer silently took their entire
-- billing history with it and left the ledger describing money that no longer
-- had a payer.

-- ── Donors ───────────────────────────────────────────────────────────────
-- Deletable: an announced pledge only — a promise with no money behind it and
-- nothing posted to the ledger. Once a donor has paid (awaiting confirmation)
-- or the committee has confirmed it (received), the record has to stay.
CREATE OR REPLACE FUNCTION trg_protect_donor_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.is_verified THEN
    RAISE EXCEPTION 'Cannot delete this donation — Rs. % from % is confirmed and posted to the ledger. Unverify it first if it was recorded in error.',
      OLD.amount_pkr, COALESCE(OLD.name, 'this donor');
  END IF;

  IF COALESCE(OLD.payment_status, 'paid') <> 'pledged' THEN
    RAISE EXCEPTION 'Cannot delete this donation — % has recorded a payment of Rs. % that is still awaiting confirmation. Confirm or reject it first.',
      COALESCE(OLD.name, 'this donor'), OLD.amount_pkr;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_donor_delete_trigger ON donors;
-- Name starts with a digit so it sorts before audit_capture_* — Postgres fires
-- BEFORE triggers in name order, and there is no point writing an audit row for
-- a delete that is about to be refused.
CREATE TRIGGER "0_protect_donor_delete_trigger" BEFORE DELETE ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_protect_donor_delete();

-- ── Consumers ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_protect_consumer_delete() RETURNS trigger AS $$
DECLARE
  v_bills int;
  v_payments int;
  v_vouchers int;
  v_outstanding numeric;
BEGIN
  SELECT count(*) INTO v_bills FROM bills WHERE consumer_id = OLD.consumer_id;
  SELECT count(*) INTO v_payments FROM payments WHERE consumer_id = OLD.consumer_id;
  SELECT count(*) INTO v_vouchers FROM vouchers WHERE consumer_id = OLD.consumer_id;

  SELECT COALESCE(SUM(GREATEST(b.amount_pkr - COALESCE(b.paid_amount, 0), 0)), 0)
    INTO v_outstanding FROM bills b WHERE b.consumer_id = OLD.consumer_id;

  IF v_outstanding > 0 THEN
    RAISE EXCEPTION 'Cannot delete consumer % (%) — Rs. % is still outstanding across % bill(s). Settle or write off the balance first.',
      OLD.consumer_id, COALESCE(OLD.name, ''), v_outstanding, v_bills;
  END IF;

  IF v_payments > 0 THEN
    RAISE EXCEPTION 'Cannot delete consumer % (%) — % payment(s) have been received from them. Delete the receipts first if this record was created in error.',
      OLD.consumer_id, COALESCE(OLD.name, ''), v_payments;
  END IF;

  IF v_bills > 0 THEN
    RAISE EXCEPTION 'Cannot delete consumer % (%) — % bill(s) are recorded against them. Delete the bills first if this record was created in error.',
      OLD.consumer_id, COALESCE(OLD.name, ''), v_bills;
  END IF;

  IF v_vouchers > 0 THEN
    RAISE EXCEPTION 'Cannot delete consumer % (%) — % voucher(s) reference them (security deposit, waiver or reconnection). Remove those first.',
      OLD.consumer_id, COALESCE(OLD.name, ''), v_vouchers;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_consumer_delete_trigger ON consumers;
CREATE TRIGGER "0_protect_consumer_delete_trigger" BEFORE DELETE ON consumers
  FOR EACH ROW EXECUTE FUNCTION trg_protect_consumer_delete();
