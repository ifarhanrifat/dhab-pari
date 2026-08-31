-- Migration 404: shop TYPE, not just product category. A general store,
-- a hotel, a butcher, and a hair salon each need their own category tree
-- (src/lib/shopTypes.ts) — forcing every shop through one universal
-- kiryana list was wrong for anything that isn't a kiryana. Existing
-- shops default to 'general_store', whose tree is the unchanged original
-- 24-code list — zero product churn on anything already listed.
--
-- addon_modules is a small, purely-additive escape valve (mobile load,
-- photostat, tobacco/paan, cold-drinks fridge) so a shop that sells a
-- FEW things outside its main type doesn't need a full type change — a
-- tea stall that also does Easyload just turns on the mobile_load
-- module, it doesn't become a "mobile shop".
ALTER TABLE shops ADD COLUMN IF NOT EXISTS primary_type varchar NOT NULL DEFAULT 'general_store' CHECK (primary_type IN (
  'general_store', 'hotel_dhaba', 'fried_snacks', 'tea_stall', 'bakery_tandoor', 'meat_shop',
  'dairy_shop', 'fruit_veg', 'building_materials', 'gas_agency', 'barber', 'pharmacy', 'other'
));
ALTER TABLE shops ADD COLUMN IF NOT EXISTS addon_modules text[] NOT NULL DEFAULT '{}';

-- shop_products.category's CHECK constraint widens to the full slug set
-- across every shop type + every add-on module (173 slugs — generated
-- from src/lib/shopTypes.ts's getAllCategorySlugs(), not hand-typed).
-- No FK, no per-shop-type DB enforcement: a slug can outlive a shop's
-- type change (see shopTypes.ts's design note) — the picker itself stays
-- scoped to the shop's own tree at the app level.
ALTER TABLE shop_products DROP CONSTRAINT IF EXISTS shop_products_category_check;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_category_check CHECK (category IN (
  'grains_pulses','cooking_oil_ghee','spices_masala','sugar_salt','tea_coffee','biscuits_snacks','confectionery',
  'beverages','dairy_eggs','bakery','frozen','fruits_vegetables','meat_poultry','personal_care','cosmetics_beauty',
  'household','kitchenware','cigarettes_paan','stationery','baby_care','toys','health_medicine','electric_hardware',
  'other','tandoori_roti','naan_kulcha','paratha','chicken_salan','mutton_beef_salan','daal_sabzi','nihari_paye',
  'haleem','chicken_biryani','mutton_biryani','pulao','chicken_karahi','mutton_karahi','tikka_boti','seekh_kabab',
  'halwa_puri','anda_paratha','channay','burger','shawarma_roll','broast_fries','chai','lassi_doodh_soda',
  'mineral_water','aloo_samosa','qeema_samosa','mix_pakora','channa_chaat','dahi_bhalay','fruit_chaat','spring_roll',
  'chicken_roll','fries_nuggets','jalebi','gulab_jamun','doodh_patti','kadak_chai','qehwa','anda_omelette',
  'bun_kabab','toast_rusk','toffee_candy','naswar_gutka','bread','cake_rusk','bun_toast','birthday_cakes',
  'pastry_cupcake','bakery_biscuits','nan_khatai','patties_puff','sandwich','whole_chicken','chicken_pieces',
  'chicken_boneless','chicken_qeema','mutton_mixed','mutton_boti','mutton_qeema','mutton_chops','beef_mixed',
  'beef_boneless','beef_qeema','siri_paye','kaleji_gurda','fresh_fish','fried_fish','eggs','frozen_chicken',
  'desi_doodh','packet_milk','dahi','desi_ghee','makhan','khoya_paneer','kheer_firni','barfi','aloo_pyaz_tamatar',
  'adrak_lehsan_mirch','bhindi_tori_karela','palak_saag','gobi_shimla','kheera_salad','podina_dhaniya','aam_kinnow',
  'tarbooz_kharbooza','kela_seb','anaar','khajoor','badam_akhrot','cement_bag','white_cement','retti','bajree',
  'crush_stone','awwal_brick','concrete_blocks','sariya','steel_angle','floor_tiles','pipe_fittings','sanitary_set',
  'hand_tools','wheelbarrow','domestic_refill','small_refill','commercial_refill','domestic_cylinder',
  'portable_cylinder','regulator','gas_pipe','gas_chulha','gas_heater','home_delivery','leak_testing','simple_cut',
  'style_cut','kids_cut','clean_shave','beard_trim','head_wash','champi','hair_colour','hair_straightening',
  'facial','bleach_cleanup','hair_oil_gel','razor_blades','bukhar_dard','khansi_zukam','digestive','injections',
  'drip_sets','baby_syrups','ors','bandage_gauze','antiseptic','bp_apparatus','sugar_test','thermometer',
  'sanitary_pads','masks_gloves','easyload','easypaisa_jazzcash','scratch_cards','photocopy','lamination_binding',
  'online_forms','ice_cream'
));
