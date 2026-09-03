// Pure logic for the shop catalog's "Add Stock" flow (BrandItemPicker +
// BulkPriceReview, both mounted by ShopCatalogSection) — no React here,
// so it's cheap to reason about and cheap to re-run on every keystroke of
// a search box.
//
// Built once at module load from PRODUCT_CATALOG (src/lib/productCatalog.ts)
// into a flat, indexed list — CategoryBrowser.tsx's old brand-drill walked
// PRODUCT_CATALOG's nested brand→items shape directly every render; this
// flattens it once so lookups, grouping and search are all just array/map
// ops over CATALOG_INDEX.

import { PRODUCT_CATALOG, LOOSE_GOODS, type CatalogItem, type LooseGood } from './productCatalog'
import { getShopTypeTree, type CategoryDepartment } from './shopTypes'

export interface CatalogEntry {
  key: string // stable identity for this catalog listing — see catalogKey()
  brandSlug: string
  brandName: string
  brandName_ur: string
  brandIcon: string
  item: CatalogItem
}

export function catalogKey(brandSlug: string, item: CatalogItem): string {
  return `${brandSlug}::${(item.name ?? '').trim().toLowerCase()}::${(item.flavor ?? '').trim().toLowerCase()}`
}

// A shop's own product only has name/flavor, no brand-slug column, so
// "is this catalog item already in my shop" has to match on name+flavor
// alone — same heuristic CategoryBrowser's old catalogSuggestions used.
export function ownedKey(name: string, flavor?: string | null): string {
  return `${(name ?? '').trim().toLowerCase()}::${(flavor ?? '').trim().toLowerCase()}`
}

export const CATALOG_INDEX: CatalogEntry[] = PRODUCT_CATALOG.flatMap((brand) =>
  brand.items.map((item) => ({
    key: catalogKey(brand.slug, item),
    brandSlug: brand.slug,
    brandName: brand.name,
    brandName_ur: brand.name_ur,
    brandIcon: brand.icon,
    item,
  }))
)

const CATALOG_BY_KEY: Map<string, CatalogEntry> = new Map(CATALOG_INDEX.map((e) => [e.key, e]))
export function getCatalogEntry(key: string): CatalogEntry | undefined {
  return CATALOG_BY_KEY.get(key)
}

// Only the catalog items that actually belong on this shop's own
// department/category tree — a barber shop never sees Lay's chips.
export function getCatalogForShopType(primaryType: string): CatalogEntry[] {
  const validSlugs = new Set(getShopTypeTree(primaryType).flatMap((d) => d.categories.map((c) => c.slug)))
  return CATALOG_INDEX.filter((e) => validSlugs.has(e.item.category))
}

export function groupByCategory(entries: CatalogEntry[]): Record<string, CatalogEntry[]> {
  const out: Record<string, CatalogEntry[]> = {}
  for (const e of entries) (out[e.item.category] ??= []).push(e)
  return out
}

export function groupByBrand(entries: CatalogEntry[]): { brandSlug: string; brandName: string; brandName_ur: string; brandIcon: string; entries: CatalogEntry[] }[] {
  const order: string[] = []
  const byBrand: Record<string, CatalogEntry[]> = {}
  for (const e of entries) {
    if (!byBrand[e.brandSlug]) { byBrand[e.brandSlug] = []; order.push(e.brandSlug) }
    byBrand[e.brandSlug].push(e)
  }
  return order.map((slug) => {
    const first = byBrand[slug][0]
    return { brandSlug: slug, brandName: first.brandName, brandName_ur: first.brandName_ur, brandIcon: first.brandIcon, entries: byBrand[slug] }
  })
}

// Brand-first entry point (see BrandItemPicker.tsx): every brand that has
// at least one item valid for this shop type, in the same order
// groupByBrand already produces — a barber shop or pharmacy with zero
// catalog coverage gets an empty array back, which the picker uses to
// hide the Brands tab outright rather than show an empty accordion.
export function brandsForShopType(primaryType: string): { brandSlug: string; brandName: string; brandName_ur: string; brandIcon: string; entries: CatalogEntry[] }[] {
  return groupByBrand(getCatalogForShopType(primaryType))
}

// One pass over the ticked rows -> how many are ticked per brand, so a
// brand accordion header's count doesn't re-scan the whole catalog once
// per brand on every render (that's O(brands × catalog) instead of
// O(selected)).
export function selectedCountByBrand(rows: { key: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const entry = CATALOG_BY_KEY.get(r.key)
    if (!entry) continue // a hand-added "custom" row has no brand slug
    out[entry.brandSlug] = (out[entry.brandSlug] ?? 0) + 1
  }
  return out
}

export function countByDept(tree: CategoryDepartment[], entries: CatalogEntry[]): Record<string, number> {
  const byCategory: Record<string, number> = {}
  for (const e of entries) byCategory[e.item.category] = (byCategory[e.item.category] ?? 0) + 1
  const out: Record<string, number> = {}
  for (const d of tree) out[d.key] = d.categories.reduce((sum, c) => sum + (byCategory[c.slug] ?? 0), 0)
  return out
}

// Strips apostrophes before matching — "lays" (how almost everyone
// actually types it) would otherwise miss "Lay's" entirely, since a
// straight substring match treats the apostrophe as a real character.
const stripApostrophes = (s: string) => s.replace(/['’]/g, '')

export function searchCatalogEntries(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const q = stripApostrophes(query.trim().toLowerCase())
  if (!q) return []
  return entries.filter((e) =>
    stripApostrophes(e.item.name.toLowerCase()).includes(q) || (e.item.name_ur ?? '').includes(q)
    || stripApostrophes((e.item.flavor ?? '').toLowerCase()).includes(q) || (e.item.flavor_ur ?? '').includes(q)
    || stripApostrophes(e.brandName.toLowerCase()).includes(q) || e.brandName_ur.includes(q)
  )
}

// "Add most things by default" — every catalog entry valid for this shop
// type except a short, explicit exclude-list of categories a keeper
// should decide on individually (needs a freezer, loose produce priced
// by weight at the mandi, not every store carries it). A per-item
// `starter?: boolean` on CatalogItem could refine this later without
// touching any component; deliberately category-level for now so it
// keeps working as brands/items get added to the catalog.
const STARTER_EXCLUDED_CATEGORIES: Record<string, string[]> = {
  general_store: ['fruits_vegetables', 'ice_cream', 'frozen', 'diapers_wipes', 'cosmetics_beauty', 'baby_food_feeding'],
}

export function starterSetEntries(primaryType: string): CatalogEntry[] {
  const excluded = new Set(STARTER_EXCLUDED_CATEGORIES[primaryType] ?? [])
  return getCatalogForShopType(primaryType).filter((e) => !excluded.has(e.item.category))
}

// Loose goods have no brand/flavor axis (see LooseGood in productCatalog.ts)
// — rather than teach useCatalogSelection/BulkPriceReview/the commit
// pipeline in ShopCatalogSection a second row shape, each loose good is
// wrapped as a CatalogEntry with a synthetic "loose" brand ("بغیر برانڈ /
// کھلا سامان", per the design handoff's own wording) and no flavor. Same
// key format as catalogKey() (`loose::${slug}::`) so it stays distinct
// from every real branded key, and the whole tick → price → commit flow
// downstream works completely unchanged — it never has to know a row
// came from a loose good instead of a real brand.
const LOOSE_BRAND_NAME = 'Unbranded / Loose Goods'
const LOOSE_BRAND_NAME_UR = 'بغیر برانڈ / کھلا سامان'

export function looseGoodsForShopType(primaryType: string): LooseGood[] {
  const validSlugs = new Set(getShopTypeTree(primaryType).flatMap((d) => d.categories.map((c) => c.slug)))
  return LOOSE_GOODS.filter((g) => validSlugs.has(g.category))
}

export function looseGoodsAsCatalogEntries(primaryType: string): CatalogEntry[] {
  // The unit (کلو/درجن/عدد/لیٹر/میٹر) rides in the existing flavor field
  // rather than a new shop_products column — a loose good's "flavor" is
  // meaningless anyway, and this slot already renders next to the name
  // everywhere a product shows up, so "آٹا (کلو)" falls out for free.
  return looseGoodsForShopType(primaryType).map((g) => ({
    key: `loose::${g.slug}::`,
    brandSlug: 'loose', brandName: LOOSE_BRAND_NAME, brandName_ur: LOOSE_BRAND_NAME_UR, brandIcon: 'Scale',
    item: { name: g.name, name_ur: g.name_ur, category: g.category, flavor: g.unit, flavor_ur: g.unit_ur },
  }))
}

export function getLooseGood(slug: string): LooseGood | undefined {
  return LOOSE_GOODS.find((g) => g.slug === slug)
}

export function roundTo(value: number, nearest: number): number {
  if (!nearest || nearest <= 0) return Math.round(value)
  return Math.round(value / nearest) * nearest
}
