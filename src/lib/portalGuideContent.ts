// Portal "how to use" instructional copy — softcoded the same way the
// homepage welfare cards were (migration 307 → welfareCardContent.ts).
// Two blocks live here:
//
// 1. The sponsorship-pool guide (the "How this works — please read before
//    you join" six-question panel). Kafalat, Wazifa and Esal-e-Sawab portal
//    pages all render the exact same guide — it's one shared feature
//    (giving into a pool with no name attached), not three separate ones —
//    so it's fetched once via usePoolGuideContent() rather than duplicated.
// 2. The Zakat portal page's own "why you don't pick a recipient / who it
//    reaches" explanation, which has no pool mechanic and so isn't shared
//    with the other three.
//
// Migration 308 seeds every key below with the current messages.ts wording.

export const POOL_GUIDE_ITEMS = ['what', 'amount', 'when', 'stop', 'short', 'privacy'] as const
export type PoolGuideItem = typeof POOL_GUIDE_ITEMS[number]

// The five fields for one guide question — also used by the Settings page
// to build one collapsible group per question, rather than one 30-field wall.
export function poolItemFields(item: PoolGuideItem): string[] {
  return [
    `pool_how_${item}_q_en`, `pool_how_${item}_q_ur`,
    // Always shown in Urdu regardless of the visitor's language — same
    // "headline_ur" idea as the welfare cards' mottoUr field.
    `pool_how_${item}_urdu_line`,
    `pool_how_${item}_answer_en`, `pool_how_${item}_answer_ur`,
  ]
}

export const POOL_GUIDE_INTRO_KEYS = ['pool_how_title_en', 'pool_how_title_ur', 'pool_promise_urdu_line', 'pool_promise_en', 'pool_promise_ur']

export function poolGuideKeys(): string[] {
  return [...POOL_GUIDE_INTRO_KEYS, ...POOL_GUIDE_ITEMS.flatMap(poolItemFields)]
}

export const ZAKAT_GUIDE_KEYS = [
  'pzk_blurb_en', 'pzk_blurb_ur',
  // Both of these are fixed — always Urdu, always English respectively,
  // shown together as a pair regardless of which language is selected
  // (the original pzk.whyUrdu/pzk.whyEnglish keys held identical text in
  // both language tables, which is what made that fixed-ness visible).
  'pzk_why_urdu_line', 'pzk_why_english_line',
  'pzk_who_it_reaches_en', 'pzk_who_it_reaches_ur',
  'pzk_who_it_reaches_help_en', 'pzk_who_it_reaches_help_ur',
]
