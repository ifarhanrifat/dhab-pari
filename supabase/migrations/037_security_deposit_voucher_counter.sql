-- Migration 037: Register a voucher_counters row for the 'security_deposit' voucher
-- type added in migration 036 — next_voucher_no() raises "No voucher counter for
-- .../..." for any type without one, which blocked every security-deposit voucher
-- insert from the redesigned Generate Bill form (caught via live testing).

INSERT INTO voucher_counters (system, voucher_type, prefix) VALUES
  ('water_supply', 'security_deposit', 'WS-DEP-SEC'),
  ('donors_projects', 'security_deposit', 'DP-DEP-SEC')
ON CONFLICT (system, voucher_type) DO NOTHING;
