-- Migration 444: two small, additive fields from the "Village Portal
-- Marketplace" Shop Portal v3/v3.2 handoff (2026-09-05) — a per-line unit
-- for loose/non-branded goods (کلو/پاؤ/لیٹر/... instead of always
-- reading as a bare piece count) and a quick-food flag for the buyer
-- front's فوری کھانے rail. Both are plain columns on the existing
-- shop_products row, not a parallel LooseGood/Listing model — this app's
-- shop_products already unifies branded and non-branded items via a
-- nullable `company` (see ShopCatalogSection's own commit path), and
-- splitting loose goods into a second table would fork that in two for
-- no real gain.
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS unit varchar NOT NULL DEFAULT 'عدد';
ALTER TABLE shop_products DROP CONSTRAINT IF EXISTS shop_products_unit_check;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_unit_check CHECK (unit IN (
  'عدد', 'کلو', 'پاؤ', 'آدھا کلو', 'گرام', 'لیٹر', 'ملی لیٹر', 'درجن', 'پیکٹ', 'تھیلا', 'بوتل', 'بنڈل', 'میٹر'
));

ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS is_quick_food boolean NOT NULL DEFAULT false;
