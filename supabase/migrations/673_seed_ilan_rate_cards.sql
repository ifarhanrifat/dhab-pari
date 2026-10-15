-- Migration 673: starter rate cards so the ilan system has something to
-- quote against from day one. Platform admins can add new versions
-- later (old one just needs is_active set to false) -- this migration
-- only runs once, guarded by a check for any existing row per placement.
INSERT INTO ilan_rate_cards (placement, price_per_village_per_day_pkr, min_hours, max_days)
SELECT 'ticker', 200, 3, 30
WHERE NOT EXISTS (SELECT 1 FROM ilan_rate_cards WHERE placement = 'ticker');

INSERT INTO ilan_rate_cards (placement, price_per_village_per_day_pkr, min_hours, max_days)
SELECT 'banner', 500, 6, 30
WHERE NOT EXISTS (SELECT 1 FROM ilan_rate_cards WHERE placement = 'banner');
