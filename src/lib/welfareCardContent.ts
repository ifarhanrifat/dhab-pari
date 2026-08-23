// The four homepage welfare cards' copy (Zakat, Kafalat, Taleemi Wazifa,
// Esal-e-Sawab) lives in site_settings as of migration 307 — editable from
// Settings, not a code deploy. This is the one place both the homepage
// (which reads it) and the Settings page (which lets an admin edit it)
// agree on which keys exist, so the two never drift out of sync.

export const WELFARE_CARD_KEYS = ['zakat', 'kafalat', 'wazifa', 'esal'] as const
export type WelfareCardKey = typeof WELFARE_CARD_KEYS[number]

// Order here is display order in both the homepage card and the Settings
// form.
export const WELFARE_CARD_FIELDS = [
  'tab_en', 'tab_ur',
  'headline_ur',
  'motto_en', 'motto_ur',
  'body_en', 'body_ur',
  'how_en', 'how_ur',
  'cta_en', 'cta_ur',
  'stat1_en', 'stat1_ur',
  'stat2_en', 'stat2_ur',
] as const

export function welfareCardContentKeys(): string[] {
  return WELFARE_CARD_KEYS.flatMap((card) => WELFARE_CARD_FIELDS.map((f) => `${card}_${f}`))
}
