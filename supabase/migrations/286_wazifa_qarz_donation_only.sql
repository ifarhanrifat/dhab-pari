-- Migration 286: qarz-e-hasana money a donor gives is a donation, full
-- stop — no withdrawal, no reclaim, the same as every other gift here.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why (researched, not guessed)
-- ═════════════════════════════════════════════════════════════════════════
-- Every long-running interest-free-loan charity that actually works this
-- way solves the "donor wants their money back but it's tied up in a
-- multi-year student loan" problem by never creating that right in the
-- first place. Akhuwat — the largest qard-al-hasan network anywhere —
-- funds its revolving pool from zakat/infaq/sadaqah/waqf donations, not
-- repayable deposits; nobody has a claim on the capital, the pool stays
-- solvent because loan recovery runs above 99%, not because it holds a
-- cash buffer against donor withdrawals. Hebrew Free Loan Society is
-- explicit about it: "donors forgo all rights to these monies." A gemach
-- works the same way. None of them have a "withdraw" button, and that is
-- exactly why none of them have a duration-mismatch liquidity risk.
--
-- migration 280 built the other thing — a donor's gift tracked as
-- reclaimable, with a withdraw/convert/redirect menu — on the reasoning
-- that a donor might want this specific money back. Nobody has ever
-- actually used it (checked live: zero qarz_e_hasana commitments, zero
-- wazifa_qarz_actions rows), so this removes it cleanly rather than
-- migrating data that doesn't exist. A donor sponsoring a Wazifa student
-- now only ever gives as sadqa or general — same as Kafalat, same as
-- everything else in this app. What the STUDENT owes the committee is a
-- separate, unaffected relationship (wazifa_awards.is_loan) — that money
-- still gets collected, it just funds the next student instead of being
-- earmarked to return to one specific original giver.

DROP FUNCTION IF EXISTS wazifa_request_qarz_action(uuid, varchar, decimal, uuid, text);
DROP FUNCTION IF EXISTS wazifa_fulfill_qarz_action(uuid);
DROP FUNCTION IF EXISTS wazifa_decline_qarz_action(uuid, text);
DROP FUNCTION IF EXISTS my_qarz_e_hasana();
DROP TABLE IF EXISTS wazifa_qarz_actions;

DROP TRIGGER IF EXISTS pool_commitment_qarz_validation ON pool_commitments;
DROP FUNCTION IF EXISTS trg_pool_commitment_qarz_validation();

ALTER TABLE pool_commitments DROP CONSTRAINT IF EXISTS pool_commitments_funded_by_check;
ALTER TABLE pool_commitments ADD CONSTRAINT pool_commitments_funded_by_check
  CHECK (funded_by IN ('sadqa', 'general'));

ALTER TABLE pool_commitments
  DROP COLUMN IF EXISTS qarz_reclaimed_pkr,
  DROP COLUMN IF EXISTS qarz_actioned_pkr;

-- The allocation tracker becomes a no-op rather than being ripped out of
-- its three call sites (wazifa_pay_installment_charge, _advance,
-- wazifa_record_repayment) — same signature, so nothing else has to be
-- touched or re-overloaded.
CREATE OR REPLACE FUNCTION wazifa_allocate_qarz_repayment(p_student_id uuid, p_amount decimal) RETURNS void AS $$
BEGIN
  RETURN;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_allocate_qarz_repayment(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_allocate_qarz_repayment(uuid, decimal) TO authenticated;
