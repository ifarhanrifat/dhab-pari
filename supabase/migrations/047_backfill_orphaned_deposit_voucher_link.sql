-- Migration 047: One security-deposit voucher predated bills.security_deposit_voucher_id
-- ever being set (an early test bill, before that linkage was wired up in the Generate
-- Bill save flow), so migration 046's join-based backfill couldn't find it — bill_id
-- stayed null and its ledger rows are still missing bill_number. Falls back to parsing
-- the bill number already embedded in the voucher's own particular text
-- ("... — Bill WB-00045") for any voucher the primary backfill missed.

UPDATE vouchers v SET bill_id = b.id
FROM bills b
WHERE v.voucher_type = 'security_deposit' AND v.bill_id IS NULL
  AND v.particular LIKE '%Bill ' || b.bill_number;

UPDATE ledger_entries le SET
  bill_number = b.bill_number,
  receipt_no = COALESCE(le.receipt_no, v.receipt_no)
FROM vouchers v JOIN bills b ON b.id = v.bill_id
WHERE le.reference_type = 'voucher' AND le.reference_id = v.id AND v.bill_id IS NOT NULL AND le.bill_number IS NULL;
