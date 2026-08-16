-- Migration 253: the existing "Payment Methods" settings section
-- (jazzcash_number, easypaisa_number, bank_name, bank_account, bank_branch)
-- turns out to be write-only — nothing in the app has ever read these keys
-- back (every "send to" block on every page uses the hardcoded SITE
-- constants instead). Replaced with two full sets, donor_* and water_*,
-- since the committee actually uses different accounts for each — plus the
-- fields a real bank transfer needs that were missing entirely: account
-- title (beneficiary name), a proper account number separate from the IBAN,
-- and a branch code.
--
-- Seeded with the same placeholder values the old keys had (nobody had
-- entered real data into them — confirmed live, every value still matched
-- the code fallback exactly) so there is nothing real to lose here.
INSERT INTO site_settings (key, value, description) VALUES
  ('donor_jazzcash_number', '0300-0000000', 'Donor & Projects — JazzCash number donors send to'),
  ('donor_jazzcash_name', 'Dhab Pari Welfare', 'Donor & Projects — JazzCash account title'),
  ('donor_easypaisa_number', '0345-0000000', 'Donor & Projects — Easypaisa number donors send to'),
  ('donor_easypaisa_name', 'DP Welfare Committee', 'Donor & Projects — Easypaisa account title'),
  ('donor_bank_name', 'HBL', 'Donor & Projects — bank name'),
  ('donor_bank_account_title', 'Dhab Pari Water & Welfare Committee', 'Donor & Projects — bank account title / beneficiary name'),
  ('donor_bank_account_number', '0012 3456 7890 12', 'Donor & Projects — bank account number'),
  ('donor_bank_iban', 'PK00 MCBA 0012 3456 7890 12', 'Donor & Projects — IBAN, for international transfers'),
  ('donor_bank_branch', 'Dhab Pari Water & Welfare Branch', 'Donor & Projects — bank branch name'),
  ('donor_bank_branch_code', '0000', 'Donor & Projects — bank branch code'),

  ('water_jazzcash_number', '0300-0000000', 'Water Supply — JazzCash number consumers send to'),
  ('water_jazzcash_name', 'Dhab Pari Welfare', 'Water Supply — JazzCash account title'),
  ('water_easypaisa_number', '0345-0000000', 'Water Supply — Easypaisa number consumers send to'),
  ('water_easypaisa_name', 'DP Welfare Committee', 'Water Supply — Easypaisa account title'),
  ('water_bank_name', 'HBL', 'Water Supply — bank name'),
  ('water_bank_account_title', 'Dhab Pari Water & Welfare Committee', 'Water Supply — bank account title / beneficiary name'),
  ('water_bank_account_number', '0012 3456 7890 12', 'Water Supply — bank account number'),
  ('water_bank_iban', 'PK00 MCBA 0012 3456 7890 12', 'Water Supply — IBAN, for international transfers'),
  ('water_bank_branch', 'Dhab Pari Water & Welfare Branch', 'Water Supply — bank branch name'),
  ('water_bank_branch_code', '0000', 'Water Supply — bank branch code')
ON CONFLICT (key) DO NOTHING;
