-- Migration 084: migration 083 added 'advance' and 'advance_settlement' as
-- valid voucher_type values but never seeded their voucher_counters rows —
-- next_voucher_no() raises "No voucher counter for system/type" when no
-- matching row exists, which is exactly what happened recording the first
-- advance payment.
INSERT INTO voucher_counters (system, voucher_type, prefix) VALUES
  ('water_supply', 'advance', 'WS-ADV-V'),
  ('water_supply', 'advance_settlement', 'WS-ADVS-V'),
  ('donors_projects', 'advance', 'DP-ADV-V'),
  ('donors_projects', 'advance_settlement', 'DP-ADVS-V')
ON CONFLICT (system, voucher_type) DO NOTHING;
