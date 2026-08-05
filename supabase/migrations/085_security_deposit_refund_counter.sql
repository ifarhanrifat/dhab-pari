-- Migration 085: security_deposit_refund (added in migration 071 for Permanent
-- Disconnection settlements) has the exact same missing-counter bug that
-- migration 037 already fixed once for security_deposit itself — never
-- caught because Permanent Disconnection hasn't been run against a real
-- refund-owed consumer yet.
INSERT INTO voucher_counters (system, voucher_type, prefix) VALUES
  ('water_supply', 'security_deposit_refund', 'WS-SDR-V'),
  ('donors_projects', 'security_deposit_refund', 'DP-SDR-V')
ON CONFLICT (system, voucher_type) DO NOTHING;
