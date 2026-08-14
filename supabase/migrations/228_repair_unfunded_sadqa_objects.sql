-- Migration 228: put the objects the old button lied about back to the truth.
--
-- The status buttons in migration 210's admin screen wrote the status column
-- directly, so pressing "cash received" moved an object to 'funded' without a
-- voucher, a ledger row, a donation, or even a figure in amount_received_pkr.
-- At the time of writing, live carries exactly one such row:
--
--   ESW-0001   status 'funded'   amount_received_pkr 0
--
-- The donor saw their offer marked as paid and then as purchased while their
-- own account showed no transaction, because there was none.
--
-- These rows are walked back to the last status that is actually true —
-- 'approved', which is a decision the committee really did make — so the
-- receipt flow from migration 225 can record the money properly, with the
-- transfer slip or a named witness behind it. Nothing is deleted: the object,
-- the dedication and the plaque text all stay exactly as the donor entered
-- them, and the register keeps its number.
UPDATE sadqa_objects
   SET status = 'approved',
       updated_at = now()
 WHERE status IN ('funded', 'procured', 'installed', 'in_service')
   AND COALESCE(amount_received_pkr, 0) = 0
   AND settled_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM sadqa_receipts r WHERE r.object_id = sadqa_objects.id);

-- Objects that never got their approval timestamp either, for the same reason.
UPDATE sadqa_objects
   SET approved_at = COALESCE(approved_at, created_at)
 WHERE status = 'approved' AND approved_at IS NULL;
