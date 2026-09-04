-- Migration 443: give the thermal slip a paper width the committee can set
-- themselves, and stop two settings descriptions from promising a fallback
-- that the code has never done.

-- 1. Thermal paper width, per system ------------------------------------
-- Until now the slip hardcoded one width (181px = the 48mm printable strip
-- of a 58mm roll — see migration-era commit "build the thermal slip for the
-- 58mm roll it actually prints on"). That number was right for the printer
-- the committee owns today, but it was a constant in a React component:
-- when a printout came out misaligned nobody could do anything about it
-- without a code change and a deploy.
--
-- 58 and 80 are the only two sizes that matter here — every cheap Bluetooth
-- receipt printer sold in Pakistan is one or the other — so this is a
-- two-value choice, not a free-text millimetre box that invites typos.
--
-- Per system, because the two systems can genuinely own different printers:
-- the water supply's collector carries one on his rounds, the donations desk
-- may print on another.
INSERT INTO site_settings (key, value, description) VALUES
  ('slip_thermal_width_water', '58',
   'Thermal roll width for water supply slips: 58 or 80 (mm). Match this to the paper your Bluetooth printer actually takes.'),
  ('slip_thermal_width_donor', '58',
   'Thermal roll width for donor receipts: 58 or 80 (mm). Match this to the paper your Bluetooth printer actually takes.')
ON CONFLICT (key) DO NOTHING;

-- 2. Two descriptions that contradicted the code -------------------------
-- fetchBrandingSettings() keeps a NO_FALLBACK_KEYS set: for free-text prose,
-- a blank donor override means blank, NOT "inherit the water supply's
-- wording". That rule is deliberate and correct — the water supply's
-- "don't waste water, pay by the 7th" note has no business on a donation
-- receipt — but these two descriptions told the admin the opposite, and the
-- Settings page prints the description straight from this column.
--
-- So an admin who cleared donor_receipt_fund_note was told the water note
-- would take over; in reality donor receipts have been printing no fund note
-- at all. Both keys are empty in production right now, which is exactly the
-- state the wrong description makes look harmless.
--
-- The values are left alone on purpose: they are admin-editable, and
-- silently re-seeding prose someone may have cleared on purpose would be a
-- worse bug than the one being fixed. The Settings page now offers the
-- recommended wording as a one-click restore instead.
UPDATE site_settings
SET description = 'Printed on donor receipts under the instructions — tell the donor what to do if their own records disagree with ours. Blank means nothing prints here: donor receipts never inherit the water supply note.'
WHERE key = 'donor_receipt_fund_note';

UPDATE site_settings
SET description = 'Instructions text shown on donor receipts. Blank means nothing prints here: donor receipts never inherit the water supply instructions.'
WHERE key = 'donor_invoice_instructions';
