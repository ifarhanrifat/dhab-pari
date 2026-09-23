-- Removes the temporary verification function from migration 506, its job
-- done -- confirmed live that donor_receipt_totals() now returns 27,000
-- for both of Jamal S/O Haji Gulzar's donation rows.
DROP FUNCTION IF EXISTS _debug_donor_receipt_totals(uuid);
