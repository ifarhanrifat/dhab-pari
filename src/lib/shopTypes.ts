// Shop-type-aware category taxonomy, designed with input from a deeper
// Opus research pass on real Pakistani village/small-town businesses
// (not a generic retail taxonomy translated to Urdu). Replaces the single
// universal 24-category kiryana list (marketplaceCategories.ts) — that
// list is now just one entry here (`general_store`), unchanged, since a
// hotel, a butcher, and a hair salon each need their own tree, not the
// kiryana one with the labels swapped.
//
// Architecture (why it's shaped this way):
// - Every shop picks ONE `primary_type` (drives its whole category tree
//   + icon) and can optionally turn on a couple of `addon_modules` — a
//   tea stall that also sells phone load doesn't need to be re-typed as
//   a "mobile shop", it just adds the mobile_load module. This avoids
//   the rigid-type churn a real village shop would otherwise force.
// - Category slugs are STRING IDENTIFIERS, not tied to any one shop
//   type's tree. Where the same real commodity shows up in multiple
//   trees (cold drinks, cigarettes, mineral water, mobile load), the
//   SAME slug is reused rather than a new type-namespaced one — a
//   product keeps its slug even if a shop's type ever changes, and it
//   keeps cross-shop price comparison meaningful for the same item.
// - Labels are bilingual fields directly on each node (matching how
//   every other bilingual field in this app works — name/name_ur — not
//   a t()-key indirection into messages.ts; with ~250 category nodes
//   across 12 shop types, one lookup file beats scattering that many
//   keys through the translations file).
// - Exactly 2 levels deep (department → category) — a third level
//   roughly triples tap cost for a shopkeeper filing one product and
//   isn't worth it; the shopkeeper's own product name is the real
//   "third level" of specificity.
// - Only icons confirmed to exist in the installed lucide-react version
//   are used (see the icon lookup below) — a wrong name is a build
//   break, not a cosmetic miss.

export interface CategoryNode { slug: string; label: string; label_ur: string }
export interface CategoryDepartment { key: string; label: string; label_ur: string; icon: string; categories: CategoryNode[] }
export interface ShopType { slug: string; label: string; label_ur: string; icon: string }
export interface AddonModule { slug: string; label: string; label_ur: string; icon: string; categories: CategoryNode[] }

// ═══════════════════════════════════════════════════════════════════════
// Shop types — the picker shown when a shop is created/edited. 'other'
// is always last: no preset tree, the shop defines its own categories.
// ═══════════════════════════════════════════════════════════════════════
export const SHOP_TYPES: ShopType[] = [
  { slug: 'general_store', label: 'General Store', label_ur: 'کریانہ / پرچون سٹور', icon: 'Store' },
  { slug: 'hotel_dhaba', label: 'Hotel / Restaurant', label_ur: 'ہوٹل / ڈھابہ', icon: 'ChefHat' },
  { slug: 'fried_snacks', label: 'Samosa & Pakora Shop', label_ur: 'سموسہ پکوڑا شاپ', icon: 'Sandwich' },
  { slug: 'tea_stall', label: 'Tea Stall', label_ur: 'چائے کا کھوکھا', icon: 'Coffee' },
  { slug: 'bakery_tandoor', label: 'Bakery & Tandoor', label_ur: 'نانبائی / تندور', icon: 'Croissant' },
  { slug: 'meat_shop', label: 'Chicken & Meat Shop', label_ur: 'مرغی / گوشت کی دکان', icon: 'Drumstick' },
  { slug: 'dairy_shop', label: 'Dairy Shop', label_ur: 'دودھ دہی کی دکان', icon: 'Milk' },
  { slug: 'fruit_veg', label: 'Fruit & Vegetable', label_ur: 'سبزی و پھل کی دکان', icon: 'Carrot' },
  { slug: 'building_materials', label: 'Cement, Bajree & Retti', label_ur: 'سیمنٹ، بجری اور ریتی', icon: 'Package' },
  { slug: 'gas_agency', label: 'Gas Cylinder Agency', label_ur: 'گیس سلنڈر ایجنسی', icon: 'Flame' },
  { slug: 'barber', label: 'Hair Salon / Barber', label_ur: 'حجام / سیلون', icon: 'Scissors' },
  { slug: 'pharmacy', label: 'Medical Store', label_ur: 'میڈیکل سٹور', icon: 'Pill' },
  { slug: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes' },
]

// Shared slugs — the SAME real commodity across multiple trees, reused
// deliberately (see the note above) rather than re-declared per type.
const COLD_DRINKS: CategoryNode = { slug: 'beverages', label: 'Cold Drinks & Juices', label_ur: 'کولڈ ڈرنکس اور جوس' }
const MINERAL_WATER: CategoryNode = { slug: 'mineral_water', label: 'Mineral Water', label_ur: 'منرل واٹر' }
const TOBACCO_PAAN: CategoryNode = { slug: 'cigarettes_paan', label: 'Cigarettes & Paan', label_ur: 'سگریٹ اور پان' }
const LASSI: CategoryNode = { slug: 'lassi_doodh_soda', label: 'Lassi & Doodh Soda', label_ur: 'لسی اور دودھ سوڈا' }

// ═══════════════════════════════════════════════════════════════════════
// general_store — unchanged from the original 24-code list (no product
// churn on shops that already exist); slugs match shop_products.category
// exactly as before. Icons added per department.
// ═══════════════════════════════════════════════════════════════════════
const GENERAL_STORE: CategoryDepartment[] = [
  {
    key: 'food', label: 'Food & Groceries', label_ur: 'کھانے پینے کی اشیاء', icon: 'ShoppingBasket',
    categories: [
      { slug: 'grains_pulses', label: 'Atta, Rice & Pulses', label_ur: 'آٹا، چاول اور دالیں' },
      { slug: 'cooking_oil_ghee', label: 'Cooking Oil & Ghee', label_ur: 'تیل و گھی' },
      { slug: 'spices_masala', label: 'Spices & Masala', label_ur: 'مصالحہ جات' },
      { slug: 'sugar_salt', label: 'Sugar, Salt & Sweeteners', label_ur: 'چینی، نمک اور میٹھا' },
      { slug: 'tea_coffee', label: 'Tea & Coffee', label_ur: 'چائے اور کافی' },
      { slug: 'biscuits_snacks', label: 'Biscuits & Snacks', label_ur: 'بسکٹ اور اسنیکس' },
      { slug: 'confectionery', label: 'Confectionery & Sweets', label_ur: 'ٹافی، چاکلیٹ اور مٹھائیاں' },
      COLD_DRINKS,
      { slug: 'dairy_eggs', label: 'Dairy & Eggs', label_ur: 'دودھ، دہی اور انڈے' },
      { slug: 'bakery', label: 'Bakery Items', label_ur: 'بیکری کی اشیاء' },
      { slug: 'frozen', label: 'Frozen Foods', label_ur: 'فروزن اشیاء' },
      { slug: 'fruits_vegetables', label: 'Fruits & Vegetables', label_ur: 'پھل اور سبزیاں' },
      { slug: 'meat_poultry', label: 'Meat, Poultry & Fish', label_ur: 'گوشت، مرغی اور مچھلی' },
      // Split out from the original 24, matching how a real supermarket
      // (Al-Fatah/Imtiaz category structure) breaks these down further —
      // added, not replacing anything, so no existing product's category
      // ever goes stale.
      { slug: 'noodles_pasta', label: 'Noodles & Pasta', label_ur: 'نوڈلز اور پاستا' },
      { slug: 'honey_jam_spreads', label: 'Honey, Jam & Spreads', label_ur: 'شہد، جیم اور اسپریڈ' },
      { slug: 'pickles_sauces', label: 'Pickles, Ketchup & Sauces', label_ur: 'اچار، کیچپ اور ساس' },
    ],
  },
  {
    key: 'household', label: 'Household & Personal Care', label_ur: 'گھریلو اور ذاتی اشیاء', icon: 'SprayCan',
    categories: [
      { slug: 'personal_care', label: 'Personal Care', label_ur: 'ذاتی نگہداشت' },
      { slug: 'cosmetics_beauty', label: 'Cosmetics & Beauty', label_ur: 'میک اپ اور خوبصورتی' },
      { slug: 'household', label: 'Household & Cleaning', label_ur: 'گھریلو صفائی' },
      { slug: 'kitchenware', label: 'Kitchenware & Crockery', label_ur: 'برتن اور کچن کی اشیاء' },
      TOBACCO_PAAN,
      { slug: 'stationery', label: 'Stationery', label_ur: 'اسٹیشنری' },
      // Same real-supermarket-structure split as food above — Personal
      // Care and Household & Cleaning stay as their original broad
      // options (still valid, still used by existing products), these
      // are the finer picks alongside them.
      { slug: 'hair_care', label: 'Hair Care', label_ur: 'بالوں کی دیکھ بھال' },
      { slug: 'oral_care', label: 'Oral Care', label_ur: 'منہ کی دیکھ بھال' },
      { slug: 'skin_bath_care', label: 'Skin & Bath Care', label_ur: 'جلد اور نہانے کی اشیاء' },
      { slug: 'laundry_detergent', label: 'Laundry & Detergents', label_ur: 'کپڑے دھونے کا سامان' },
      { slug: 'dishwashing', label: 'Dishwashing', label_ur: 'برتن دھونے کا سامان' },
      { slug: 'air_insect_care', label: 'Air Freshener & Insect Repellent', label_ur: 'خوشبو اور کیڑے مار ادویات' },
      { slug: 'tissue_paper', label: 'Tissue & Paper Products', label_ur: 'ٹشو اور کاغذی اشیاء' },
    ],
  },
  { key: 'baby_kids', label: 'Baby & Kids', label_ur: 'بچوں کی اشیاء', icon: 'Baby', categories: [
    { slug: 'baby_care', label: 'Baby Care', label_ur: 'بچوں کی نگہداشت' },
    { slug: 'toys', label: 'Toys & Gifts', label_ur: 'کھلونے اور تحائف' },
    { slug: 'diapers_wipes', label: 'Diapers & Wipes', label_ur: 'ڈائپرز اور وائپس' },
    { slug: 'baby_food_feeding', label: 'Baby Food & Feeding', label_ur: 'بچوں کی خوراک' },
  ] },
  { key: 'health', label: 'Health & Pharmacy', label_ur: 'صحت و ادویات', icon: 'Pill', categories: [
    { slug: 'health_medicine', label: 'Health & Medicine', label_ur: 'ادویات اور صحت' },
  ] },
  { key: 'electronics', label: 'Electronics & Hardware', label_ur: 'برقی اور ہارڈویئر اشیاء', icon: 'Lightbulb', categories: [
    { slug: 'electric_hardware', label: 'Electric & Hardware', label_ur: 'برقی اور ہارڈویئر' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [
    { slug: 'other', label: 'Other', label_ur: 'دیگر' },
  ] },
]

const HOTEL_DHABA: CategoryDepartment[] = [
  { key: 'roti_naan', label: 'Roti & Naan (Tandoor)', label_ur: 'روٹی اور نان', icon: 'Wheat', categories: [
    { slug: 'tandoori_roti', label: 'Tandoori Roti', label_ur: 'تندوری روٹی' },
    { slug: 'naan_kulcha', label: 'Naan & Kulcha', label_ur: 'نان اور کلچہ' },
    { slug: 'paratha', label: 'Paratha', label_ur: 'پراٹھا' },
  ] },
  { key: 'salan', label: 'Salan (Curries)', label_ur: 'سالن', icon: 'CookingPot', categories: [
    { slug: 'chicken_salan', label: 'Chicken Salan', label_ur: 'چکن سالن' },
    { slug: 'mutton_beef_salan', label: 'Mutton / Beef Salan', label_ur: 'مٹن / بیف سالن' },
    { slug: 'daal_sabzi', label: 'Daal & Sabzi', label_ur: 'دال اور سبزی' },
    { slug: 'nihari_paye', label: 'Nihari & Paye', label_ur: 'نہاری اور پائے' },
    { slug: 'haleem', label: 'Haleem', label_ur: 'حلیم' },
  ] },
  { key: 'biryani_rice', label: 'Biryani & Rice', label_ur: 'بریانی اور چاول', icon: 'UtensilsCrossed', categories: [
    { slug: 'chicken_biryani', label: 'Chicken Biryani', label_ur: 'چکن بریانی' },
    { slug: 'mutton_biryani', label: 'Mutton / Beef Biryani', label_ur: 'مٹن / بیف بریانی' },
    { slug: 'pulao', label: 'Pulao', label_ur: 'پلاؤ' },
  ] },
  { key: 'karahi_bbq', label: 'Karahi & BBQ', label_ur: 'کڑاہی اور بار بی کیو', icon: 'Flame', categories: [
    { slug: 'chicken_karahi', label: 'Chicken Karahi', label_ur: 'چکن کڑاہی' },
    { slug: 'mutton_karahi', label: 'Mutton Karahi', label_ur: 'مٹن کڑاہی' },
    { slug: 'tikka_boti', label: 'Tikka & Boti', label_ur: 'تکہ اور بوٹی' },
    { slug: 'seekh_kabab', label: 'Seekh Kabab', label_ur: 'سیخ کباب' },
  ] },
  { key: 'nashta', label: 'Nashta (Breakfast)', label_ur: 'ناشتہ', icon: 'EggFried', categories: [
    { slug: 'halwa_puri', label: 'Halwa Puri', label_ur: 'حلوہ پوری' },
    { slug: 'anda_paratha', label: 'Anda & Paratha', label_ur: 'انڈا اور پراٹھا' },
    { slug: 'channay', label: 'Channay', label_ur: 'چنے' },
  ] },
  { key: 'fast_food', label: 'Fast Food', label_ur: 'فاسٹ فوڈ', icon: 'Sandwich', categories: [
    { slug: 'burger', label: 'Burger', label_ur: 'برگر' },
    { slug: 'shawarma_roll', label: 'Shawarma & Roll', label_ur: 'شوارما اور رول' },
    { slug: 'broast_fries', label: 'Broast & Fries', label_ur: 'بروسٹ اور فرائز' },
  ] },
  { key: 'drinks', label: 'Drinks & Chai', label_ur: 'مشروبات اور چائے', icon: 'CupSoda', categories: [
    { slug: 'chai', label: 'Chai', label_ur: 'چائے' },
    COLD_DRINKS, LASSI, MINERAL_WATER,
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const FRIED_SNACKS: CategoryDepartment[] = [
  { key: 'samosa_pakora', label: 'Samosa & Pakora', label_ur: 'سموسہ اور پکوڑا', icon: 'Triangle', categories: [
    { slug: 'aloo_samosa', label: 'Aloo Samosa', label_ur: 'آلو سموسہ' },
    { slug: 'qeema_samosa', label: 'Qeema Samosa', label_ur: 'قیمہ سموسہ' },
    { slug: 'mix_pakora', label: 'Pyaz & Mix Pakora', label_ur: 'پیاز اور مکس پکوڑا' },
  ] },
  { key: 'chaat', label: 'Chaat & Channay', label_ur: 'چاٹ اور چنے', icon: 'Soup', categories: [
    { slug: 'channa_chaat', label: 'Channa Chaat', label_ur: 'چنا چاٹ' },
    { slug: 'dahi_bhalay', label: 'Dahi Bhalay', label_ur: 'دہی بھلے' },
    { slug: 'fruit_chaat', label: 'Fruit Chaat', label_ur: 'فروٹ چاٹ' },
  ] },
  { key: 'rolls_fry', label: 'Rolls & Fry Items', label_ur: 'رولز اور فرائی اشیاء', icon: 'Sandwich', categories: [
    { slug: 'spring_roll', label: 'Spring Roll', label_ur: 'سپرنگ رول' },
    { slug: 'chicken_roll', label: 'Chicken Roll & Shawarma', label_ur: 'چکن رول اور شوارما' },
    { slug: 'fries_nuggets', label: 'Fries & Nuggets', label_ur: 'فرائز اور نگٹس' },
  ] },
  { key: 'sweets', label: 'Meethi Cheezain', label_ur: 'میٹھی چیزیں', icon: 'Donut', categories: [
    { slug: 'jalebi', label: 'Jalebi', label_ur: 'جلیبی' },
    { slug: 'gulab_jamun', label: 'Gulab Jamun', label_ur: 'گلاب جامن' },
  ] },
  { key: 'drinks', label: 'Drinks', label_ur: 'مشروبات', icon: 'CupSoda', categories: [COLD_DRINKS, LASSI, MINERAL_WATER] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const TEA_STALL: CategoryDepartment[] = [
  { key: 'chai', label: 'Chai & Hot Drinks', label_ur: 'چائے اور گرم مشروبات', icon: 'Coffee', categories: [
    { slug: 'doodh_patti', label: 'Doodh Patti', label_ur: 'دودھ پتی' },
    { slug: 'kadak_chai', label: 'Kadak Chai', label_ur: 'کڑک چائے' },
    { slug: 'qehwa', label: 'Green Tea / Qehwa', label_ur: 'قہوہ' },
  ] },
  { key: 'nashta', label: 'Nashta & Light Bites', label_ur: 'ناشتہ', icon: 'EggFried', categories: [
    { slug: 'paratha', label: 'Paratha', label_ur: 'پراٹھا' },
    { slug: 'anda_omelette', label: 'Anda & Omelette', label_ur: 'انڈا اور آملیٹ' },
    { slug: 'bun_kabab', label: 'Bun Kabab', label_ur: 'بن کباب' },
    { slug: 'toast_rusk', label: 'Toast & Rusk', label_ur: 'ٹوسٹ اور رسک' },
  ] },
  { key: 'snacks', label: 'Biscuits & Snacks', label_ur: 'بسکٹ اور اسنیکس', icon: 'Cookie', categories: [
    { slug: 'biscuits_snacks', label: 'Biscuits & Chips', label_ur: 'بسکٹ اور چپس' },
    { slug: 'toffee_candy', label: 'Toffee & Candy', label_ur: 'ٹافی اور کینڈی' },
  ] },
  { key: 'drinks', label: 'Cold Drinks', label_ur: 'کولڈ ڈرنکس', icon: 'CupSoda', categories: [COLD_DRINKS, LASSI, MINERAL_WATER] },
  { key: 'tobacco', label: 'Cigarettes & Paan', label_ur: 'سگریٹ اور پان', icon: 'Cigarette', categories: [
    TOBACCO_PAAN, { slug: 'naswar_gutka', label: 'Naswar & Gutka', label_ur: 'نسوار اور گٹکا' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const BAKERY_TANDOOR: CategoryDepartment[] = [
  { key: 'tandoor', label: 'Tandoor Roti & Naan', label_ur: 'تندوری روٹی اور نان', icon: 'Flame', categories: [
    { slug: 'tandoori_roti', label: 'Tandoori Roti', label_ur: 'تندوری روٹی' },
    { slug: 'naan_kulcha', label: 'Naan, Kulcha & Sheermal', label_ur: 'نان، کلچہ اور شیرمال' },
  ] },
  { key: 'bread_rusk', label: 'Bread & Rusk', label_ur: 'بریڈ اور رسک', icon: 'Croissant', categories: [
    { slug: 'bread', label: 'Bread', label_ur: 'بریڈ' },
    { slug: 'cake_rusk', label: 'Cake Rusk', label_ur: 'کیک رسک' },
    { slug: 'bun_toast', label: 'Bun & Toast', label_ur: 'بن اور ٹوسٹ' },
  ] },
  { key: 'cakes', label: 'Cakes & Pastry', label_ur: 'کیک اور پیسٹری', icon: 'CakeSlice', categories: [
    { slug: 'birthday_cakes', label: 'Birthday / Custom Cakes', label_ur: 'برتھ ڈے / کسٹم کیک' },
    { slug: 'pastry_cupcake', label: 'Pastry & Cupcake', label_ur: 'پیسٹری اور کپ کیک' },
  ] },
  { key: 'biscuits', label: 'Biscuits & Cookies', label_ur: 'بسکٹ اور کوکیز', icon: 'Cookie', categories: [
    { slug: 'bakery_biscuits', label: 'Bakery Biscuits (loose)', label_ur: 'بیکری بسکٹ' },
    { slug: 'nan_khatai', label: 'Nan Khatai', label_ur: 'نان خطائی' },
  ] },
  { key: 'savoury', label: 'Savoury Bakery', label_ur: 'نمکین بیکری اشیاء', icon: 'Sandwich', categories: [
    { slug: 'patties_puff', label: 'Patties & Puff', label_ur: 'پیٹیز اور پف' },
    { slug: 'sandwich', label: 'Sandwich', label_ur: 'سینڈوچ' },
  ] },
  { key: 'drinks_dairy', label: 'Drinks & Dairy', label_ur: 'مشروبات اور ڈیری', icon: 'CupSoda', categories: [COLD_DRINKS, MINERAL_WATER, { slug: 'dairy_eggs', label: 'Milk & Yogurt', label_ur: 'دودھ اور دہی' }] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const MEAT_SHOP: CategoryDepartment[] = [
  { key: 'chicken', label: 'Chicken (Murghi)', label_ur: 'مرغی', icon: 'Drumstick', categories: [
    { slug: 'whole_chicken', label: 'Whole Chicken', label_ur: 'ثابت مرغی' },
    { slug: 'chicken_pieces', label: 'Chicken Pieces', label_ur: 'مرغی کے ٹکڑے' },
    { slug: 'chicken_boneless', label: 'Boneless & Fillet', label_ur: 'بون لیس اور فلیٹ' },
    { slug: 'chicken_qeema', label: 'Chicken Qeema', label_ur: 'چکن قیمہ' },
  ] },
  { key: 'mutton', label: 'Mutton (Bakra)', label_ur: 'بکرے کا گوشت', icon: 'Beef', categories: [
    { slug: 'mutton_mixed', label: 'Mutton (mixed)', label_ur: 'مکس گوشت' },
    { slug: 'mutton_boti', label: 'Boti (boneless)', label_ur: 'بوٹی' },
    { slug: 'mutton_qeema', label: 'Mutton Qeema', label_ur: 'مٹن قیمہ' },
    { slug: 'mutton_chops', label: 'Chops & Raan', label_ur: 'چاپ اور ران' },
  ] },
  { key: 'beef', label: 'Beef (Gaye ka Gosht)', label_ur: 'گائے کا گوشت', icon: 'Ham', categories: [
    { slug: 'beef_mixed', label: 'Beef (mixed)', label_ur: 'مکس بیف' },
    { slug: 'beef_boneless', label: 'Undercut & Boneless', label_ur: 'انڈر کٹ اور بون لیس' },
    { slug: 'beef_qeema', label: 'Beef Qeema', label_ur: 'بیف قیمہ' },
  ] },
  { key: 'offal', label: 'Siri, Paye & Offal', label_ur: 'سری پائے', icon: 'Bone', categories: [
    { slug: 'siri_paye', label: 'Siri & Paye', label_ur: 'سری اور پائے' },
    { slug: 'kaleji_gurda', label: 'Kaleji, Gurda & Dil', label_ur: 'کلیجی، گردہ اور دل' },
  ] },
  { key: 'fish', label: 'Fish (Machhli)', label_ur: 'مچھلی', icon: 'Fish', categories: [
    { slug: 'fresh_fish', label: 'Fresh Fish', label_ur: 'تازہ مچھلی' },
    { slug: 'fried_fish', label: 'Fried Fish (ready)', label_ur: 'تلی ہوئی مچھلی' },
  ] },
  { key: 'eggs_frozen', label: 'Eggs & Frozen', label_ur: 'انڈے اور فروزن', icon: 'Egg', categories: [
    { slug: 'eggs', label: 'Eggs', label_ur: 'انڈے' },
    { slug: 'frozen_chicken', label: 'Frozen Items & Nuggets', label_ur: 'فروزن اور نگٹس' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const DAIRY_SHOP: CategoryDepartment[] = [
  { key: 'milk', label: 'Doodh (Milk)', label_ur: 'دودھ', icon: 'Milk', categories: [
    { slug: 'desi_doodh', label: 'Desi / Bhains ka Doodh', label_ur: 'دیسی / بھینس کا دودھ' },
    { slug: 'packet_milk', label: 'Packet Milk', label_ur: 'پیکٹ دودھ' },
  ] },
  { key: 'dahi_lassi', label: 'Dahi & Lassi', label_ur: 'دہی اور لسی', icon: 'GlassWater', categories: [
    { slug: 'dahi', label: 'Dahi', label_ur: 'دہی' },
    LASSI,
  ] },
  { key: 'makhan_ghee', label: 'Makhan, Ghee & Khoya', label_ur: 'مکھن، گھی اور کھویا', icon: 'Package', categories: [
    { slug: 'desi_ghee', label: 'Desi Ghee', label_ur: 'دیسی گھی' },
    { slug: 'makhan', label: 'Makhan (Butter)', label_ur: 'مکھن' },
    { slug: 'khoya_paneer', label: 'Khoya & Paneer', label_ur: 'کھویا اور پنیر' },
  ] },
  { key: 'sweet_dairy', label: 'Mithai & Sweet Dairy', label_ur: 'مٹھائی اور میٹھی اشیاء', icon: 'Donut', categories: [
    { slug: 'kheer_firni', label: 'Kheer & Firni', label_ur: 'کھیر اور فرنی' },
    { slug: 'barfi', label: 'Barfi', label_ur: 'برفی' },
  ] },
  { key: 'eggs', label: 'Eggs & Extras', label_ur: 'انڈے اور دیگر', icon: 'Egg', categories: [
    { slug: 'eggs', label: 'Eggs', label_ur: 'انڈے' }, COLD_DRINKS, MINERAL_WATER,
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const FRUIT_VEG: CategoryDepartment[] = [
  { key: 'everyday_veg', label: 'Rozana Sabzi', label_ur: 'روزانہ کی سبزیاں', icon: 'Carrot', categories: [
    { slug: 'aloo_pyaz_tamatar', label: 'Aloo, Pyaz & Tamatar', label_ur: 'آلو، پیاز اور ٹماٹر' },
    { slug: 'adrak_lehsan_mirch', label: 'Adrak, Lehsan & Hari Mirch', label_ur: 'ادرک، لہسن اور ہری مرچ' },
  ] },
  { key: 'seasonal_veg', label: 'Mausami Sabzi', label_ur: 'موسمی سبزیاں', icon: 'Sprout', categories: [
    { slug: 'bhindi_tori_karela', label: 'Bhindi, Tori & Karela', label_ur: 'بھنڈی، توری اور کریلا' },
    { slug: 'palak_saag', label: 'Palak & Saag', label_ur: 'پالک اور ساگ' },
    { slug: 'gobi_shimla', label: 'Gobi & Shimla Mirch', label_ur: 'گوبھی اور شملہ مرچ' },
  ] },
  { key: 'salad_herbs', label: 'Salad & Herbs', label_ur: 'سلاد اور جڑی بوٹیاں', icon: 'Salad', categories: [
    { slug: 'kheera_salad', label: 'Kheera & Salad Patta', label_ur: 'کھیرا اور سلاد پتہ' },
    { slug: 'podina_dhaniya', label: 'Podina & Dhaniya', label_ur: 'پودینہ اور دھنیا' },
  ] },
  { key: 'seasonal_fruit', label: 'Mausami Phal', label_ur: 'موسمی پھل', icon: 'Apple', categories: [
    { slug: 'aam_kinnow', label: 'Aam, Kinnow & Malta', label_ur: 'آم، کنو اور مالٹا' },
    { slug: 'tarbooz_kharbooza', label: 'Tarbooz & Kharbooza', label_ur: 'تربوز اور خربوزہ' },
  ] },
  { key: 'everyday_fruit', label: 'Rozana Phal', label_ur: 'روزانہ کے پھل', icon: 'Banana', categories: [
    { slug: 'kela_seb', label: 'Kela & Seb', label_ur: 'کیلا اور سیب' },
    { slug: 'anaar', label: 'Anaar', label_ur: 'انار' },
  ] },
  { key: 'dry_fruit', label: 'Dry Fruit', label_ur: 'خشک میوہ جات', icon: 'Nut', categories: [
    { slug: 'khajoor', label: 'Khajoor (Dates)', label_ur: 'کھجور' },
    { slug: 'badam_akhrot', label: 'Badam, Akhrot & Kaju', label_ur: 'بادام، اخروٹ اور کاجو' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const BUILDING_MATERIALS: CategoryDepartment[] = [
  { key: 'cement', label: 'Cement & Concrete', label_ur: 'سیمنٹ', icon: 'Package', categories: [
    { slug: 'cement_bag', label: 'Cement (per bag)', label_ur: 'سیمنٹ (فی بیگ)' },
    { slug: 'white_cement', label: 'White Cement & Bond', label_ur: 'سفید سیمنٹ اور بانڈ' },
  ] },
  { key: 'sand_gravel', label: 'Retti, Bajree & Crush', label_ur: 'ریتی، بجری اور کرش', icon: 'Mountain', categories: [
    { slug: 'retti', label: 'Retti (Sand)', label_ur: 'ریتی' },
    { slug: 'bajree', label: 'Bajree (Gravel)', label_ur: 'بجری' },
    { slug: 'crush_stone', label: 'Crush (Stone)', label_ur: 'کرش' },
  ] },
  { key: 'bricks', label: 'Bricks & Blocks', label_ur: 'اینٹیں اور بلاکس', icon: 'BrickWall', categories: [
    { slug: 'awwal_brick', label: 'Awwal (1st Class) Brick', label_ur: 'اول اینٹ' },
    { slug: 'concrete_blocks', label: 'Concrete Blocks', label_ur: 'کنکریٹ بلاکس' },
  ] },
  { key: 'steel', label: 'Sariya & Steel', label_ur: 'سریا اور سٹیل', icon: 'Package', categories: [
    { slug: 'sariya', label: 'Sariya (Rebar)', label_ur: 'سریا' },
    { slug: 'steel_angle', label: 'Steel Girder & Angle', label_ur: 'سٹیل گرڈر اور اینگل' },
  ] },
  { key: 'tiles', label: 'Tiles & Sanitary', label_ur: 'ٹائلز اور سینیٹری', icon: 'LayoutGrid', categories: [
    { slug: 'floor_tiles', label: 'Floor & Wall Tiles', label_ur: 'فرش اور دیوار کی ٹائلیں' },
    { slug: 'pipe_fittings', label: 'PVC Pipe & Fittings', label_ur: 'پی وی سی پائپ' },
    { slug: 'sanitary_set', label: 'Commode, Basin & Taps', label_ur: 'کموڈ، باتھ سیٹ اور نلکے' },
  ] },
  { key: 'tools', label: 'Tools & Site Items', label_ur: 'اوزار اور سائٹ کا سامان', icon: 'Hammer', categories: [
    { slug: 'hand_tools', label: 'Trowel, Sooya & Level', label_ur: 'کرنی، سویا اور لیول' },
    { slug: 'wheelbarrow', label: 'Wheelbarrow & Tasla', label_ur: 'ٹھیلا اور تسلہ' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const GAS_AGENCY: CategoryDepartment[] = [
  { key: 'refill', label: 'Cylinder Refill', label_ur: 'سلنڈر ری فل', icon: 'Flame', categories: [
    { slug: 'domestic_refill', label: 'Domestic Refill (11.8/15kg)', label_ur: 'گھریلو ری فل' },
    { slug: 'small_refill', label: 'Small Cylinder Refill', label_ur: 'چھوٹا سلنڈر ری فل' },
    { slug: 'commercial_refill', label: 'Commercial Refill', label_ur: 'کمرشل ری فل' },
  ] },
  { key: 'new_cylinders', label: 'New Cylinders', label_ur: 'نئے سلنڈر', icon: 'Package', categories: [
    { slug: 'domestic_cylinder', label: 'Domestic Cylinder', label_ur: 'گھریلو سلنڈر' },
    { slug: 'portable_cylinder', label: 'Small / Portable Cylinder', label_ur: 'چھوٹا سلنڈر' },
  ] },
  { key: 'fittings', label: 'Regulators & Fittings', label_ur: 'ریگولیٹر اور فٹنگز', icon: 'Gauge', categories: [
    { slug: 'regulator', label: 'Regulator', label_ur: 'ریگولیٹر' },
    { slug: 'gas_pipe', label: 'Gas Pipe & Clamps', label_ur: 'گیس پائپ اور کلیمپ' },
  ] },
  { key: 'appliances', label: 'Stoves & Appliances', label_ur: 'چولہے اور آلات', icon: 'CookingPot', categories: [
    { slug: 'gas_chulha', label: 'Gas Chulha (Stove)', label_ur: 'گیس چولہا' },
    { slug: 'gas_heater', label: 'Gas Heater', label_ur: 'گیس ہیٹر' },
  ] },
  { key: 'services', label: 'Services & Delivery', label_ur: 'خدمات اور ڈیلیوری', icon: 'Truck', categories: [
    { slug: 'home_delivery', label: 'Home Delivery', label_ur: 'گھر ڈیلیوری' },
    { slug: 'leak_testing', label: 'Leak Testing & Repair', label_ur: 'لیک چیک اور مرمت' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const BARBER: CategoryDepartment[] = [
  { key: 'haircut', label: 'Haircut', label_ur: 'بال کٹنگ', icon: 'Scissors', categories: [
    { slug: 'simple_cut', label: 'Simple Cut', label_ur: 'سادہ کٹ' },
    { slug: 'style_cut', label: 'Style / Fashion Cut', label_ur: 'اسٹائل کٹ' },
    { slug: 'kids_cut', label: "Kids' Cut", label_ur: 'بچوں کی کٹنگ' },
  ] },
  { key: 'shave_beard', label: 'Shave & Beard', label_ur: 'شیو اور داڑھی', icon: 'UserRound', categories: [
    { slug: 'clean_shave', label: 'Clean Shave', label_ur: 'کلین شیو' },
    { slug: 'beard_trim', label: 'Beard Trim & Setting', label_ur: 'داڑھی ٹرم اور سیٹنگ' },
  ] },
  { key: 'wash_massage', label: 'Hair Wash & Massage', label_ur: 'ہیئر واش اور مساج', icon: 'Droplets', categories: [
    { slug: 'head_wash', label: 'Head Wash', label_ur: 'ہیڈ واش' },
    { slug: 'champi', label: 'Champi (Oil Massage)', label_ur: 'چمپی' },
  ] },
  { key: 'treatments', label: 'Colour & Treatments', label_ur: 'کلر اور علاج', icon: 'Sparkles', categories: [
    { slug: 'hair_colour', label: 'Hair Colour', label_ur: 'ہیئر کلر' },
    { slug: 'hair_straightening', label: 'Hair Straightening', label_ur: 'ہیئر اسٹریٹننگ' },
  ] },
  { key: 'grooming', label: 'Face & Grooming', label_ur: 'چہرہ اور گرومنگ', icon: 'Sparkle', categories: [
    { slug: 'facial', label: 'Facial', label_ur: 'فیشل' },
    { slug: 'bleach_cleanup', label: 'Bleach & Clean-up', label_ur: 'بلیچ اور کلین اپ' },
  ] },
  { key: 'products', label: 'Products for Sale', label_ur: 'فروخت کے لیے مصنوعات', icon: 'ShoppingBag', categories: [
    { slug: 'hair_oil_gel', label: 'Hair Oil & Gel', label_ur: 'ہیئر آئل اور جیل' },
    { slug: 'razor_blades', label: 'Razor & Blades', label_ur: 'ریزر اور بلیڈ' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

const PHARMACY: CategoryDepartment[] = [
  { key: 'otc', label: 'Common Medicines (OTC)', label_ur: 'عام ادویات', icon: 'Pill', categories: [
    { slug: 'bukhar_dard', label: 'Bukhar & Dard (Painkillers)', label_ur: 'بخار اور درد کی دوائیں' },
    { slug: 'khansi_zukam', label: 'Khansi & Zukam', label_ur: 'کھانسی اور زکام' },
    { slug: 'digestive', label: 'Pait / Digestive', label_ur: 'معدے کی دوائیں' },
  ] },
  { key: 'injections', label: 'Injections & Drips', label_ur: 'انجیکشن اور ڈرپ', icon: 'Syringe', categories: [
    { slug: 'injections', label: 'Injections', label_ur: 'انجیکشن' },
    { slug: 'drip_sets', label: 'Drip / IV Sets', label_ur: 'ڈرپ سیٹ' },
  ] },
  { key: 'baby_medicine', label: 'Syrups & Baby Medicine', label_ur: 'شربت اور بچوں کی دوائیں', icon: 'Baby', categories: [
    { slug: 'baby_syrups', label: 'Baby Syrups & Drops', label_ur: 'بچوں کے شربت اور ڈراپس' },
    { slug: 'ors', label: 'ORS / Peditral', label_ur: 'او آر ایس' },
  ] },
  { key: 'first_aid', label: 'First Aid & Dressing', label_ur: 'فرسٹ ایڈ اور ڈریسنگ', icon: 'Bandage', categories: [
    { slug: 'bandage_gauze', label: 'Bandage & Gauze', label_ur: 'پٹی اور گاز' },
    { slug: 'antiseptic', label: 'Pyodine & Antiseptic', label_ur: 'اینٹی سیپٹک' },
  ] },
  { key: 'devices', label: 'Devices & Testing', label_ur: 'آلات اور ٹیسٹنگ', icon: 'Stethoscope', categories: [
    { slug: 'bp_apparatus', label: 'BP Apparatus', label_ur: 'بی پی آلہ' },
    { slug: 'sugar_test', label: 'Sugar Test & Strips', label_ur: 'شوگر ٹیسٹ' },
    { slug: 'thermometer', label: 'Thermometer', label_ur: 'تھرمامیٹر' },
  ] },
  { key: 'personal', label: 'Personal & Surgical', label_ur: 'ذاتی اور سرجیکل', icon: 'BriefcaseMedical', categories: [
    { slug: 'sanitary_pads', label: 'Sanitary Pads', label_ur: 'سینیٹری پیڈز' },
    { slug: 'masks_gloves', label: 'Masks, Gloves & Sanitizer', label_ur: 'ماسک اور سینیٹائزر' },
  ] },
  { key: 'other', label: 'Other', label_ur: 'دیگر', icon: 'Boxes', categories: [{ slug: 'other', label: 'Other', label_ur: 'دیگر' }] },
]

// ═══════════════════════════════════════════════════════════════════════
// Add-on modules — small, purely-additive trees a shop can turn on
// without changing its primary type (a tea stall that also does mobile
// load shouldn't have to become a "mobile shop").
// ═══════════════════════════════════════════════════════════════════════
export const ADDON_MODULES: AddonModule[] = [
  {
    slug: 'mobile_load', label: 'Mobile Load & Easypaisa', label_ur: 'موبائل لوڈ اور ایزی پیسہ', icon: 'Smartphone',
    categories: [
      { slug: 'easyload', label: 'Easyload & Balance', label_ur: 'ایزی لوڈ' },
      { slug: 'easypaisa_jazzcash', label: 'Easypaisa / JazzCash', label_ur: 'ایزی پیسہ / جاز کیش' },
      { slug: 'scratch_cards', label: 'SIM & Scratch Cards', label_ur: 'سم اور اسکریچ کارڈ' },
    ],
  },
  {
    slug: 'photostat', label: 'Photostat & Printing', label_ur: 'فوٹو اسٹیٹ اور پرنٹنگ', icon: 'Printer',
    categories: [
      { slug: 'photocopy', label: 'Photocopy & Printing', label_ur: 'فوٹو کاپی اور پرنٹنگ' },
      { slug: 'lamination_binding', label: 'Lamination & Binding', label_ur: 'لیمینیشن اور بائنڈنگ' },
      { slug: 'online_forms', label: 'Online Form Filling', label_ur: 'آن لائن فارم' },
    ],
  },
  {
    slug: 'tobacco_paan', label: 'Cigarettes & Paan', label_ur: 'سگریٹ اور پان', icon: 'Cigarette',
    categories: [TOBACCO_PAAN, { slug: 'naswar_gutka', label: 'Naswar & Gutka', label_ur: 'نسوار اور گٹکا' }],
  },
  {
    slug: 'cold_drinks_freezer', label: 'Cold Drinks Fridge', label_ur: 'کولڈ ڈرنکس فریج', icon: 'Refrigerator',
    categories: [COLD_DRINKS, MINERAL_WATER, { slug: 'ice_cream', label: 'Ice Cream', label_ur: 'آئس کریم' }],
  },
]

// slug -> tree
export const SHOP_TYPE_TREES: Record<string, CategoryDepartment[]> = {
  general_store: GENERAL_STORE,
  hotel_dhaba: HOTEL_DHABA,
  fried_snacks: FRIED_SNACKS,
  tea_stall: TEA_STALL,
  bakery_tandoor: BAKERY_TANDOOR,
  meat_shop: MEAT_SHOP,
  dairy_shop: DAIRY_SHOP,
  fruit_veg: FRUIT_VEG,
  building_materials: BUILDING_MATERIALS,
  gas_agency: GAS_AGENCY,
  barber: BARBER,
  pharmacy: PHARMACY,
  // 'other' has no preset tree — shop-level custom categories only (not built in this pass).
}

// The department/category tree for a shop, with a safe fallback so an
// unrecognised or unset primary_type never leaves the UI with nothing to
// show — falls back to the general store tree, the closest thing to a
// sane default for any small shop.
export function getShopTypeTree(primaryType: string | null | undefined): CategoryDepartment[] {
  return SHOP_TYPE_TREES[primaryType ?? ''] ?? GENERAL_STORE
}

// Combines a shop's primary tree with whichever add-on modules it has
// turned on, each add-on appended as its own department.
export function getFullShopTree(primaryType: string | null | undefined, addonModules: string[] | null | undefined): CategoryDepartment[] {
  const base = getShopTypeTree(primaryType)
  const addons = (addonModules ?? [])
    .map((slug) => ADDON_MODULES.find((m) => m.slug === slug))
    .filter((m): m is AddonModule => !!m)
    .map((m) => ({ key: `addon_${m.slug}`, label: m.label, label_ur: m.label_ur, icon: m.icon, categories: m.categories }))
  return [...base, ...addons]
}

export function getShopTypeCategorySlugs(primaryType: string | null | undefined, addonModules?: string[] | null): string[] {
  return getFullShopTree(primaryType, addonModules).flatMap((d) => d.categories.map((c) => c.slug))
}

// Every category slug across every tree + every add-on — used to build
// the DB CHECK constraint so it accepts a valid slug regardless of which
// shop it's filed under (no FK, no per-shop-type DB enforcement — a
// slug outliving a shop's type change, per the design note above, means
// the constraint can't be scoped tighter than "is this slug real
// anywhere", with app-level logic keeping the picker itself scoped to
// the shop's own tree).
export function getAllCategorySlugs(): string[] {
  const fromTrees = Object.values(SHOP_TYPE_TREES).flatMap((depts) => depts.flatMap((d) => d.categories.map((c) => c.slug)))
  const fromAddons = ADDON_MODULES.flatMap((m) => m.categories.map((c) => c.slug))
  return Array.from(new Set([...fromTrees, ...fromAddons]))
}

// A product's category slug can outlive its shop's own type/add-ons
// (see the design note above) — so label lookup searches every tree, not
// just the shop's current one, and falls back to the slug itself if
// somehow not found anywhere (never renders blank).
export function getCategoryLabel(slug: string | null | undefined, isUrdu: boolean): string {
  if (!slug) return ''
  for (const depts of Object.values(SHOP_TYPE_TREES)) {
    for (const d of depts) {
      const found = d.categories.find((c) => c.slug === slug)
      if (found) return isUrdu ? found.label_ur : found.label
    }
  }
  for (const m of ADDON_MODULES) {
    const found = m.categories.find((c) => c.slug === slug)
    if (found) return isUrdu ? found.label_ur : found.label
  }
  return slug
}
