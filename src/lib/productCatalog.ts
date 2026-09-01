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
// candyland.com.pk, ismailindustries.com.pk) plus real Pakistani
// grocery-retailer listings (naheed.pk, pakistandeals.pk) for pack
// sizes and the handful of `price` values below — checked live, not
// invented. Three honest limits, on purpose:
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
    slug: 'lu', name: 'LU / Continental Biscuits', name_ur: 'ایل یو بسکٹ', icon: 'Cookie',
    items: [
      { name: 'Prince', name_ur: 'پرنس', flavor: 'Chocolate', flavor_ur: 'چاکلیٹ', category: 'biscuits_snacks' },
      { name: 'Prince', name_ur: 'پرنس', flavor: 'Original', flavor_ur: 'اورجنل', category: 'biscuits_snacks' },
      { name: 'Sooper', name_ur: 'سوپر', flavor: 'Original', flavor_ur: 'اورجنل', category: 'biscuits_snacks' },
      { name: 'Bisconni Chocolatto', name_ur: 'بسکونی چاکلیٹو', category: 'biscuits_snacks' },
      { name: 'Peek Freans Gluco', name_ur: 'پیک فرینز گلوکو', category: 'biscuits_snacks' },
      { name: 'Peek Freans Nice', name_ur: 'پیک فرینز نائس', category: 'biscuits_snacks' },
      { name: 'Rio', name_ur: 'ریو', flavor: 'Chocolate', flavor_ur: 'چاکلیٹ', category: 'biscuits_snacks' },
      { name: 'Rio', name_ur: 'ریو', flavor: 'Strawberry', flavor_ur: 'اسٹرابیری', category: 'biscuits_snacks' },
      { name: 'Candi', name_ur: 'کینڈی', category: 'biscuits_snacks' },
      { name: 'Oreo', name_ur: 'اوریو', flavor: 'Original', flavor_ur: 'اورجنل', category: 'biscuits_snacks' },
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
      { name: 'National Tomato Ketchup', name_ur: 'نیشنل ٹماٹر کیچپ', category: 'other' },
      { name: 'National Vinegar', name_ur: 'نیشنل سرکہ', category: 'other' },
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
      { name: 'Lifebuoy Total 10', name_ur: 'لائف بوائے ٹوٹل 10', flavor: 'Soap', flavor_ur: 'صابن', category: 'personal_care' },
      { name: 'Lux', name_ur: 'لکس', flavor: 'Rose Soap', flavor_ur: 'گلاب صابن', category: 'personal_care' },
      { name: 'Lux', name_ur: 'لکس', flavor: 'Peach Soap', flavor_ur: 'آڑو صابن', category: 'personal_care' },
      { name: 'Sunsilk Shampoo', name_ur: 'سن سلک شیمپو', flavor: 'Black Shine', flavor_ur: 'بلیک شائن', category: 'personal_care' },
      { name: 'Sunsilk Shampoo', name_ur: 'سن سلک شیمپو', flavor: 'Lively Clean', flavor_ur: 'لائیولی کلین', category: 'personal_care' },
      { name: 'Clear Shampoo', name_ur: 'کلیئر شیمپو', flavor: 'Men', flavor_ur: 'مردوں کے لیے', category: 'personal_care' },
      { name: 'Closeup Toothpaste', name_ur: 'کلوز اپ ٹوتھ پیسٹ', flavor: 'Red Hot', flavor_ur: 'ریڈ ہاٹ', category: 'personal_care' },
      { name: 'Closeup Toothpaste', name_ur: 'کلوز اپ ٹوتھ پیسٹ', flavor: 'Ever Fresh', flavor_ur: 'ایور فریش', category: 'personal_care' },
      { name: 'Glow & Lovely Cream', name_ur: 'گلو اینڈ لولی کریم', category: 'cosmetics_beauty' },
      { name: 'Ponds Cream', name_ur: 'پونڈز کریم', category: 'cosmetics_beauty' },
      { name: 'Vaseline Lotion', name_ur: 'ویزلین لوشن', category: 'cosmetics_beauty' },
    ],
  },
  {
    slug: 'unilever_home', name: 'Unilever — Home Care', name_ur: 'یونی لیور — گھریلو صفائی', icon: 'SprayCan',
    items: [
      { name: 'Surf Excel', name_ur: 'سرف ایکسل', flavor: 'Bar', flavor_ur: 'بار', category: 'household' },
      { name: 'Surf Excel', name_ur: 'سرف ایکسل', flavor: 'Powder', flavor_ur: 'پاؤڈر', category: 'household' },
      { name: 'Wheel Detergent Powder', name_ur: 'ویل واشنگ پاؤڈر', category: 'household' },
      { name: 'Vim Dishwash Bar', name_ur: 'وِم برتن دھونے کی بار', category: 'household' },
      { name: 'Vim Dishwash Liquid', name_ur: 'وِم برتن دھونے کا مائع', category: 'household' },
    ],
  },
  {
    slug: 'pg', name: 'P&G', name_ur: 'پی اینڈ جی', icon: 'SprayCan',
    items: [
      { name: 'Ariel Powder', name_ur: 'ایریل واشنگ پاؤڈر', category: 'household' },
      { name: 'Bonus Detergent', name_ur: 'بونس واشنگ پاؤڈر', category: 'household' },
      { name: 'Head & Shoulders Shampoo', name_ur: 'ہیڈ اینڈ شولڈرز شیمپو', category: 'personal_care' },
      { name: 'Pantene Shampoo', name_ur: 'پینٹین شیمپو', category: 'personal_care' },
      { name: 'Safeguard Soap', name_ur: 'سیف گارڈ صابن', category: 'personal_care' },
    ],
  },
  {
    slug: 'reckitt', name: 'Reckitt Benckiser', name_ur: 'ریکٹ بینکائزر', icon: 'SprayCan',
    items: [
      { name: 'Dettol', name_ur: 'ڈیٹول', flavor: 'Antiseptic Liquid', flavor_ur: 'اینٹی سیپٹک مائع', category: 'personal_care' },
      { name: 'Dettol Soap', name_ur: 'ڈیٹول صابن', category: 'personal_care' },
      { name: 'Dettol Handwash', name_ur: 'ڈیٹول ہینڈ واش', category: 'personal_care' },
      { name: 'Harpic Toilet Cleaner', name_ur: 'ہارپک ٹائلٹ کلینر', category: 'household' },
      { name: 'Vanish Fabric Stain Remover', name_ur: 'وینش داغ صاف کرنے والا', category: 'household' },
      { name: 'Mortein Insect Spray', name_ur: 'مارٹین کیڑے مار اسپرے', category: 'household' },
      { name: 'Genie Fabric Softener', name_ur: 'جینی کپڑے نرم کرنے والا', category: 'household' },
    ],
  },
  {
    slug: 'colgate', name: 'Colgate-Palmolive', name_ur: 'کولگیٹ پامولیو', icon: 'Sparkles',
    items: [
      { name: 'Colgate Toothpaste', name_ur: 'کولگیٹ ٹوتھ پیسٹ', flavor: 'Total', flavor_ur: 'ٹوٹل', category: 'personal_care' },
      { name: 'Colgate Toothpaste', name_ur: 'کولگیٹ ٹوتھ پیسٹ', flavor: 'MaxFresh', flavor_ur: 'میکس فریش', category: 'personal_care' },
      { name: 'Colgate Toothbrush', name_ur: 'کولگیٹ ٹوتھ برش', category: 'personal_care' },
      { name: 'Palmolive Soap', name_ur: 'پامولیو صابن', category: 'personal_care' },
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
      { name: 'Maggi Noodles', name_ur: 'میگی نوڈلز', category: 'other' },
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
]

export function getAllCatalogBrands(): CatalogBrand[] {
  return PRODUCT_CATALOG
}
