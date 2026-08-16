-- Migration 262: migration 261's own correction was booked on the wrong side.
--
-- kafalat_post_requirement_delta() has one convention: a negative delta is
-- a credit -- the shape a real donor payment takes when it lands on this
-- account. Migration 261 reused that same function to walk each child's
-- mis-stated requirement back down, so the correction landed as a credit
-- too -- indistinguishable, to kafalat_measuring_position() /
-- kafalat_public_dashboard() (required = SUM(debit), confirmed =
-- SUM(credit)), from a real donor's confirmed payment. Both aggregates came
-- out wrong by the same amount in opposite directions -- required inflated
-- to Rs 203,500, "received so far" inflated to Rs 62,000 -- even though
-- "Rs 141,500 still needed" happened to net out correctly, which is exactly
-- what the donor portal's own stats page showed and got flagged for.
--
-- The right fix for "the original requirement figure was miscalculated" is
-- to correct the requirement side directly, not manufacture a payment that
-- never happened. This removes the credit-side correction rows migration
-- 261 posted, and corrects the original approval debit entries to the real
-- figure instead -- on both the measuring account and each child's own
-- account, the same two places every requirement posting always lands.
DELETE FROM ledger_entries
 WHERE particular LIKE '%correction: duplicate package lines removed';

UPDATE ledger_entries le
   SET debit = kafalat_this_year_requirement(
     kc.id, (SELECT academic_year FROM kafalat_package_lines WHERE child_id = kc.id LIMIT 1)
   )
  FROM kafalat_children kc
 WHERE le.particular LIKE '%(' || kc.code || ') approved%';
