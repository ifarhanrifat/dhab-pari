// The marketplace's product category taxonomy — shared by the AI scan
// prompt (server), the admin/keeper product forms (optgroup dropdowns),
// and the customer-facing department → category browse page, so all four
// stay in sync with the shop_products_category_check constraint
// (migration 398) in exactly one place.
//
// Modeled on what a real Pakistani general/kiryana store actually
// stocks — not a generic e-commerce taxonomy — grouped into departments
// for the browse UI, i18n label per category lives at sk.category.<code>
// in messages.ts, department label at cm.dept<Key>.
export const CATEGORY_DEPARTMENTS: { key: string; tKey: string; categories: string[] }[] = [
  {
    key: 'food', tKey: 'cm.deptFood',
    categories: ['grains_pulses', 'cooking_oil_ghee', 'spices_masala', 'sugar_salt', 'tea_coffee',
      'biscuits_snacks', 'confectionery', 'beverages', 'dairy_eggs', 'bakery', 'frozen',
      'fruits_vegetables', 'meat_poultry'],
  },
  {
    key: 'household', tKey: 'cm.deptHousehold',
    categories: ['personal_care', 'cosmetics_beauty', 'household', 'kitchenware', 'cigarettes_paan', 'stationery'],
  },
  { key: 'baby_kids', tKey: 'cm.deptBabyKids', categories: ['baby_care', 'toys'] },
  { key: 'health', tKey: 'cm.deptHealth', categories: ['health_medicine'] },
  { key: 'electronics', tKey: 'cm.deptElectronics', categories: ['electric_hardware'] },
  { key: 'other', tKey: 'cm.deptOther', categories: ['other'] },
]

export const PRODUCT_CATEGORIES: string[] = CATEGORY_DEPARTMENTS.flatMap((d) => d.categories)
