// The admin-side "How this works" operational guides — Kafalat, Wazifa and
// Esal-e-Sawab each have their own (Zakat's admin page has no such panel).
// Unlike the portal's sponsorship-pool guide (portalGuideContent.ts), these
// three are NOT shared with each other — each explains that module's own
// workflow to whoever is running it (the donor accountant, a committee
// member), so each gets its own key namespace and its own Settings group.
//
// Migration 309 seeds every key below with the current messages.ts wording.

export const ADMIN_GUIDE_SECTIONS = {
  kf: ['sponsor_or_share', 'measuring', 'collections', 'operations', 'fees', 'reverify', 'record'],
  wz: ['applications', 'awards', 'loans', 'collections'],
  es: ['proposals', 'upkeep', 'collections', 'catalogue'],
} as const

export type AdminGuideModule = keyof typeof ADMIN_GUIDE_SECTIONS

export function adminGuideSectionFields(mod: AdminGuideModule, section: string): string[] {
  return [`${mod}_guide_${section}_title_en`, `${mod}_guide_${section}_title_ur`, `${mod}_guide_${section}_body_en`, `${mod}_guide_${section}_body_ur`]
}

export function adminGuideToggleKeys(mod: AdminGuideModule): string[] {
  return [`${mod}_guide_toggle_en`, `${mod}_guide_toggle_ur`]
}

export function adminGuideKeys(mod: AdminGuideModule): string[] {
  return [...adminGuideToggleKeys(mod), ...ADMIN_GUIDE_SECTIONS[mod].flatMap((s) => adminGuideSectionFields(mod, s))]
}
