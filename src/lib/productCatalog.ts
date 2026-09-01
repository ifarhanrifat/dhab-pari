// A "pick from a real brand's product line" quick-add catalog for shop
// keepers — the third way to add a product, alongside typing one in by
// hand and the AI camera scan. Tap a brand, tap the item/flavor/size,
// and the Add Product form opens pre-filled with name/company/flavor/
// category (and a selling-price suggestion where one is actually
// sourced — see `price` below); the keeper still confirms/adjusts the
// price and sets stock, and can still attach their own photo the normal
// way.
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
//   only — the keeper's own cost/selling price always wins.
// - This is a strong starting set of the major, real, genuinely
//   well-known brands a Pakistani general/kiryana store actually stocks
//   — not a claim of exhaustive coverage of every company or every pack
//   size in the country. Adding more is just appending to this array.
// - No product photos are bundled — there's no image-sourcing pipeline
//   in this app to source and license real branded photography at this
//   scale. Every catalog item renders with its category's icon
//   (matching CategoryBrowser) until the keeper attaches their own real
//   photo, exactly like a manually-typed product does today.
//
// Urdu: brand/product proper nouns stay in Roman script (name_ur/
// flavor_ur omitted) — that's how they're printed on the real packaging
// and how Pakistani shop-keeper apps already show them. Generic,
// non-brand descriptive terms (a recipe masala's own name, a cleaning
// product's plain description) get a real Urdu label wherever one
// naturally exists.

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
const COLA_SIZES = ['250ml Glass Bottle', '345ml Can', '500ml PET Bottle', '1 Litre PET Bottle', '1.5 Litre PET Bottle', '2.25 Litre PET Bottle']

function sizedDrink(name: string, category = 'beverages'): CatalogItem[] {
  return COLA_SIZES.map((size) => ({ name, flavor: size, category }))
}

export const PRODUCT_CATALOG: CatalogBrand[] = [
  {
    slug: 'lu', name: 'LU / Continental Biscuits', name_ur: 'ایل یو بسکٹ', icon: 'Cookie',
    items: [
      { name: 'Prince', flavor: 'Chocolate', category: 'biscuits_snacks' },
      { name: 'Prince', flavor: 'Original', category: 'biscuits_snacks' },
      { name: 'Sooper', flavor: 'Original', category: 'biscuits_snacks' },
      { name: 'Bisconni Chocolatto', category: 'biscuits_snacks' },
      { name: 'Peek Freans Gluco', category: 'biscuits_snacks' },
      { name: 'Peek Freans Nice', category: 'biscuits_snacks' },
      { name: 'Rio', flavor: 'Chocolate', category: 'biscuits_snacks' },
      { name: 'Rio', flavor: 'Strawberry', category: 'biscuits_snacks' },
      { name: 'Candi', category: 'biscuits_snacks' },
      { name: 'Oreo', flavor: 'Original', category: 'biscuits_snacks' },
    ],
  },
  {
    slug: 'mayfair', name: 'Mayfair Foods', name_ur: 'میفیئر فوڈز', icon: 'Candy',
    items: [
      // Confectionery — mayfairfood.com/pk/brand/confectionery
      { name: 'Frooto', flavor: 'Mango', category: 'confectionery' },
      { name: 'Frooto', flavor: 'Amrood', category: 'confectionery' },
      { name: 'Frooto', flavor: 'Peach', category: 'confectionery' },
      { name: 'Frooto', flavor: 'Coconut', category: 'confectionery' },
      { name: 'Frooto', flavor: 'Lemon', category: 'confectionery' },
      { name: 'Chaska', flavor: 'Green Mango', category: 'confectionery' },
      { name: 'Chaska', flavor: 'Amrood', category: 'confectionery' },
      { name: 'Chaska', flavor: 'Orange', category: 'confectionery' },
      { name: 'Milko Toffee', category: 'confectionery' },
      { name: 'Fruit Gala', flavor: 'Blackcurrant', category: 'confectionery' },
      { name: 'Fruit Gala', flavor: 'Strawberry', category: 'confectionery' },
      { name: 'Fruit Gala', flavor: 'Green Apple', category: 'confectionery' },
      { name: 'Fruit Gala', flavor: 'Orange', category: 'confectionery' },
      { name: 'Mayfair Eclairs', category: 'confectionery' },
      { name: 'Raging Sours', category: 'confectionery' },
      { name: 'Creamers', flavor: 'Banana & Crème', category: 'confectionery' },
      { name: 'Creamers', flavor: 'Strawberry & Crème', category: 'confectionery' },
      { name: 'Wobbly Jellies', flavor: 'Strawberry', category: 'confectionery' },
      { name: 'Mayfair Bubble', category: 'confectionery' },
      // Biscuits — mayfairfood.com/pk/brand/biscuits
      { name: 'Cremo', flavor: 'Chocolate', category: 'biscuits_snacks' },
      { name: 'Cremo', flavor: 'Strawberry', category: 'biscuits_snacks' },
      { name: 'Mayfair Special', flavor: 'Classic', category: 'biscuits_snacks' },
      { name: 'Mayfair Special', flavor: 'Chocolate', category: 'biscuits_snacks' },
      { name: 'Café', category: 'biscuits_snacks' },
      { name: 'Besto', category: 'biscuits_snacks' },
      { name: 'Energi', category: 'biscuits_snacks' },
      { name: 'Wow', category: 'biscuits_snacks' },
      { name: 'A1', category: 'biscuits_snacks' },
      { name: 'Chocday', category: 'biscuits_snacks' },
      // Baked — mayfairfood.com/pk/brand/baked
      { name: 'Mayfair Hearts', category: 'bakery' },
      { name: 'Mayfair Croissant', flavor: 'Chocolate Filled', category: 'bakery' },
    ],
  },
  {
    slug: 'candyland', name: 'Candyland', name_ur: 'کینڈی لینڈ', icon: 'Candy',
    items: [
      { name: 'Chili Mili', category: 'confectionery' },
      { name: 'ABC Jelly', category: 'confectionery' },
      { name: 'Cola Premium Jelly', category: 'confectionery' },
      { name: 'Bottle Jelly', category: 'confectionery' },
      { name: 'Fizzy-O Jelly', category: 'confectionery' },
      { name: 'Fanty', category: 'confectionery' },
      { name: 'Corona Mango', category: 'confectionery' },
      { name: 'Funny Bunny', flavor: 'Lollipop', category: 'confectionery' },
      { name: 'Puffs Marshmallow', category: 'confectionery' },
      { name: 'Super Twister', category: 'confectionery' },
      { name: 'Mello Marshmallow', flavor: 'Chocolate', category: 'confectionery' },
      { name: 'Yums', category: 'confectionery' },
      { name: 'Bisca Chocolate', category: 'confectionery' },
      { name: 'Rush Chocolate', category: 'confectionery' },
      { name: 'Cosmo Chocolate', category: 'confectionery' },
      { name: 'Novella Chocolate', category: 'confectionery' },
      { name: 'Bubble Pop Gum', category: 'confectionery' },
      { name: 'Butter Scotch Candy', category: 'confectionery' },
      { name: 'Pebbles', category: 'confectionery' },
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
      { name: 'Tapal Danedar', category: 'tea_coffee' },
      { name: 'Tapal Family Mixture', category: 'tea_coffee' },
      { name: 'Tapal Mezban', category: 'tea_coffee' },
      { name: 'Tapal Green Tea', category: 'tea_coffee' },
    ],
  },
  {
    slug: 'lipton', name: 'Lipton', name_ur: 'لپٹن', icon: 'Coffee',
    items: [
      { name: 'Lipton Yellow Label', category: 'tea_coffee' },
    ],
  },
  {
    slug: 'unilever_personal', name: 'Unilever — Personal Care', name_ur: 'یونی لیور — ذاتی نگہداشت', icon: 'Sparkles',
    items: [
      { name: 'Lifebuoy Total 10', flavor: 'Soap', category: 'personal_care' },
      { name: 'Lux', flavor: 'Rose Soap', category: 'personal_care' },
      { name: 'Lux', flavor: 'Peach Soap', category: 'personal_care' },
      { name: 'Sunsilk Shampoo', flavor: 'Black Shine', category: 'personal_care' },
      { name: 'Sunsilk Shampoo', flavor: 'Lively Clean', category: 'personal_care' },
      { name: 'Clear Shampoo', flavor: 'Men', category: 'personal_care' },
      { name: 'Closeup Toothpaste', flavor: 'Red Hot', category: 'personal_care' },
      { name: 'Closeup Toothpaste', flavor: 'Ever Fresh', category: 'personal_care' },
      { name: 'Glow & Lovely Cream', category: 'cosmetics_beauty' },
      { name: 'Ponds Cream', category: 'cosmetics_beauty' },
      { name: 'Vaseline Lotion', category: 'cosmetics_beauty' },
    ],
  },
  {
    slug: 'unilever_home', name: 'Unilever — Home Care', name_ur: 'یونی لیور — گھریلو صفائی', icon: 'SprayCan',
    items: [
      { name: 'Surf Excel', name_ur: 'سرف ایکسل', flavor: 'Bar', category: 'household' },
      { name: 'Surf Excel', name_ur: 'سرف ایکسل', flavor: 'Powder', category: 'household' },
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
      { name: 'Head & Shoulders Shampoo', category: 'personal_care' },
      { name: 'Pantene Shampoo', category: 'personal_care' },
      { name: 'Safeguard Soap', category: 'personal_care' },
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
      { name: 'Colgate Toothpaste', flavor: 'Total', category: 'personal_care' },
      { name: 'Colgate Toothpaste', flavor: 'MaxFresh', category: 'personal_care' },
      { name: 'Colgate Toothbrush', category: 'personal_care' },
      { name: 'Palmolive Soap', category: 'personal_care' },
    ],
  },
  {
    slug: 'engro', name: 'Engro Foods', name_ur: 'اینگرو فوڈز', icon: 'Milk',
    items: [
      { name: 'Olpers Milk', name_ur: 'اولپرز دودھ', category: 'dairy_eggs' },
      { name: 'Olwell Milk', name_ur: 'اولویل دودھ', category: 'dairy_eggs' },
      { name: 'Tarang', flavor: 'Tea Whitener', flavor_ur: 'چائے وائٹنر', category: 'dairy_eggs' },
      { name: 'Omore Ice Cream', name_ur: 'اومور آئس کریم', category: 'frozen' },
    ],
  },
  {
    slug: 'nestle', name: 'Nestlé Pakistan', name_ur: 'نیسلے پاکستان', icon: 'Milk',
    items: [
      { name: 'Nestlé Milkpak', name_ur: 'نیسلے ملک پیک', category: 'dairy_eggs' },
      { name: 'Nestlé Everyday', flavor: 'Tea Whitener', flavor_ur: 'چائے وائٹنر', category: 'dairy_eggs' },
      { name: 'Nestlé Nesvita', category: 'dairy_eggs' },
      { name: 'Nestlé Fruita Vitals Juice', category: 'beverages' },
      { name: 'Nescafé Classic', category: 'tea_coffee' },
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
      ...sizedDrink('Coca-Cola'),
      ...sizedDrink('Sprite'),
      ...sizedDrink('Fanta'),
    ],
  },
  {
    slug: 'pepsico', name: 'PepsiCo', name_ur: 'پیپسی کو', icon: 'CupSoda',
    items: [
      // Real per-size prices checked live tonight (pakistandeals.pk) —
      // every other size here is a real, sold SKU but without a
      // separately-verified price, so it starts blank like the rest of
      // the catalog rather than guess one.
      { name: 'Pepsi', flavor: '250ml Glass Bottle', category: 'beverages' },
      { name: 'Pepsi', flavor: '345ml Can', category: 'beverages' },
      { name: 'Pepsi', flavor: '500ml PET Bottle', category: 'beverages', price: 99 },
      { name: 'Pepsi', flavor: '1 Litre PET Bottle', category: 'beverages' },
      { name: 'Pepsi', flavor: '1.5 Litre PET Bottle', category: 'beverages', price: 150 },
      { name: 'Pepsi', flavor: '2.25 Litre PET Bottle', category: 'beverages' },
      { name: 'Pepsi Diet', flavor: '1.5 Litre PET Bottle', category: 'beverages' },
      ...sizedDrink('7Up'),
      ...sizedDrink('Mirinda'),
      { name: 'Sting Energy Drink', category: 'beverages' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Classic Salted, 20g', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Classic Salted, 80g', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Masala, 21g', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Masala, 30g', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Chilli, 14g', category: 'biscuits_snacks' },
      { name: "Lay's", name_ur: 'لیز', flavor: 'Paprika, 24g', category: 'biscuits_snacks' },
      { name: 'Kurkure', flavor: 'Masala Munch', category: 'biscuits_snacks' },
      { name: 'Kurkure', flavor: 'Chutney Chaska', category: 'biscuits_snacks' },
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
