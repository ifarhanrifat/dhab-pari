-- Migration 368: migration 119 generalized ensure_collector_account() to
-- take a system parameter so donors_projects collectors could get their
-- own clearing account, but never actually seeded the matching
-- account_headers row (only 'water_supply'/'collector' exists, from 056)
-- — accounts.type has an FK to account_headers per system, so every
-- donors_projects collector account insert has been silently impossible
-- since 119, caught only now by actually exercising it for the first
-- time (a training-fee trainer collecting cash).

INSERT INTO account_headers (system, code, label, code_prefix, display_order, is_system) VALUES
  ('donors_projects', 'collector', 'Field Collectors', 'DP-COL', 7, true)
ON CONFLICT (system, code) DO NOTHING;
