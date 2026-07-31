-- Migration 019: Backfill phantom "paid" bills with real payment records.
--
-- Live investigation (triggered by a user report that a fully-paid consumer bill
-- still showed a "Receive Payment" option) found that 19 of 20 bills.status='paid'
-- rows have paid_amount=0 and no matching payments row at all — the original seed
-- data (migration 003) hardcoded status='paid' directly without ever creating a
-- payment, so migration 007's later backfill (which only looked at paid_amount > 0)
-- missed them entirely. Net effect: these consumers' ledgers only ever had the bill's
-- debit posted, never the offsetting credit, so their real running balance has been
-- silently overstated by the bill amount this whole time, even though the status
-- badge said "Paid". Inserting the missing payment fires the existing payment
-- trigger, which posts the correct credit entry and re-derives paid_amount/status
-- (idempotent — a no-op for any bill that already has a real payment on file).
INSERT INTO payments (bill_id, consumer_id, amount_pkr, method, paid_date, note)
SELECT b.id, b.consumer_id, b.amount_pkr, 'cash',
       make_date(b.year, b.month, 1),
       'Backfilled — bill was marked paid in original records with no payment on file'
FROM bills b
WHERE b.status = 'paid'
  AND b.paid_amount < b.amount_pkr
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.bill_id = b.id);
