// A "pick from a real brand's product line" quick-add catalog for shop
// keepers — the third way to add a product, alongside typing one in by
// hand and the AI camera scan. Tap a brand, tap the item/flavor, and the
// Add Product form opens pre-filled with name/company/flavor/category;
// the keeper still sets their own buying/selling price and stock (this
// system has no way to know those, and shouldn't guess) and can still
// attach their own photo the normal way.
//
// Two honest limits, on purpose:
// - This is a strong starting set of the major, real, genuinely
//   well-known brands a Pakistani general/kiryana store actually stocks
//   (LU/Continental, National, Shan, Tapal, Unilever, P&G, Reckitt,
//   Colgate, Mayfair, Nestlé, Engro/Olpers, Haleeb, Coca-Cola, PepsiCo,
//   Hamdard) — not a claim of exhaustive coverage of every company in
//   the country. Adding more brands later is just appending to this
//   array, no architecture change.
// - No product photos are bundled here — there's no image-sourcing
//   pipeline in this app, and a fabricated "real photo" would be worse
//   than none. Every catalog item renders with its category's icon
//   (matching CategoryBrowser) until/unless the keeper attaches their
//   own real photo, exactly like a manually-typed product does today.

export interface CatalogItem {
  name: string
  name_ur?: string
  flavor?: string
  flavor_ur?: string
  category: string
}
export interface CatalogBrand {
  slug: string
  name: string
  name_ur: string
  icon: string
  items: CatalogItem[]
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
    slug: 'national', name: 'National Foods', name_ur: 'نیشنل فوڈز', icon: 'Flame',
    items: [
      { name: 'National', flavor: 'Chana Masala', category: 'spices_masala' },
      { name: 'National', flavor: 'Biryani Masala', category: 'spices_masala' },
      { name: 'National', flavor: 'Karahi Masala', category: 'spices_masala' },
      { name: 'National', flavor: 'Achar Gosht Masala', category: 'spices_masala' },
      { name: 'National', flavor: 'Tikka Masala', category: 'spices_masala' },
      { name: 'National Red Chilli Powder', category: 'spices_masala' },
      { name: 'National Turmeric Powder', category: 'spices_masala' },
      { name: 'National Tomato Ketchup', category: 'other' },
      { name: 'National Vinegar', category: 'other' },
    ],
  },
  {
    slug: 'shan', name: 'Shan Foods', name_ur: 'شان فوڈز', icon: 'Flame',
    items: [
      { name: 'Shan', flavor: 'Biryani Masala', category: 'spices_masala' },
      { name: 'Shan', flavor: 'Bombay Biryani Masala', category: 'spices_masala' },
      { name: 'Shan', flavor: 'Karahi Masala', category: 'spices_masala' },
      { name: 'Shan', flavor: 'Nihari Masala', category: 'spices_masala' },
      { name: 'Shan', flavor: 'Kabab Masala', category: 'spices_masala' },
      { name: 'Shan', flavor: 'Chana Masala', category: 'spices_masala' },
      { name: 'Shan', flavor: 'Haleem Mix', category: 'spices_masala' },
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
      { name: 'Surf Excel', flavor: 'Bar', category: 'household' },
      { name: 'Surf Excel', flavor: 'Powder', category: 'household' },
      { name: 'Wheel Detergent Powder', category: 'household' },
      { name: 'Vim Dishwash Bar', category: 'household' },
      { name: 'Vim Dishwash Liquid', category: 'household' },
    ],
  },
  {
    slug: 'pg', name: 'P&G', name_ur: 'پی اینڈ جی', icon: 'SprayCan',
    items: [
      { name: 'Ariel Powder', category: 'household' },
      { name: 'Bonus Detergent', category: 'household' },
      { name: 'Head & Shoulders Shampoo', category: 'personal_care' },
      { name: 'Pantene Shampoo', category: 'personal_care' },
      { name: 'Safeguard Soap', category: 'personal_care' },
    ],
  },
  {
    slug: 'reckitt', name: 'Reckitt Benckiser', name_ur: 'ریکٹ بینکائزر', icon: 'SprayCan',
    items: [
      { name: 'Dettol', flavor: 'Antiseptic Liquid', category: 'personal_care' },
      { name: 'Dettol Soap', category: 'personal_care' },
      { name: 'Dettol Handwash', category: 'personal_care' },
      { name: 'Harpic Toilet Cleaner', category: 'household' },
      { name: 'Vanish Fabric Stain Remover', category: 'household' },
      { name: 'Mortein Insect Spray', category: 'household' },
      { name: 'Genie Fabric Softener', category: 'household' },
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
    slug: 'mayfair', name: 'Mayfair', name_ur: 'میفیئر', icon: 'Layers',
    items: [
      { name: 'Mayfair Facial Tissue', category: 'household' },
      { name: 'Mayfair Toilet Roll', category: 'household' },
      { name: 'Mayfair Paper Napkin', category: 'household' },
      { name: 'Mayfair Kitchen Roll', category: 'household' },
    ],
  },
  {
    slug: 'engro', name: 'Engro Foods', name_ur: 'اینگرو فوڈز', icon: 'Milk',
    items: [
      { name: 'Olpers Milk', category: 'dairy_eggs' },
      { name: 'Olwell Milk', category: 'dairy_eggs' },
      { name: 'Tarang', flavor: 'Tea Whitener', category: 'dairy_eggs' },
      { name: 'Omore Ice Cream', category: 'frozen' },
    ],
  },
  {
    slug: 'nestle', name: 'Nestlé Pakistan', name_ur: 'نیسلے پاکستان', icon: 'Milk',
    items: [
      { name: 'Nestlé Milkpak', category: 'dairy_eggs' },
      { name: 'Nestlé Everyday', flavor: 'Tea Whitener', category: 'dairy_eggs' },
      { name: 'Nestlé Nesvita', category: 'dairy_eggs' },
      { name: 'Nestlé Fruita Vitals Juice', category: 'beverages' },
      { name: 'Nescafé Classic', category: 'tea_coffee' },
      { name: 'Maggi Noodles', category: 'other' },
    ],
  },
  {
    slug: 'haleeb', name: 'Haleeb Foods', name_ur: 'حلیب فوڈز', icon: 'Milk',
    items: [
      { name: 'Haleeb Milk', category: 'dairy_eggs' },
      { name: 'Haleeb Cream', category: 'dairy_eggs' },
    ],
  },
  {
    slug: 'cocacola', name: 'Coca-Cola', name_ur: 'کوکا کولا', icon: 'CupSoda',
    items: [
      { name: 'Coca-Cola', category: 'beverages' },
      { name: 'Sprite', category: 'beverages' },
      { name: 'Fanta', category: 'beverages' },
    ],
  },
  {
    slug: 'pepsico', name: 'PepsiCo', name_ur: 'پیپسی کو', icon: 'CupSoda',
    items: [
      { name: 'Pepsi', category: 'beverages' },
      { name: '7Up', category: 'beverages' },
      { name: 'Mirinda', category: 'beverages' },
      { name: 'Sting Energy Drink', category: 'beverages' },
      { name: 'Lay\'s Chips', flavor: 'Salted', category: 'biscuits_snacks' },
      { name: 'Lay\'s Chips', flavor: 'Masala', category: 'biscuits_snacks' },
      { name: 'Kurkure', flavor: 'Masala Munch', category: 'biscuits_snacks' },
    ],
  },
  {
    slug: 'hamdard', name: 'Hamdard', name_ur: 'ہمدرد', icon: 'FlaskConical',
    items: [
      { name: 'Rooh Afza Syrup', category: 'beverages' },
    ],
  },
]

export function getAllCatalogBrands(): CatalogBrand[] {
  return PRODUCT_CATALOG
}
