-- Migration 756: real ask, 2026-10-28 — "it should need to replace
-- with the cars, bikes, machinery, loading etc so when user will
-- select the cars so only all kind of cars and SUVs etc will appear
-- and not machines and loading... I just want when rider want to
-- travel then the list will have all transport and not the
-- machinery, loading." The results screen's category grid today shows
-- every active vehicle_categories row flat — passenger types (car
-- tiers, bike, rickshaw, van) mixed in with goods/equipment types
-- (tractor, loader, machinery), with no way to tell them apart. A real
-- group flag, not a frontend-hardcoded key list, so the committee can
-- correctly classify any category they add later from the admin
-- screen without a code change.
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS category_group varchar NOT NULL DEFAULT 'passenger' CHECK (category_group IN ('passenger', 'equipment'));
UPDATE vehicle_categories SET category_group = 'equipment' WHERE key IN ('tractor', 'loader', 'machinery');
