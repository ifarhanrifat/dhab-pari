-- Migration 526: per-method payment toggles for Settings > Payment Accounts.
--
-- Real ask, 2026-09-29: "make a check box there when marked those accounts
-- will be listed as payment option on the all payment pages, like if we
-- check only the bank channel then that bank channel will be listed for
-- payments for the donors and for the water account both separately."
--
-- getPaymentAccount() (src/lib/paymentAccounts.ts) already reads these keys
-- and treats a missing row as enabled, so this seed changes nothing about
-- current behavior -- it just gives the Settings page's checkbox area a
-- documented row to show/edit instead of appearing blank. Only bank/cash
-- are seeded for donors since the donor-facing pages never offered
-- jazzcash/easypaisa as choices in the first place.
INSERT INTO site_settings (key, value, description) VALUES
  ('water_enable_jazzcash', 'true', 'Whether JazzCash is offered as a payment method on water-bill payment pages.'),
  ('water_enable_easypaisa', 'true', 'Whether Easypaisa is offered as a payment method on water-bill payment pages.'),
  ('water_enable_bank', 'true', 'Whether bank transfer is offered as a payment method on water-bill payment pages.'),
  ('water_enable_cash', 'true', 'Whether cash / walk-in is offered as a payment method on water-bill payment pages.'),
  ('donor_enable_bank', 'true', 'Whether bank transfer is offered as a payment method on donor payment pages.'),
  ('donor_enable_cash', 'true', 'Whether cash is offered as a payment method on donor payment pages.')
ON CONFLICT (key) DO NOTHING;
