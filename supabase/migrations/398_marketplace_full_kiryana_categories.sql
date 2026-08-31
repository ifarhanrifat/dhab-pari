-- Migration 398: the original 10-code category list (388) was a rough
-- starting set — nowhere near what a real Pakistani general/kiryana store
-- actually stocks. Replaced with a proper 24-code list across 6
-- departments (grains & pulses, cooking oil & ghee, spices, tea/coffee,
-- confectionery, dairy & eggs, bakery, fruits & vegetables, meat/poultry,
-- cosmetics, kitchenware, baby care, toys, health/OTC medicine, electric &
-- hardware, alongside the categories already there) — the same
-- department → category → products browse structure the shop detail page
-- already groups these into, just with real depth behind it now.
-- Two old codes don't survive as-is: 'dairy' is a clean rename to
-- 'dairy_eggs'; 'grocery_pantry' was a catch-all that's now five more
-- specific codes — rather than guess which one any existing row meant,
-- those fall back to 'other' so nothing is silently miscategorized (a
-- keeper can re-file them properly from their own product list).
UPDATE shop_products SET category = 'dairy_eggs' WHERE category = 'dairy';
UPDATE shop_products SET category = 'other' WHERE category = 'grocery_pantry';

ALTER TABLE shop_products DROP CONSTRAINT IF EXISTS shop_products_category_check;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_category_check CHECK (category IN (
  -- Food & Groceries
  'grains_pulses', 'cooking_oil_ghee', 'spices_masala', 'sugar_salt', 'tea_coffee',
  'biscuits_snacks', 'confectionery', 'beverages', 'dairy_eggs', 'bakery', 'frozen',
  'fruits_vegetables', 'meat_poultry',
  -- Household & Personal Care
  'personal_care', 'cosmetics_beauty', 'household', 'kitchenware', 'cigarettes_paan', 'stationery',
  -- Baby & Kids
  'baby_care', 'toys',
  -- Health & Pharmacy
  'health_medicine',
  -- Electronics & Hardware
  'electric_hardware',
  -- Other
  'other'
));
