-- Migration 042: Fix a real pre-existing bug, caught while testing the new recurring
-- "every_minute" frequency — migration 014 pinned trg_voucher_before_insert() to
-- SET search_path = public (for RLS/security-definer safety), but gen_random_bytes()
-- lives in the `extensions` schema on this project, not `public`. Any voucher that
-- requires approval (a cash withdrawal, or a cash-paid expense) hit the
-- approval-token branch and failed outright with "function gen_random_bytes(integer)
-- does not exist" — meaning no cash withdrawal or cash-paid expense could ever be
-- saved since that migration. Schema-qualifying the call removes the dependency on
-- search_path entirely, so it can't regress again the same way.

DROP FUNCTION IF EXISTS debug_recurring_diag();

CREATE OR REPLACE FUNCTION trg_voucher_before_insert() RETURNS trigger AS $$
DECLARE
  v_from_type varchar;
  v_requires_approval boolean;
BEGIN
  SELECT type INTO v_from_type FROM accounts WHERE id = NEW.from_account_id;
  v_requires_approval := NEW.voucher_type = 'withdrawal'
    OR (NEW.voucher_type = 'expense' AND v_from_type = 'cash');

  IF v_requires_approval THEN
    NEW.status := 'pending';
    NEW.voucher_no := NULL;
    NEW.approval_token := encode(extensions.gen_random_bytes(20), 'hex');
  ELSE
    NEW.status := 'posted';
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
  END IF;

  IF NEW.voucher_type = 'security_deposit' AND NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
