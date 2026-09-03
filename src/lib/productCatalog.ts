// A "pick from a real brand's product line" quick-add catalog for shop
// keepers — the third way to add a product, alongside typing one in by
// hand and the AI camera scan. Tap a brand, tap the item/flavor/size,
// and the Add Product form opens pre-filled with name/company/flavor/
// category (and a selling-price suggestion where one is actually
// sourced — see `price` below); the keeper still confirms/adjusts the
// price and sets stock, and can still attach their own photo the normal
// way (ImageUpload, same control a manually-typed product uses).
//
// Sourced from each brand's own product pages (mayfairfood.com/pk,
// candyland.com.pk, ismailindustries.com.pk, sufioilandghee.com,
// rosepetal.com.pk) plus real Pakistani grocery-retailer listings
// (naheed.pk, pakistandeals.pk, alfatah.pk) for pack sizes, category
// structure, and the handful of `price` values below — checked live,
// not invented. Al-Fatah's own live category taxonomy (alfatah.pk) is
// also what the 12 finer categories in shopTypes.ts's general_store
// tree (hair_care/oral_care/skin_bath_care/laundry_detergent/
// dishwashing/tissue_paper/diapers_wipes/etc — migration 407) are
// modelled on, since that's how an actual Pakistani supermarket
// organizes these same items. Three honest limits, on purpose:
// - A `price` is only ever set where an actual retail listing was
//   checked tonight; everything else is left unset (the form starts at
//   0, same as a manually-typed product) rather than guess a number for
//   a real financial system. Every price shown is a starting suggestion
//   only — the keeper's own cost/selling price always wins. Most
//   Pakistani grocery-retail sites render prices client-side in a way
//   this app's fetch tool can't read (naheed.pk, Carrefour, foodpanda
//   all confirmed unreadable this way) — that's the ceiling on how many
//   of these could realistically be verified tonight, not a shortcut.
// - This is a strong starting set of the major, real, genuinely
//   well-known brands a Pakistani general/kiryana store actually stocks
//   — not a claim of exhaustive coverage of every company or every pack
//   size in the country. Adding more is just appending to this array.
// - No product photos are bundled — there's no image-sourcing pipeline
//   in this app to source and license real branded photography at this
//   scale. Every catalog item renders with its category's icon
//   (matching CategoryBrowser) until the keeper attaches their own real
//   photo.
//
// Urdu: every item now carries a name_ur (a plain phonetic Urdu
// rendering of the same name, the way it'd actually be said/written
// locally — "Pepsi" as "پیپسی", not translated) alongside the English
// name printed on the real packaging, so nothing falls back to English
// on the product card in Urdu mode. flavor_ur is filled in the same way
// wherever the flavor/size is a real describable word.

export interface CatalogItem {
  name: string
  name_ur?: string
  flavor?: string
  flavor_ur?: string
  category: string
  price?: number
}
export interface CatalogBrand {
  slug: string
  name: string
  name_ur: string
  icon: string
  items: CatalogItem[]
}

// Real PepsiCo/Coca-Cola pack sizes sold in Pakistan today — glass,
// can and PET, from the small "on the go" bottle up to the family
// 2.25L. Reused for every carbonated-drink line below so each flavor ×
// size combination becomes its own selectable SKU, matching how they
// actually sit on a shop's shelf.
const COLA_SIZES: { en: string; ur: string }[] = [
  { en: '250ml Glass Bottle', ur: '250 ملی لیٹر شیشے کی بوتل' },
  { en: '345ml Can', ur: '345 ملی لیٹر کین' },
  { en: '500ml PET Bottle', ur: '500 ملی لیٹر پلاسٹک بوتل' },
  { en: '1 Litre PET Bottle', ur: '1 لیٹر پلاسٹک بوتل' },
  { en: '1.5 Litre PET Bottle', ur: '1.5 لیٹر پلاسٹک بوتل' },
  { en: '2.25 Litre PET Bottle', ur: '2.25 لیٹر پلاسٹک بوتل' },
]

function sizedDrink(name: string, name_ur: string, category = 'beverages'): CatalogItem[] {
  return COLA_SIZES.map((size) => ({ name, name_ur, flavor: size.en, flavor_ur: size.ur, category }))
}

export const PRODUCT_CATALOG: CatalogBrand[] = [
  {
    // Continental Biscuits Ltd (a Mondelez joint venture) — real lineup
    // per continentalbiscuits.com.pk/our-brands. Earlier this catalog had
    // wrongly folded in Bisconni and Peek Freans items here — those are
    // two entirely separate competing companies (Ismail Industries and
    // English Biscuit Manufacturers), now split into their own brand
    // entries below, not merged into this one.
    slug: 'lu', name: 'LU / Continental Biscuits', name_ur: 'ایل یو بسکٹ', icon: 'Cookie',
    items: [
      { name: 'Prince', name_ur: 'پرنس', flavor: 'Chocolate', flavor_ur: 'چاکلیٹ', category: 'biscuits_snacks' },
      { name: 'Prince', name_ur: 'پرنس', flavor: 'Original', flavor_ur: 'اورجنل', category: 'biscuits_snacks' },
      { name: 'Oreo', name_ur: 'اوریو', flavor: 'Original', flavor_ur: 'اورجنل', category: 'biscuits_snacks' },
      { name: 'TUC', name_ur: 'ٹک', category: 'biscuits_snacks' },
      { name: 'Candi', name_ur: 'کینڈی', category: 'biscuits_snacks' },
      { name: 'Tiger', name_ur: 'ٹائیگر', category: 'biscuits_snacks' },
      { name: 'Gala', name_ur: 'گالا', flavor: 'Egg Biscuit', flavor_ur: 'انڈے والا بسکٹ', category: 'biscuits_snacks' },
      { name: 'Cadbury Biscuits', name_ur: 'کیڈبری بسکٹ', category: 'biscuits_snacks' },
      { name: 'Zeera Plus', name_ur: 'زیرہ پلس', category: 'biscuits_snacks' },
      { name: 'Bakeri', name_ur: 'بیکری', flavor: 'Coconut', flavor_ur: 'ناریل', category: 'biscuits_snacks' },
      { name: 'Bakeri', name_ur: 'بیکری', flavor: 'Butter', flavor_ur: 'بٹر', category: 'biscuits_snacks' },
      { name: 'Wheatable', name_ur: 'ویٹیبل', flavor: 'High Fiber', flavor_ur: 'ہائی فائبر', category: 'biscuits_snacks' },
      { name: 'Milcolu', name_ur: 'ملکو ایل یو', flavor: 'Vanilla Cream', flavor_ur: 'ونیلا کریم', category: 'biscuits_snacks' },
    ],
  },
  {
    slug: 'ebm', name: 'EBM / Peek Freans', name_ur: 'ای بی ایم / پیک فرینز', icon: 'Cookie',
    items: [
      { name: 'Sooper', name_ur: 'سوپر', category: 'biscuits_snacks' },
      { name: 'Gluco', name_ur: 'گلوکو', category: 'biscuits_snacks' },
      { name: 'Marie', name_ur: 'میری', category: 'biscuits_snacks' },
      { name: 'Rio', name_ur: 'ریو', flavor: 'Chocolate', flavor_ur: 'چاکلیٹ', category: 'biscuits_snacks' },
      { name: 'Rio', name_ur: 'ریو', flavor: 'Strawberry Vanilla', flavor_ur: 'اسٹرابیری ونیلا', category: 'biscuits_snacks' },
      { name: 'Click', name_ur: 'کلک', category: 'biscuits_snacks' },
      { name: 'Party', name_ur: 'پارٹی', category: 'biscuits_snacks' },
      { name: 'Peanut Pik', name_ur: 'پی نٹ پک', category: 'biscuits_snacks' },
      { name: 'Lemon Sandwich', name_ur: 'لیموں سینڈوچ', category: 'biscuits_snacks' },
      { name: 'Chocolate Sandwich', name_ur: 'چاکلیٹ سینڈوچ', category: 'biscuits_snacks' },
      { name: 'Saltish', name_ur: 'سالٹش', category: 'biscuits_snacks' },
      { name: 'Nice', name_ur: 'نائس', category: 'biscuits_snacks' },
      { name: 'Cake Up', name_ur: 'کیک اپ', category: 'bakery' },
      { name: 'Choco Bites', name_ur: 'چاکو بائٹس', category: 'bakery' },
    ],
  },
  {
    slug: 'bisconni', name: 'Bisconni', name_ur: 'بسکونی', icon: 'Cookie',
    items: [
      { name: 'Bisconni Chocolatto', name_ur: 'بسکونی چاکلیٹو', category: 'biscuits_snacks' },
      { name: 'Cocomo', name_ur: 'کوکومو', category: 'biscuits_snacks' },
      { name: 'Novita', name_ur: 'نوویٹا', category: 'biscuits_snacks' },
      { name: 'Rite', name_ur: 'رائٹ', category: 'biscuits_snacks' },
      { name: 'Flo', name_ur: 'فلو', category: 'biscuits_snacks' },
    ],
  },
  {
    slug: 'mayfair', name: 'Mayfair Foods', name_ur: 'میفیئر فوڈز', icon: 'Candy',
    items: [
      // Confectionery — mayfairfood.com/pk/brand/confectionery
      { name: 'Frooto', name_ur: 'فروٹو', flavor: 'Mango', flavor_ur: 'آم', category: 'confectionery' },
      { name: 'Frooto', name_ur: 'فروٹو', flavor: 'Amrood', flavor_ur: 'امرود', category: 'confectionery' },
      { name: 'Frooto', name_ur: 'فروٹو', flavor: 'Peach', flavor_ur: 'آڑو', category: 'confectionery' },
      { name: 'Frooto', name_ur: 'فروٹو', flavor: 'Coconut', flavor_ur: 'ناریل', category: 'confectionery' },
      { name: 'Frooto', name_ur: 'فروٹو', flavor: 'Lemon', flavor_ur: 'لیموں', category: 'confectionery' },
      { name: 'Chaska', name_ur: 'چسکا', flavor: 'Green Mango', flavor_ur: 'کچا آم', category: 'confectionery' },
      { name: 'Chaska', name_ur: 'چسکا', flavor: 'Amrood', flavor_ur: 'امرود', category: 'confectionery' },
      { name: 'Chaska', name_ur: 'چسکا', flavor: 'Orange', flavor_ur: 'مالٹا', category: 'confectionery' },
      { name: 'Milko Toffee', name_ur: 'ملکو ٹافی', category: 'confectionery' },
      { name: 'Fruit Gala', name_ur: 'فروٹ گالا', flavor: 'Blackcurrant', flavor_ur: 'بلیک کرنٹ', category: 'confectionery' },
      { name: 'Fruit Gala', name_ur: 'فروٹ گالا', flavor: 'Strawberry', flavor_ur: 'اسٹرابیری', category: 'confectionery' },
      { name: 'Fruit Gala', name_ur: 'فروٹ گالا', flavor: 'Green Apple', flavor_ur: 'سبز سیب', category: 'confectionery' },
      { name: 'Fruit Gala', name_ur: 'فروٹ گالا', flavor: 'Orange', flavor_ur: 'مالٹا', category: 'confectionery' },
      { name: 'Mayfair Eclairs', name_ur: 'میفیئر ایکلیئرز', category: 'confectionery' },
      { name: 'Raging Sours', name_ur: 'ریجنگ ساورز', category: 'confectionery' },
      { name: 'Creamers', name_ur: 'کریمرز', flavor: 'Banana & Crème', flavor_ur: 'کیلا کریم', category: 'confectionery' },
      { name: 'Creamers', name_ur: 'کریمرز', flavor: 'Strawberry & Crème', flavor_ur: 'اسٹرابیری کریم', category: 'confectionery' },
      { name: 'Wobbly Jellies', name_ur: 'وابلی جیلیز', flavor: 'Strawberry', flavor_ur: 'اسٹرابیری', category: 'confectionery' },
      { name: 'Mayfair Bubble', name_ur: 'میفیئر بلبل گم', category: 'confectionery' },
      // Biscuits — mayfairfood.com/pk/brand/biscuits
      { name: 'Cremo', name_ur: 'کریمو', flavor: 'Chocolate', flavor_ur: 'چاکلیٹ', category: 'biscuits_snacks' },
      { name: 'Cremo', name_ur: 'کریمو', flavor: 'Strawberry', flavor_ur: 'اسٹرابیری', category: 'biscuits_snacks' },
      { name: 'Mayfair Special', name_ur: 'میفیئر اسپیشل', flavor: 'Classic', flavor_ur: 'کلاسک', category: 'biscuits_snacks' },
      { name: 'Mayfair Special', name_ur: 'میفیئر اسپیشل', flavor: 'Chocolate', flavor_ur: 'چاکلیٹ', category: 'biscuits_snacks' },
      { name: 'Café', name_ur: 'کیفے', category: 'biscuits_snacks' },
      { name: 'Besto', name_ur: 'بیسٹو', category: 'biscuits_snacks' },
      { name: 'Energi', name_ur: 'انرجی', category: 'biscuits_snacks' },
      { name: 'Wow', name_ur: 'واؤ', category: 'biscuits_snacks' },
      { name: 'A1', name_ur: 'اے ون', category: 'biscuits_snacks' },
      { name: 'Chocday', name_ur: 'چاک ڈے', category: 'biscuits_snacks' },
      // Baked — mayfairfood.com/pk/brand/baked
      { name: 'Mayfair Hearts', name_ur: 'میفیئر ہارٹس', category: 'bakery' },
      { name: 'Mayfair Croissant', name_ur: 'میفیئر کروسان', flavor: 'Chocolate Filled', flavor_ur: 'چاکلیٹ فلڈ', category: 'bakery' },
    ],
  },
  {
    slug: 'candyland', name: 'Candyland', name_ur: 'کینڈی لینڈ', icon: 'Candy',
    items: [
      { name: 'Chili Mili', name_ur: 'چلی ملی', category: 'confectionery' },
      { name: 'ABC Jelly', name_ur: 'اے بی سی جیلی', category: 'confectionery' },
      { name: 'Cola Premium Jelly', name_ur: 'کولا پریمیم جیلی', category: 'confectionery' },
      { name: 'Bottle Jelly', name_ur: 'بوتل جیلی', category: 'confectionery' },
      { name: 'Fizzy-O Jelly', name_ur: 'فِزی او جیلی', category: 'confectionery' },
      { name: 'Fanty', name_ur: 'فینٹی', category: 'confectionery' },
      { name: 'Corona Mango', name_ur: 'کرونا مینگو', category: 'confectionery' },
      { name: 'Funny Bunny', name_ur: 'فنی بنی', flavor: 'Lollipop', flavor_ur: 'لالی پاپ', category: 'confectionery' },
      { name: 'Puffs Marshmallow', name_ur: 'پفس مارشمیلو', category: 'confectionery' },
      { name: 'Super Twister', name_ur: 'سپر ٹوئسٹر', category: 'confectionery' },
      { name: 'Mello Marshmallow', name_ur: 'میلو مارشمیلو', flavor: 'Chocolate', flavor_ur: 'چاکلیٹ', category: 'confectionery' },
      { name: 'Yums', name_ur: 'یمز', category: 'confectionery' },
      { name: 'Bisca Chocolate', name_ur: 'بسکا چاکلیٹ', category: 'confectionery' },
      { name: 'Rush Chocolate', name_ur: 'رش چاکلیٹ', category: 'confectionery' },
      { name: 'Cosmo Chocolate', name_ur: 'کاسمو چاکلیٹ', category: 'confectionery' },
      { name: 'Novella Chocolate', name_ur: 'نویلا چاکلیٹ', category: 'confectionery' },
      { name: 'Bubble Pop Gum', name_ur: 'بلبل پاپ گم', category: 'confectionery' },
      { name: 'Butter Scotch Candy', name_ur: 'بٹر اسکاچ کینڈی', category: 'confectionery' },
      { name: 'Pebbles', name_ur: 'پیبلز', category: 'confectionery' },
    ],
  },
  {
    slug: 'national', name: 'National Foods', name_ur: 'نیشنل فوڈز', icon: 'Flame',
    items: [
      { name: 'National', name_ur: 'نیشنل', flavor: 'Chana Masala', flavor_ur: 'چنے کا مصالحہ', category: 'spices_masala' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Biryani Masala', flavor_ur: 'بریانی مصالحہ', category: 'spices_masala' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Karahi Masala', flavor_ur: 'کڑاہی مصالحہ', category: 'spices_masala' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Achar Gosht Masala', flavor_ur: 'اچار گوشت مصالحہ', category: 'spices_masala' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Tikka Masala', flavor_ur: 'تکہ مصالحہ', category: 'spices_masala' },
      { name: 'National Red Chilli Powder', name_ur: 'نیشنل لال مرچ پاؤڈر', category: 'spices_masala' },
      { name: 'National Turmeric Powder', name_ur: 'نیشنل ہلدی پاؤڈر', category: 'spices_masala' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Chaat Masala', flavor_ur: 'چاٹ مصالحہ', category: 'spices_masala' },
      { name: 'National Tomato Ketchup', name_ur: 'نیشنل ٹماٹر کیچپ', category: 'pickles_sauces' },
      { name: 'National Vinegar', name_ur: 'نیشنل سرکہ', category: 'pickles_sauces' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Mango Pickle', flavor_ur: 'آم کا اچار', category: 'pickles_sauces' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Mixed Pickle', flavor_ur: 'مکس اچار', category: 'pickles_sauces' },
      { name: 'National', name_ur: 'نیشنل', flavor: 'Mixed Fruit Chutney', flavor_ur: 'مکس فروٹ چٹنی', category: 'pickles_sauces' },
      { name: 'National Mayonnaise', name_ur: 'نیشنل میئونیز', category: 'pickles_sauces' },
      { name: 'National Soy Sauce', name_ur: 'نیشنل سویا ساس', category: 'pickles_sauces' },
      { name: 'National Chilli Garlic Sauce', name_ur: 'نیشنل چلی گارلک ساس', category: 'pickles_sauces' },
      { name: 'National Ginger Garlic Paste', name_ur: 'نیشنل ادرک لہسن پیسٹ', category: 'spices_masala' },
      { name: 'National Jam', name_ur: 'نیشنل جیم', flavor: 'Mixed Fruit', flavor_ur: 'مکس فروٹ', category: 'honey_jam_spreads' },
    ],
  },
  {
    slug: 'shan', name: 'Shan Foods', name_ur: 'شان فوڈز', icon: 'Flame',
    items: [
      { name: 'Shan', name_ur: 'شان', flavor: 'Biryani Masala', flavor_ur: 'بریانی مصالحہ', category: 'spices_masala' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Bombay Biryani Masala', flavor_ur: 'بمبئی بریانی مصالحہ', category: 'spices_masala' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Karahi Masala', flavor_ur: 'کڑاہی مصالحہ', category: 'spices_masala' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Nihari Masala', flavor_ur: 'نہاری مصالحہ', category: 'spices_masala' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Kabab Masala', flavor_ur: 'کباب مصالحہ', category: 'spices_masala' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Chana Masala', flavor_ur: 'چنے کا مصالحہ', category: 'spices_masala' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Haleem Mix', flavor_ur: 'حلیم مکس', category: 'spices_masala' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Mango Pickle', flavor_ur: 'آم کا اچار', category: 'pickles_sauces' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Mixed Pickle', flavor_ur: 'مکس اچار', category: 'pickles_sauces' },
      { name: 'Shan', name_ur: 'شان', flavor: 'Mango Chutney', flavor_ur: 'آم کی چٹنی', category: 'pickles_sauces' },
      { name: 'Shan Chatni', name_ur: 'شان چٹنی', flavor: 'Green Chutney', flavor_ur: 'ہری چٹنی', category: 'pickles_sauces' },
      { name: 'Shan Tamarind Sauce', name_ur: 'شان املی ساس', category: 'pickles_sauces' },
      { name: 'Shoop Noodles', name_ur: 'شوپ نوڈلز', category: 'noodles_pasta' },
    ],
  },
  {
    slug: 'tapal', name: 'Tapal', name_ur: 'ٹیپال', icon: 'Coffee',
    items: [
      { name: 'Tapal Danedar', name_ur: 'ٹیپال دانیدار', category: 'tea_coffee' },
      { name: 'Tapal Family Mixture', name_ur: 'ٹیپال فیملی مکسچر', category: 'tea_coffee' },
      { name: 'Tapal Mezban', name_ur: 'ٹیپال میزبان', category: 'tea_coffee' },
      { name: 'Tapal Green Tea', name_ur: 'ٹیپال گرین ٹی', category: 'tea_coffee' },
    ],
  },
  {
    slug: 'lipton', name: 'Lipton', name_ur: 'لپٹن', icon: 'Coffee',
    items: [
      { name: 'Lipton Yellow Label', name_ur: 'لپٹن ییلو لیبل', category: 'tea_coffee' },
    ],
  },
  {
    slug: 'unilever_personal', name: 'Unilever — Personal Care', name_ur: 'یونی لیور — ذاتی نگہداشت', icon: 'Sparkles',
    items: [
      { name: 'Lifebuoy Total 10', name_ur: 'لائف بوائے ٹوٹل 10', flavor: 'Soap', flavor_ur: 'صابن', category: 'skin_bath_care' },
      { name: 'Lux', name_ur: 'لکس', flavor: 'Rose Soap', flavor_ur: 'گلاب صابن', category: 'skin_bath_care' },
      { name: 'Lux', name_ur: 'لکس', flavor: 'Peach Soap', flavor_ur: 'آڑو صابن', category: 'skin_bath_care' },
      { name: 'Sunsilk Shampoo', name_ur: 'سن سلک شیمپو', flavor: 'Black Shine', flavor_ur: 'بلیک شائن', category: 'hair_care' },
      { name: 'Sunsilk Shampoo', name_ur: 'سن سلک شیمپو', flavor: 'Lively Clean', flavor_ur: 'لائیولی کلین', category: 'hair_care' },
      { name: 'Clear Shampoo', name_ur: 'کلیئر شیمپو', flavor: 'Men', flavor_ur: 'مردوں کے لیے', category: 'hair_care' },
      { name: 'Closeup Toothpaste', name_ur: 'کلوز اپ ٹوتھ پیسٹ', flavor: 'Red Hot', flavor_ur: 'ریڈ ہاٹ', category: 'oral_care' },
      { name: 'Closeup Toothpaste', name_ur: 'کلوز اپ ٹوتھ پیسٹ', flavor: 'Ever Fresh', flavor_ur: 'ایور فریش', category: 'oral_care' },
      { name: 'Glow & Lovely Cream', name_ur: 'گلو اینڈ لولی کریم', category: 'cosmetics_beauty' },
      { name: 'Ponds Cream', name_ur: 'پونڈز کریم', category: 'cosmetics_beauty' },
      { name: 'Vaseline Lotion', name_ur: 'ویزلین لوشن', category: 'cosmetics_beauty' },
    ],
  },
  {
    slug: 'unilever_home', name: 'Unilever — Home Care', name_ur: 'یونی لیور — گھریلو صفائی', icon: 'SprayCan',
    items: [
      { name: 'Surf Excel', name_ur: 'سرف ایکسل', flavor: 'Bar', flavor_ur: 'بار', category: 'laundry_detergent' },
      { name: 'Surf Excel', name_ur: 'سرف ایکسل', flavor: 'Powder', flavor_ur: 'پاؤڈر', category: 'laundry_detergent' },
      { name: 'Wheel Detergent Powder', name_ur: 'ویل واشنگ پاؤڈر', category: 'laundry_detergent' },
      { name: 'Vim Dishwash Bar', name_ur: 'وِم برتن دھونے کی بار', category: 'dishwashing' },
      { name: 'Vim Dishwash Liquid', name_ur: 'وِم برتن دھونے کا مائع', category: 'dishwashing' },
    ],
  },
  {
    slug: 'pg', name: 'P&G', name_ur: 'پی اینڈ جی', icon: 'SprayCan',
    items: [
      { name: 'Ariel Powder', name_ur: 'ایریل واشنگ پاؤڈر', category: 'laundry_detergent' },
      { name: 'Bonus Detergent', name_ur: 'بونس واشنگ پاؤڈر', category: 'laundry_detergent' },
      { name: 'Head & Shoulders Shampoo', name_ur: 'ہیڈ اینڈ شولڈرز شیمپو', category: 'hair_care' },
      { name: 'Pantene Shampoo', name_ur: 'پینٹین شیمپو', category: 'hair_care' },
      { name: 'Safeguard Soap', name_ur: 'سیف گارڈ صابن', category: 'skin_bath_care' },
      { name: 'Pampers', name_ur: 'پیمپرز', flavor: 'Small', flavor_ur: 'سمال', category: 'diapers_wipes' },
      { name: 'Pampers', name_ur: 'پیمپرز', flavor: 'Medium', flavor_ur: 'میڈیم', category: 'diapers_wipes' },
      { name: 'Pampers', name_ur: 'پیمپرز', flavor: 'Large', flavor_ur: 'لارج', category: 'diapers_wipes' },
      { name: 'Pampers Baby Wipes', name_ur: 'پیمپرز بے بی وائپس', category: 'diapers_wipes' },
    ],
  },
  {
    slug: 'reckitt', name: 'Reckitt Benckiser', name_ur: 'ریکٹ بینکائزر', icon: 'SprayCan',
    items: [
      { name: 'Dettol', name_ur: 'ڈیٹول', flavor: 'Antiseptic Liquid', flavor_ur: 'اینٹی سیپٹک مائع', category: 'skin_bath_care' },
      { name: 'Dettol Soap', name_ur: 'ڈیٹول صابن', category: 'skin_bath_care' },
      { name: 'Dettol Handwash', name_ur: 'ڈیٹول ہینڈ واش', category: 'skin_bath_care' },
      { name: 'Harpic Toilet Cleaner', name_ur: 'ہارپک ٹائلٹ کلینر', category: 'household' },
      { name: 'Vanish Fabric Stain Remover', name_ur: 'وینش داغ صاف کرنے والا', category: 'laundry_detergent' },
      { name: 'Mortein Insect Spray', name_ur: 'مارٹین کیڑے مار اسپرے', category: 'air_insect_care' },
      { name: 'Genie Fabric Softener', name_ur: 'جینی کپڑے نرم کرنے والا', category: 'laundry_detergent' },
    ],
  },
  {
    slug: 'colgate', name: 'Colgate-Palmolive', name_ur: 'کولگیٹ پامولیو', icon: 'Sparkles',
    items: [
      { name: 'Colgate Toothpaste', name_ur: 'کولگیٹ ٹوتھ پیسٹ', flavor: 'Total', flavor_ur: 'ٹوٹل', category: 'oral_care' },
      { name: 'Colgate Toothpaste', name_ur: 'کولگیٹ ٹوتھ پیسٹ', flavor: 'MaxFresh', flavor_ur: 'میکس فریش', category: 'oral_care' },
      { name: 'Colgate Toothbrush', name_ur: 'کولگیٹ ٹوتھ برش', category: 'oral_care' },
      { name: 'Palmolive Soap', name_ur: 'پامولیو صابن', category: 'skin_bath_care' },
    ],
  },
  {
    slug: 'engro', name: 'Engro Foods', name_ur: 'اینگرو فوڈز', icon: 'Milk',
    items: [
      { name: 'Olpers Milk', name_ur: 'اولپرز دودھ', category: 'dairy_eggs' },
      { name: 'Olwell Milk', name_ur: 'اولویل دودھ', category: 'dairy_eggs' },
      { name: 'Tarang', name_ur: 'ترنگ', flavor: 'Tea Whitener', flavor_ur: 'چائے وائٹنر', category: 'dairy_eggs' },
      { name: 'Omore Ice Cream', name_ur: 'اومور آئس کریم', category: 'frozen' },
    ],
  },
  {
    slug: 'nestle', name: 'Nestlé Pakistan', name_ur: 'نیسلے پاکستان', icon: 'Milk',
    items: [
      { name: 'Nestlé Milkpak', name_ur: 'نیسلے ملک پیک', category: 'dairy_eggs' },
      { name: 'Nestlé Everyday', name_ur: 'نیسلے ایوری ڈے', flavor: 'Tea Whitener', flavor_ur: 'چائے وائٹنر', category: 'dairy_eggs' },
      { name: 'Nestlé Nesvita', name_ur: 'نیسلے نیسویٹا', category: 'dairy_eggs' },
      { name: 'Nestlé Fruita Vitals Juice', name_ur: 'نیسلے فروٹا وائٹلز جوس', category: 'beverages' },
      { name: 'Nescafé Classic', name_ur: 'نیسکیفے کلاسک', category: 'tea_coffee' },
      { name: 'Maggi Noodles', name_ur: 'میگی نوڈلز', category: 'noodles_pasta' },
      { name: 'Cerelac', name_ur: 'سیریلیک', flavor: 'Wheat', flavor_ur: 'گندم', category: 'baby_food_feeding' },
      { name: 'Lactogen', name_ur: 'لیکٹوجن', category: 'baby_food_feeding' },
    ],
  },
  {
    slug: 'haleeb', name: 'Haleeb Foods', name_ur: 'حلیب فوڈز', icon: 'Milk',
    items: [
      { name: 'Haleeb Milk', name_ur: 'حلیب دودھ', category: 'dairy_eggs' },
      { name: 'Haleeb Cream', name_ur: 'حلیب کریم', category: 'dairy_eggs' },
    ],
  },
  {
    // Real lineup per unilever.pk/brands and search results — Wall's own
    // kulfi products (Jashan Kulfi, King's Kulfi) are genuine branded
    // items, kept separate from the unbranded "Desi Kulfi" entry below.
    slug: 'walls', name: "Wall's", name_ur: 'والز', icon: 'IceCreamCone',
    items: [
      { name: 'Cornetto', name_ur: 'کورنیٹو', category: 'ice_cream' },
      { name: 'Magnum', name_ur: 'میگنم', category: 'ice_cream' },
      { name: 'Paddle Pop', name_ur: 'پیڈل پوپ', category: 'ice_cream' },
      { name: 'Feast', name_ur: 'فیسٹ', category: 'ice_cream' },
      { name: "Wall's", name_ur: 'والز', flavor: 'Chocbar', flavor_ur: 'چاک بار', category: 'ice_cream' },
      { name: 'Jashan Kulfi', name_ur: 'جشن کلفی', category: 'ice_cream' },
      { name: "King's Kulfi", name_ur: 'کنگز کلفی', flavor: 'Pista', flavor_ur: 'پستہ', category: 'ice_cream' },
      { name: "King's Kulfi", name_ur: 'کنگز کلفی', flavor: 'Mango', flavor_ur: 'آم', category: 'ice_cream' },
    ],
  },
  {
    // Not a company — the traditional stick/cup kulfi a small local dairy
    // or vendor supplies to general stores, unbranded (unlike Wall's
    // packaged kulfi above). Kept as its own honest "Local & Traditional"
    // entry rather than invented as a fake company name.
    slug: 'local_desi', name: 'Local & Traditional', name_ur: 'دیسی اور روایتی', icon: 'IceCreamCone',
    items: [
      { name: 'Desi Kulfi', name_ur: 'دیسی کلفی', category: 'ice_cream' },
      { name: 'Desi Kulfi', name_ur: 'دیسی کلفی', flavor: 'Shahi', flavor_ur: 'شاہی', category: 'ice_cream' },
      { name: 'Falooda Kulfi', name_ur: 'فالودہ کلفی', category: 'ice_cream' },
      // Loose namkeen mix a local vendor makes/packs, not a national
      // brand — same honest-unbranded treatment as the kulfi above.
      { name: 'Nimko Mix', name_ur: 'نمکو مکس', category: 'chips_nimko' },
      { name: 'Dal Moong Nimko', name_ur: 'دال مونگ نمکو', category: 'chips_nimko' },
      { name: 'Chana Chor Garam', name_ur: 'چنا چور گرم', category: 'chips_nimko' },
    ],
  },
  // Real packaged chips/nimko brands actually sold in Pakistan, per
  // Wikipedia's Kurkure/Lay's entries, laysaroundtheworld.com's Pakistan
  // flavor writeup and Kolson Slanty retail listings (yumtreats.pk,
  // gandhifood.com) — checked before adding, same discipline as the rest
  // of this file. All under the new chips_nimko category (migration 408),
  // split out of biscuits_snacks.
  {
    slug: 'lays', name: "Lay's", name_ur: 'لेز', icon: 'Popcorn',
    items: [
      { name: "Lay's", name_ur: 'لیز', flavor: 'Classic Salted', flavor_ur: 'کلاسک نمکین', category: 'chips_nimko' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Masala', flavor_ur: 'مصالحہ', category: 'chips_nimko' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Flamin\' Hot', flavor_ur: 'فلیمن ہاٹ', category: 'chips_nimko' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Yogurt & Herb', flavor_ur: 'دہی اور جڑی بوٹی', category: 'chips_nimko' },
    ],
  },
  {
    slug: 'kurkure', name: 'Kurkure', name_ur: 'کرکرے', icon: 'Popcorn',
    items: [
      { name: 'Kurkure', name_ur: 'کرکرے', flavor: 'Chutney Chaska', flavor_ur: 'چٹنی چسکا', category: 'chips_nimko' },
      { name: 'Kurkure', name_ur: 'کرکرے', flavor: 'Nimko (Chatpata Mix)', flavor_ur: 'نمکو (چٹپٹا مکس)', category: 'chips_nimko' },
      { name: 'Kurkure', name_ur: 'کرکرے', flavor: 'Red Chilli', flavor_ur: 'لال مرچ', category: 'chips_nimko' },
      { name: 'Kurkure', name_ur: 'کرکرے', flavor: 'Toofani Mirch', flavor_ur: 'طوفانی مرچ', category: 'chips_nimko' },
    ],
  },
  {
    slug: 'kolson_slanty', name: 'Kolson Slanty', name_ur: 'کولسن سلینٹی', icon: 'Popcorn',
    items: [
      { name: 'Slanty', name_ur: 'سلینٹی', flavor: 'Salted', flavor_ur: 'نمکین', category: 'chips_nimko' },
      { name: 'Slanty', name_ur: 'سلینٹی', flavor: 'Vegetable', flavor_ur: 'ویجیٹیبل', category: 'chips_nimko' },
      { name: 'Slanty', name_ur: 'سلینٹی', flavor: 'Jalapeno', flavor_ur: 'جالاپینو', category: 'chips_nimko' },
      { name: 'Slanty', name_ur: 'سلینٹی', flavor: 'Cheese', flavor_ur: 'چیز', category: 'chips_nimko' },
    ],
  },
  // Gas cylinder agencies — the three real LPG marketing companies with
  // an actual cylinder/retail network in Pakistan, per ppgl.com.pk,
  // psopk.com and the Burshane (formerly Shell Gas) LPG listing. These
  // only ever appear when browsing a "Gas Cylinder Agency" shop
  // (gas_agency shop type) — the categories here don't exist on a
  // general_store's own tree.
  {
    slug: 'parco_pearl', name: 'PARCO Pearl Gas', name_ur: 'پارکو پرل گیس', icon: 'Flame',
    items: [
      { name: 'Pearl Gas', name_ur: 'پرل گیس', flavor: 'Domestic Cylinder 11.8kg', flavor_ur: 'گھریلو سلنڈر 11.8 کلو', category: 'domestic_cylinder' },
      { name: 'Pearl Gas', name_ur: 'پرل گیس', flavor: 'Portable Cylinder', flavor_ur: 'چھوٹا سلنڈر', category: 'portable_cylinder' },
      { name: 'Pearl Gas', name_ur: 'پرل گیس', flavor: 'Domestic Refill', flavor_ur: 'گھریلو ری فل', category: 'domestic_refill' },
      { name: 'Pearl Gas Regulator', name_ur: 'پرل گیس ریگولیٹر', category: 'regulator' },
    ],
  },
  {
    slug: 'pso_pakgas', name: 'PSO Pak Gas', name_ur: 'پی ایس او پاک گیس', icon: 'Flame',
    items: [
      { name: 'Pak Gas', name_ur: 'پاک گیس', flavor: 'Domestic Cylinder', flavor_ur: 'گھریلو سلنڈر', category: 'domestic_cylinder' },
      { name: 'Pak Gas', name_ur: 'پاک گیس', flavor: 'Domestic Refill', flavor_ur: 'گھریلو ری فل', category: 'domestic_refill' },
      { name: 'Pak Gas', name_ur: 'پاک گیس', flavor: 'Commercial Refill', flavor_ur: 'کمرشل ری فل', category: 'commercial_refill' },
    ],
  },
  {
    slug: 'burshane', name: 'Burshane (Shell Gas)', name_ur: 'برشین (شیل گیس)', icon: 'Flame',
    items: [
      { name: 'Burshane LPG', name_ur: 'برشین ایل پی جی', flavor: 'Domestic Cylinder', flavor_ur: 'گھریلو سلنڈر', category: 'domestic_cylinder' },
      { name: 'Burshane LPG', name_ur: 'برشین ایل پی جی', flavor: 'Domestic Refill', flavor_ur: 'گھریلو ری فل', category: 'domestic_refill' },
    ],
  },
  // Fresh produce — not a branded company (kiryana stores buy this loose
  // from the mandi, not from a manufacturer), so these sit under a
  // plain "Fresh Produce" heading instead of a fabricated brand name —
  // the everyday vegetables/fruits/cooking basics every general store
  // keeps, so there's always something to pick even for the one
  // department here that's never going to have a real company behind it.
  {
    slug: 'fresh_produce', name: 'Fresh Produce', name_ur: 'تازہ سبزیاں اور پھل', icon: 'Carrot',
    items: [
      { name: 'Potato', name_ur: 'آلو', category: 'fruits_vegetables' },
      { name: 'Onion', name_ur: 'پیاز', category: 'fruits_vegetables' },
      { name: 'Tomato', name_ur: 'ٹماٹر', category: 'fruits_vegetables' },
      { name: 'Garlic', name_ur: 'لہسن', category: 'fruits_vegetables' },
      { name: 'Ginger', name_ur: 'ادرک', category: 'fruits_vegetables' },
      { name: 'Green Chilli', name_ur: 'ہری مرچ', category: 'fruits_vegetables' },
      { name: 'Coriander', name_ur: 'دھنیا', category: 'fruits_vegetables' },
      { name: 'Mint', name_ur: 'پودینہ', category: 'fruits_vegetables' },
      { name: 'Cucumber', name_ur: 'کھیرا', category: 'fruits_vegetables' },
      { name: 'Lemon', name_ur: 'لیموں', category: 'fruits_vegetables' },
      { name: 'Spinach', name_ur: 'پالک', category: 'fruits_vegetables' },
      { name: 'Cauliflower', name_ur: 'گوبھی', category: 'fruits_vegetables' },
      { name: 'Capsicum', name_ur: 'شملہ مرچ', category: 'fruits_vegetables' },
      { name: 'Carrot', name_ur: 'گاجر', category: 'fruits_vegetables' },
      { name: 'Banana', name_ur: 'کیلا', category: 'fruits_vegetables' },
      { name: 'Apple', name_ur: 'سیب', category: 'fruits_vegetables' },
      { name: 'Orange', name_ur: 'مالٹا', category: 'fruits_vegetables' },
      { name: 'Mango', name_ur: 'آم', category: 'fruits_vegetables' },
      { name: 'Watermelon', name_ur: 'تربوز', category: 'fruits_vegetables' },
      { name: 'Guava', name_ur: 'امرود', category: 'fruits_vegetables' },
    ],
  },
  {
    slug: 'cocacola', name: 'Coca-Cola', name_ur: 'کوکا کولا', icon: 'CupSoda',
    items: [
      ...sizedDrink('Coca-Cola', 'کوکا کولا'),
      ...sizedDrink('Sprite', 'سپرائٹ'),
      ...sizedDrink('Fanta', 'فانٹا'),
    ],
  },
  {
    slug: 'pepsico', name: 'PepsiCo', name_ur: 'پیپسی کو', icon: 'CupSoda',
    items: [
      // Real per-size prices checked live tonight (pakistandeals.pk) —
      // every other size here is a real, sold SKU but without a
      // separately-verified price, so it starts blank like the rest of
      // the catalog rather than guess one.
      { name: 'Pepsi', name_ur: 'پیپسی', flavor: '250ml Glass Bottle', flavor_ur: '250 ملی لیٹر شیشے کی بوتل', category: 'beverages' },
      { name: 'Pepsi', name_ur: 'پیپسی', flavor: '345ml Can', flavor_ur: '345 ملی لیٹر کین', category: 'beverages' },
      { name: 'Pepsi', name_ur: 'پیپسی', flavor: '500ml PET Bottle', flavor_ur: '500 ملی لیٹر پلاسٹک بوتل', category: 'beverages', price: 99 },
      { name: 'Pepsi', name_ur: 'پیپسی', flavor: '1 Litre PET Bottle', flavor_ur: '1 لیٹر پلاسٹک بوتل', category: 'beverages' },
      { name: 'Pepsi', name_ur: 'پیپسی', flavor: '1.5 Litre PET Bottle', flavor_ur: '1.5 لیٹر پلاسٹک بوتل', category: 'beverages', price: 150 },
      { name: 'Pepsi', name_ur: 'پیپسی', flavor: '2.25 Litre PET Bottle', flavor_ur: '2.25 لیٹر پلاسٹک بوتل', category: 'beverages' },
      { name: 'Pepsi Diet', name_ur: 'پیپسی ڈائیٹ', flavor: '1.5 Litre PET Bottle', flavor_ur: '1.5 لیٹر پلاسٹک بوتل', category: 'beverages' },
      ...sizedDrink('7Up', 'سیون اپ'),
      ...sizedDrink('Mirinda', 'مرینڈا'),
      { name: 'Sting Energy Drink', name_ur: 'اسٹنگ انرجی ڈرنک', category: 'beverages' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Classic Salted, 20g', flavor_ur: 'کلاسک نمکین، 20 گرام', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Classic Salted, 80g', flavor_ur: 'کلاسک نمکین، 80 گرام', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Masala, 21g', flavor_ur: 'مصالحہ، 21 گرام', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Masala, 30g', flavor_ur: 'مصالحہ، 30 گرام', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Chilli, 14g', flavor_ur: 'چٹ پٹی، 14 گرام', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Paprika, 24g', flavor_ur: 'پیپریکا، 24 گرام', category: 'biscuits_snacks' },
      { name: 'Kurkure', name_ur: 'کرکرے', flavor: 'Masala Munch', flavor_ur: 'مصالحہ منچ', category: 'biscuits_snacks' },
      { name: 'Kurkure', name_ur: 'کرکرے', flavor: 'Chutney Chaska', flavor_ur: 'چٹنی چسکا', category: 'biscuits_snacks' },
    ],
  },
  {
    slug: 'hamdard', name: 'Hamdard', name_ur: 'ہمدرد', icon: 'FlaskConical',
    items: [
      { name: 'Rooh Afza Syrup', name_ur: 'روح افزا شربت', category: 'beverages' },
    ],
  },
  // Cooking oil & ghee — the four names Al-Fatah's own oil/ghee category
  // page and search listings kept naming as the household staples,
  // checked before adding (Dalda, Sufi Foods, Meezan, Kashmir).
  {
    slug: 'dalda', name: 'Dalda', name_ur: 'ڈالڈا', icon: 'Droplet',
    items: [
      { name: 'Dalda Cooking Oil', name_ur: 'ڈالڈا کوکنگ آئل', category: 'cooking_oil_ghee' },
      { name: 'Dalda Banaspati Ghee', name_ur: 'ڈالڈا بناسپتی گھی', category: 'cooking_oil_ghee' },
    ],
  },
  {
    slug: 'sufi', name: 'Sufi', name_ur: 'صوفی', icon: 'Droplet',
    items: [
      { name: 'Sufi Cooking Oil', name_ur: 'صوفی کوکنگ آئل', category: 'cooking_oil_ghee' },
      { name: 'Sufi Banaspati Ghee', name_ur: 'صوفی بناسپتی گھی', category: 'cooking_oil_ghee' },
    ],
  },
  {
    slug: 'meezan', name: 'Meezan', name_ur: 'میزان', icon: 'Droplet',
    items: [
      { name: 'Meezan Cooking Oil', name_ur: 'میزان کوکنگ آئل', category: 'cooking_oil_ghee' },
      { name: 'Meezan Banaspati Ghee', name_ur: 'میزان بناسپتی گھی', category: 'cooking_oil_ghee' },
    ],
  },
  {
    slug: 'kashmir', name: 'Kashmir', name_ur: 'کشمیر', icon: 'Droplet',
    items: [
      { name: 'Kashmir Cooking Oil', name_ur: 'کشمیر کوکنگ آئل', category: 'cooking_oil_ghee' },
      { name: 'Kashmir Banaspati Ghee', name_ur: 'کشمیر بناسپتی گھی', category: 'cooking_oil_ghee' },
    ],
  },
  // Basmati rice — Guard (the original packaged-basmati pioneer in
  // Pakistan) and Falak (Matco Foods' flagship, "King of Basmati" in
  // export markets) — both confirmed real before adding.
  {
    slug: 'guard', name: 'Guard', name_ur: 'گارڈ', icon: 'Wheat',
    items: [
      { name: 'Guard Basmati Rice', name_ur: 'گارڈ باسمتی چاول', category: 'grains_pulses' },
      { name: 'Guard Supreme Basmati Rice', name_ur: 'گارڈ سپریم باسمتی چاول', category: 'grains_pulses' },
      { name: 'Guard Brown Basmati Rice', name_ur: 'گارڈ براؤن باسمتی چاول', category: 'grains_pulses' },
    ],
  },
  {
    slug: 'falak', name: 'Falak', name_ur: 'فلک', icon: 'Wheat',
    items: [
      { name: 'Falak Basmati Rice', name_ur: 'فلک باسمتی چاول', category: 'grains_pulses' },
      { name: 'Falak Extreme Basmati Rice', name_ur: 'فلک ایکسٹریم باسمتی چاول', category: 'grains_pulses' },
    ],
  },
  // Tissue & paper — Rose Petal (real facial tissue/toilet-roll/kitchen-
  // towel maker, checked at rosepetal.com.pk; the brand's own sub-names
  // for toilet roll ("Maxob") and kitchen towel ("Zzoop") kept as-is
  // rather than generalized, since that's what's actually printed on
  // the pack).
  {
    slug: 'rose_petal', name: 'Rose Petal', name_ur: 'روز پیٹل', icon: 'Layers',
    items: [
      { name: 'Rose Petal Facial Tissue', name_ur: 'روز پیٹل فیشل ٹشو', category: 'tissue_paper' },
      { name: 'Rose Petal', name_ur: 'روز پیٹل', flavor: 'Maxob Toilet Roll', flavor_ur: 'میکسوب ٹائلٹ رول', category: 'tissue_paper' },
      { name: 'Rose Petal', name_ur: 'روز پیٹل', flavor: 'Zzoop Kitchen Towel', flavor_ur: 'زوپ کچن تولیہ', category: 'tissue_paper' },
      { name: 'Rose Petal Napkins', name_ur: 'روز پیٹل نیپکن', category: 'tissue_paper' },
      { name: 'Rose Petal Pocket Tissue', name_ur: 'روز پیٹل پاکٹ ٹشو', category: 'tissue_paper' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════
  // Added against the "Village Portal Marketplace / Shop Portal" design
  // handoff's own brand list (SHOP_PORTAL_HANDOFF.md §2) to close the
  // real gaps it named that weren't in the batch above. Unlike that
  // original batch, these were NOT re-checked live against each brand's
  // own site tonight — they're well-known, long-standing Pakistani FMCG
  // brands filled in from general knowledge, same shape/convention as
  // everything above, but flagged here so that distinction stays honest
  // rather than silently blurred. Worth a live pass later the same way
  // the original batch got one.
  {
    slug: 'ismail_confectionery', name: 'Hilal / Super Crisp (Ismail Industries)', name_ur: 'ہلال / سپر کرسپ', icon: 'Candy',
    items: [
      { name: 'Hilal', name_ur: 'ہلال', flavor: 'Milk Candy', flavor_ur: 'دودھ ٹافی', category: 'confectionery' },
      { name: 'Hilal Toffee', name_ur: 'ہلال ٹافی', category: 'confectionery' },
      { name: 'Super Crisp', name_ur: 'سپر کرسپ', flavor: 'Salted', flavor_ur: 'نمکین', category: 'chips_nimko' },
      { name: 'Super Crisp', name_ur: 'سپر کرسپ', flavor: 'Chatpata', flavor_ur: 'چٹپٹا', category: 'chips_nimko' },
    ],
  },
  {
    slug: 'pakola', name: 'Pakola', name_ur: 'پاکولا', icon: 'CupSoda',
    items: sizedDrink('Pakola', 'پاکولا', 'beverages').filter((d) => d.flavor !== '2.25 Litre PET Bottle'),
  },
  {
    slug: 'shezan', name: 'Shezan', name_ur: 'شیزان', icon: 'CupSoda',
    items: [
      { name: 'Shezan', name_ur: 'شیزان', flavor: 'Mango Juice', flavor_ur: 'آم کا جوس', category: 'beverages' },
      { name: 'Shezan', name_ur: 'شیزان', flavor: 'Apple Juice', flavor_ur: 'سیب کا جوس', category: 'beverages' },
      { name: 'Shezan', name_ur: 'شیزان', flavor: 'Guava Nectar', flavor_ur: 'امرود کا جوس', category: 'beverages' },
      { name: 'Shezan Squash', name_ur: 'شیزان سکواش', flavor: 'Lemon', flavor_ur: 'لیموں', category: 'beverages' },
      { name: 'Shezan Jam', name_ur: 'شیزان جیم', flavor: 'Mixed Fruit', flavor_ur: 'مکس فروٹ', category: 'honey_jam_spreads' },
    ],
  },
  {
    slug: 'mehran', name: 'Mehran Foods', name_ur: 'مہران فوڈز', icon: 'Flame',
    items: [
      { name: 'Mehran', name_ur: 'مہران', flavor: 'Biryani Masala', flavor_ur: 'بریانی مصالحہ', category: 'spices_masala' },
      { name: 'Mehran', name_ur: 'مہران', flavor: 'Karahi Masala', flavor_ur: 'کڑاہی مصالحہ', category: 'spices_masala' },
      { name: 'Mehran', name_ur: 'مہران', flavor: 'Chicken Fry Masala', flavor_ur: 'چکن فرائی مصالحہ', category: 'spices_masala' },
      { name: 'Mehran Red Chilli Powder', name_ur: 'مہران لال مرچ پاؤڈر', category: 'spices_masala' },
      { name: 'Mehran Salt', name_ur: 'مہران نمک', category: 'sugar_salt' },
    ],
  },
  {
    slug: 'ahmed_foods', name: 'Ahmed Foods', name_ur: 'احمد فوڈز', icon: 'Flame',
    items: [
      { name: 'Ahmed', name_ur: 'احمد', flavor: 'Mango Pickle', flavor_ur: 'آم کا اچار', category: 'pickles_sauces' },
      { name: 'Ahmed', name_ur: 'احمد', flavor: 'Mixed Pickle', flavor_ur: 'مکس اچار', category: 'pickles_sauces' },
      { name: 'Ahmed Ketchup', name_ur: 'احمد کیچپ', category: 'pickles_sauces' },
      { name: 'Ahmed Chilli Garlic Sauce', name_ur: 'احمد چلی گارلک ساس', category: 'pickles_sauces' },
    ],
  },
  {
    slug: 'rafhan', name: 'Rafhan', name_ur: 'رفحان', icon: 'Milk',
    items: [
      { name: 'Rafhan', name_ur: 'رفحان', flavor: 'Custard Powder', flavor_ur: 'کسٹرڈ پاؤڈر', category: 'honey_jam_spreads' },
      { name: 'Rafhan Corn Flour', name_ur: 'رفحان کارن فلور', category: 'grains_pulses' },
      { name: 'Rafhan', name_ur: 'رفحان', flavor: 'Jelly', flavor_ur: 'جیلی', category: 'honey_jam_spreads' },
    ],
  },
  {
    slug: 'knorr', name: 'Knorr', name_ur: 'نار', icon: 'Soup',
    items: [
      { name: 'Knorr', name_ur: 'نار', flavor: 'Chicken Noodles', flavor_ur: 'چکن نوڈلز', category: 'noodles_pasta' },
      { name: 'Knorr Chicken Cubes', name_ur: 'نار چکن کیوبز', category: 'spices_masala' },
      { name: 'Knorr', name_ur: 'نار', flavor: 'Chicken Corn Soup', flavor_ur: 'چکن کارن سوپ', category: 'pickles_sauces' },
    ],
  },
  {
    slug: 'shangrila', name: 'Shangrila Foods', name_ur: 'شانگریلا فوڈز', icon: 'Flame',
    items: [
      { name: 'Shangrila', name_ur: 'شانگریلا', flavor: 'Biryani Masala', flavor_ur: 'بریانی مصالحہ', category: 'spices_masala' },
      { name: 'Shangrila', name_ur: 'شانگریلا', flavor: 'Mango Pickle', flavor_ur: 'آم کا اچار', category: 'pickles_sauces' },
      { name: 'Shangrila Squash', name_ur: 'شانگریلا سکواش', flavor: 'Lemon', flavor_ur: 'لیموں', category: 'beverages' },
    ],
  },
  {
    slug: 'mitchells', name: "Mitchell's", name_ur: 'مچلز', icon: 'Flame',
    items: [
      { name: "Mitchell's Jam", name_ur: 'مچلز جیم', flavor: 'Mixed Fruit', flavor_ur: 'مکس فروٹ', category: 'honey_jam_spreads' },
      { name: "Mitchell's", name_ur: 'مچلز', flavor: 'Mango Pickle', flavor_ur: 'آم کا اچار', category: 'pickles_sauces' },
      { name: "Mitchell's Tomato Ketchup", name_ur: 'مچلز ٹماٹر کیچپ', category: 'pickles_sauces' },
      { name: "Mitchell's Squash", name_ur: 'مچلز سکواش', flavor: 'Lemon', flavor_ur: 'لیموں', category: 'beverages' },
    ],
  },
  {
    slug: 'habib_oil', name: 'Habib Oil Mills', name_ur: 'حبیب آئل ملز', icon: 'Droplet',
    items: [
      { name: 'Habib Cooking Oil', name_ur: 'حبیب کوکنگ آئل', category: 'cooking_oil_ghee' },
      { name: 'Habib Banaspati Ghee', name_ur: 'حبیب بناسپتی گھی', category: 'cooking_oil_ghee' },
    ],
  },
  {
    slug: 'jj_baby', name: "Johnson's / Canbebe", name_ur: 'جانسنز / کنبیبی', icon: 'Baby',
    items: [
      { name: "Johnson's Baby Soap", name_ur: 'جانسنز بےبی صابن', category: 'diapers_wipes' },
      { name: "Johnson's Baby Shampoo", name_ur: 'جانسنز بےبی شیمپو', category: 'diapers_wipes' },
      { name: "Johnson's Baby Powder", name_ur: 'جانسنز بےبی پاؤڈر', category: 'diapers_wipes' },
      { name: 'Canbebe Diapers', name_ur: 'کنبیبی ڈائپرز', flavor: 'Medium', flavor_ur: 'میڈیم', category: 'diapers_wipes' },
      { name: 'Canbebe Diapers', name_ur: 'کنبیبی ڈائپرز', flavor: 'Large', flavor_ur: 'لارج', category: 'diapers_wipes' },
    ],
  },
]

export function getAllCatalogBrands(): CatalogBrand[] {
  return PRODUCT_CATALOG
}

// ═══════════════════════════════════════════════════════════════════
// Non-branded / loose goods — deliberately absent from this catalog
// until now. The Shop Portal design handoff calls these out as
// first-class, not an afterthought ("46 loose lines... sold by
// کلو/پاؤ/درجن/عدد/لیٹر/میٹر"), and that's a genuine gap: everything
// above is a real packaged brand SKU, but a village kiryana store's
// actual bulk goods (loose atta, loose tea, produce, meat) had no place
// in this data model at all. Modelled as its own type rather than
// forced into CatalogBrand/CatalogItem — a loose good has no brand, no
// flavor axis, and is priced by weight/unit rather than a fixed pack
// size, which is a genuinely different shape, not a variant of the
// branded one. `unit` is the sale unit a shopkeeper actually quotes at
// the counter (کلو/پاؤ/درجن/عدد/لیٹر), matching the handoff's own list.
export interface LooseGood {
  slug: string
  name: string
  name_ur: string
  unit: string
  unit_ur: string
  category: string
}

export const LOOSE_GOODS: LooseGood[] = [
  { slug: 'atta', name: 'Wheat Flour (Atta)', name_ur: 'آٹا', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'sugar', name: 'Sugar', name_ur: 'چینی', unit: 'kg', unit_ur: 'کلو', category: 'sugar_salt' },
  { slug: 'rice_loose', name: 'Rice (loose)', name_ur: 'چاول', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'daal_chana', name: 'Chana Daal', name_ur: 'چنے کی دال', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'daal_masoor', name: 'Masoor Daal', name_ur: 'مسور کی دال', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'daal_moong', name: 'Moong Daal', name_ur: 'مونگ کی دال', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'daal_mash', name: 'Mash Daal', name_ur: 'ماش کی دال', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'besan', name: 'Gram Flour (Besan)', name_ur: 'بیسن', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'suji', name: 'Semolina (Suji)', name_ur: 'سوجی', unit: 'kg', unit_ur: 'کلو', category: 'grains_pulses' },
  { slug: 'salt_loose', name: 'Salt (loose)', name_ur: 'نمک', unit: 'kg', unit_ur: 'کلو', category: 'sugar_salt' },
  { slug: 'gur', name: 'Jaggery (Gur)', name_ur: 'گڑ', unit: 'kg', unit_ur: 'کلو', category: 'sugar_salt' },
  { slug: 'tea_loose', name: 'Loose Tea', name_ur: 'کھلی چائے', unit: 'kg', unit_ur: 'کلو', category: 'tea_coffee' },
  { slug: 'spice_haldi', name: 'Turmeric (loose)', name_ur: 'ہلدی', unit: 'kg', unit_ur: 'کلو', category: 'spices_masala' },
  { slug: 'spice_mirch', name: 'Red Chilli Powder (loose)', name_ur: 'لال مرچ', unit: 'kg', unit_ur: 'کلو', category: 'spices_masala' },
  { slug: 'spice_dhania', name: 'Coriander Powder (loose)', name_ur: 'دھنیا پاؤڈر', unit: 'kg', unit_ur: 'کلو', category: 'spices_masala' },
  { slug: 'spice_zeera', name: 'Cumin (loose)', name_ur: 'زیرہ', unit: 'kg', unit_ur: 'کلو', category: 'spices_masala' },
  { slug: 'spice_garam_masala', name: 'Garam Masala (loose)', name_ur: 'گرم مصالحہ', unit: 'kg', unit_ur: 'کلو', category: 'spices_masala' },
  { slug: 'spice_kalonji', name: 'Kalonji (loose)', name_ur: 'کلونجی', unit: 'kg', unit_ur: 'کلو', category: 'spices_masala' },
  { slug: 'meat_chicken_live', name: 'Live Chicken', name_ur: 'زندہ مرغی', unit: 'kg', unit_ur: 'کلو', category: 'meat_poultry' },
  { slug: 'meat_chicken_cut', name: 'Chicken (cut/slaughtered)', name_ur: 'ذبح شدہ مرغی', unit: 'kg', unit_ur: 'کلو', category: 'meat_poultry' },
  { slug: 'meat_chicken_boneless', name: 'Boneless Chicken', name_ur: 'بون لیس چکن', unit: 'kg', unit_ur: 'کلو', category: 'meat_poultry' },
  { slug: 'meat_mutton', name: 'Mutton', name_ur: 'مٹن', unit: 'kg', unit_ur: 'کلو', category: 'meat_poultry' },
  { slug: 'meat_beef', name: 'Beef', name_ur: 'بیف', unit: 'kg', unit_ur: 'کلو', category: 'meat_poultry' },
  { slug: 'meat_qeema', name: 'Qeema (mince)', name_ur: 'قیمہ', unit: 'kg', unit_ur: 'کلو', category: 'meat_poultry' },
  { slug: 'meat_kaleji', name: 'Kaleji (liver)', name_ur: 'کلیجی', unit: 'kg', unit_ur: 'کلو', category: 'meat_poultry' },
  { slug: 'produce_eggs', name: 'Eggs', name_ur: 'انڈے', unit: 'dozen', unit_ur: 'درجن', category: 'fruits_vegetables' },
  { slug: 'produce_potato', name: 'Potato', name_ur: 'آلو', unit: 'kg', unit_ur: 'کلو', category: 'fruits_vegetables' },
  { slug: 'produce_onion', name: 'Onion', name_ur: 'پیاز', unit: 'kg', unit_ur: 'کلو', category: 'fruits_vegetables' },
  { slug: 'produce_tomato', name: 'Tomato', name_ur: 'ٹماٹر', unit: 'kg', unit_ur: 'کلو', category: 'fruits_vegetables' },
  { slug: 'produce_garlic', name: 'Garlic', name_ur: 'لہسن', unit: 'kg', unit_ur: 'کلو', category: 'fruits_vegetables' },
  { slug: 'produce_ginger', name: 'Ginger', name_ur: 'ادرک', unit: 'kg', unit_ur: 'کلو', category: 'fruits_vegetables' },
  { slug: 'produce_banana', name: 'Banana', name_ur: 'کیلا', unit: 'dozen', unit_ur: 'درجن', category: 'fruits_vegetables' },
  { slug: 'produce_apple', name: 'Apple', name_ur: 'سیب', unit: 'kg', unit_ur: 'کلو', category: 'fruits_vegetables' },
  { slug: 'home_broom', name: 'Broom', name_ur: 'جھاڑو', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_wiper', name: 'Floor Wiper', name_ur: 'وائپر', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_mop', name: 'Mop', name_ur: 'ایم او پی', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_bucket', name: 'Bucket', name_ur: 'بالٹی', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_tub', name: 'Wash Tub', name_ur: 'ٹب', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_scrub', name: 'Scrub Pad', name_ur: 'سکرب', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_matches', name: 'Matches', name_ur: 'ماچس', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_candles', name: 'Candles', name_ur: 'موم بتی', unit: 'piece', unit_ur: 'عدد', category: 'household' },
  { slug: 'home_rope', name: 'Rope', name_ur: 'رسی', unit: 'meter', unit_ur: 'میٹر', category: 'household' },
  { slug: 'gas_lpg_refill', name: 'LPG Cylinder Refill', name_ur: 'ایل پی جی ری فل', unit: 'kg', unit_ur: 'کلو', category: 'domestic_refill' },
  { slug: 'gas_empty_small', name: 'Empty Small Cylinder', name_ur: 'خالی چھوٹا سلنڈر', unit: 'piece', unit_ur: 'عدد', category: 'portable_cylinder' },
  { slug: 'kerosene', name: 'Kerosene Oil', name_ur: 'مٹی کا تیل', unit: 'litre', unit_ur: 'لیٹر', category: 'household' },
]
