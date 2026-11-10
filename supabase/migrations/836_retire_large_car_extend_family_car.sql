-- Migration 836: real ask, 2026-11-10 — "what is that bari car? why is
-- it there in the marketplace reference?"
--
-- 'large_car' (834) was a technical patch closing a CC-resolver gap
-- (2800cc was returning null) — not a real committee-designed tier.
-- Unlike every other car band it has no AC/Non-AC split, and it clones
-- Family Car's exact rate card, so it's just a confusing duplicate row
-- sitting in Marketplace Reference. Confirmed zero vehicles/requests
-- reference it. Cleaner fix, approved by user: retire it and open
-- Family Car (AC/Non-AC)'s upper CC bound instead, so coverage above
-- 1000cc is continuous with no orphan row.

-- Safety remap (no-op today — confirmed zero rows — same discipline as
-- every prior category retirement in this project: never delete,
-- never leave a dangling category_id).
UPDATE vehicles v SET category_id = dest.id
FROM vehicle_categories src, vehicle_categories dest
WHERE v.category_id = src.id AND src.key = 'large_car'
  AND dest.tenant_id = src.tenant_id AND dest.key = 'big_car_ac';

UPDATE vehicle_registration_requests r SET category_id = dest.id
FROM vehicle_categories src, vehicle_categories dest
WHERE r.category_id = src.id AND src.key = 'large_car'
  AND dest.tenant_id = src.tenant_id AND dest.key = 'big_car_ac';

UPDATE vehicle_categories
SET max_cc = NULL
WHERE key IN ('big_car_ac', 'big_car_non_ac') AND is_active;

UPDATE vehicle_categories
SET is_active = false
WHERE key = 'large_car';
