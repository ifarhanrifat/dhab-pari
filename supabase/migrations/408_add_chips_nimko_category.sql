-- Migration 408: add 'chips_nimko' as its own general_store category,
-- split out of biscuits_snacks — Lay's/Kurkure/Kolson Slanty and loose
-- local nimko are a distinct shelf from actual biscuits in a real
-- Pakistani kiryana store. Purely additive, same pattern as 407.
ALTER TABLE shop_products DROP CONSTRAINT IF EXISTS shop_products_category_check;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_category_check CHECK (category IN (
  'grains_pulses','cooking_oil_ghee','spices_masala','sugar_salt','tea_coffee','biscuits_snacks','confectionery',
  'beverages','dairy_eggs','bakery','frozen','fruits_vegetables','meat_poultry','noodles_pasta','honey_jam_spreads',
  'pickles_sauces','personal_care','cosmetics_beauty','household','kitchenware','cigarettes_paan','stationery',
  'hair_care','oral_care','skin_bath_care','laundry_detergent','dishwashing','air_insect_care','tissue_paper',
  'baby_care','toys','diapers_wipes','baby_food_feeding','health_medicine','electric_hardware','other',
  'tandoori_roti','naan_kulcha','paratha','chicken_salan','mutton_beef_salan','daal_sabzi','nihari_paye','haleem',
  'chicken_biryani','mutton_biryani','pulao','chicken_karahi','mutton_karahi','tikka_boti','seekh_kabab',
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
  'online_forms','ice_cream','chips_nimko'
));
