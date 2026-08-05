-- Migration 081: security_deposit vouchers stopped getting a receipt_no.
-- Migration 040 added the auto-assignment ("IF voucher_type = 'security_deposit'
-- AND receipt_no IS NULL THEN receipt_no := next_receipt_no()"), but migration
-- 060 rewrote trg_voucher_before_insert() for the multi-approver workflow and
-- silently dropped that block — 061 refined it further but never restored it.
-- Every security deposit voucher created since (including the New Connections
-- Cash Receive flow) has had a NULL receipt_no as a result.

CREATE OR REPLACE FUNCTION trg_voucher_before_insert() RETURNS trigger AS $$
DECLARE
  v_requires_approval boolean;
  v_has_approvers boolean;
BEGIN
  v_requires_approval := NEW.voucher_type IN ('withdrawal', 'expense') AND approval_type_enabled(NEW.system, NEW.voucher_type);
  IF v_requires_approval THEN
    SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = NEW.system AND is_active = true) INTO v_has_approvers;
    v_requires_approval := v_has_approvers;
  END IF;

  IF v_requires_approval THEN
    NEW.status := 'pending';
    NEW.voucher_no := NULL;
  ELSE
    NEW.status := 'posted';
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
  END IF;

  IF NEW.voucher_type IN ('security_deposit', 'security_deposit_refund') AND NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill every currently-orphaned security deposit voucher (receipt_no on
-- the voucher itself, plus the two ledger_entries rows it already posted,
-- which trg_voucher_ledger only stamps at INSERT time and won't pick up a
-- later UPDATE automatically) — and give it the same
-- "consumer name — Bill #" particular format the regular Generate Bill flow
-- already uses, instead of just the request number.
DO $$
DECLARE
  v record;
  v_receipt varchar;
  v_particular text;
BEGIN
  FOR v IN
    SELECT vo.id, vo.bill_id, b.bill_number, c.name AS consumer_name
    FROM vouchers vo
    LEFT JOIN bills b ON b.id = vo.bill_id
    LEFT JOIN consumers c ON c.consumer_id = b.consumer_id
    WHERE vo.voucher_type = 'security_deposit' AND vo.receipt_no IS NULL
  LOOP
    v_receipt := next_receipt_no();
    v_particular := CASE
      WHEN v.consumer_name IS NOT NULL AND v.bill_number IS NOT NULL
        THEN 'Security deposit — ' || v.consumer_name || ' — Bill ' || v.bill_number
      ELSE (SELECT particular FROM vouchers WHERE id = v.id)
    END;
    UPDATE vouchers SET receipt_no = v_receipt, particular = v_particular WHERE id = v.id;
    UPDATE ledger_entries SET receipt_no = v_receipt, particular = v_particular
      WHERE reference_type = 'voucher' AND reference_id = v.id;
  END LOOP;
END $$;
