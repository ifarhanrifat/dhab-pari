-- Migration 378: the portal dashboard's Projects/Academies cards (and the
-- public projects page's Spent figure, which shares this view) were
-- showing wrong numbers for two separate reasons that both trace back to
-- the same gap — neither the expense view nor the missing income
-- equivalent understood voucher reversals:
--
--   1. project_expenses_public counted every ledger_entries row with
--      debit > 0 as a real expense, with no idea a reversal voucher (or
--      the original voucher it reversed) even exists. A reversed academy
--      fee charge — reverse_voucher() swaps from/to accounts, so the
--      reversal's own leg on the project's account is a debit — showed
--      up as real money spent, even though the whole point of a reversal
--      is that nothing actually happened.
--
--   2. There was no credit-side equivalent at all. Training academy fees
--      (366) post straight to the project's ledger account via a
--      voucher, never through the donors table, so donors_public — the
--      only source the "Raised" figure ever had — was structurally blind
--      to every academy fee payment, real or reversed.
--
-- Both fixed the same way: a reversed voucher and the reversal that
-- undoes it should net to zero and vanish from these totals entirely —
-- the ledger rows themselves stay exactly as they are (reverse_voucher's
-- audit trail is permanent and correct; see NULL-auth-check /
-- closed-month-policy conventions elsewhere), only the reporting learns
-- to skip the cancelled-out pair.

CREATE OR REPLACE VIEW project_expenses_public AS
SELECT a.project_id, le.id, le.entry_date, le.particular, le.debit
FROM ledger_entries le
JOIN accounts a ON a.id = le.account_id
JOIN projects p ON p.id = a.project_id
LEFT JOIN vouchers v ON le.reference_type = 'voucher' AND v.id = le.reference_id
WHERE a.project_id IS NOT NULL AND le.debit > 0
  AND p.is_private = false AND p.hide_expenses = false
  AND (v.id IS NULL OR (v.reverses_voucher_id IS NULL AND v.reversed_by_voucher_id IS NULL));

-- The credit-side counterpart project_expenses_public never had — every
-- real credit to a project's account (donations, training fees, anything
-- else that ever posts there), same reversal-pair exclusion, same
-- privacy gating as donors_public (hide_donations/is_private) since this
-- is exactly what "how much has this project received" means, just not
-- restricted to rows that happen to live in the donors table.
CREATE OR REPLACE VIEW project_income_public AS
SELECT a.project_id, le.id, le.entry_date, le.particular, le.credit
FROM ledger_entries le
JOIN accounts a ON a.id = le.account_id
JOIN projects p ON p.id = a.project_id
LEFT JOIN vouchers v ON le.reference_type = 'voucher' AND v.id = le.reference_id
WHERE a.project_id IS NOT NULL AND le.credit > 0
  AND p.is_private = false AND p.hide_donations = false
  AND (v.id IS NULL OR (v.reverses_voucher_id IS NULL AND v.reversed_by_voucher_id IS NULL));

GRANT SELECT ON project_expenses_public TO anon, authenticated;
GRANT SELECT ON project_income_public TO anon, authenticated;
