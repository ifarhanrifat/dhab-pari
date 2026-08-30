import type { SupabaseClient } from '@supabase/supabase-js'
import type { PickerItem } from '@/components/admin/SearchablePicker'
import { messages, type Locale } from '@/lib/i18n/messages'

// Shared by /portal/donate and /donate/submit — one categorised,
// "amount still needed" picker instead of a flat project <select> or a
// literal "General Fund" option. A selected item's id is prefixed so a
// single picker value can point at either a project or a restricted fund
// (donors.fund_type, migration 209) without two separate form fields.
const PROJECT_ID_PREFIX = 'project:'
const FUND_ID_PREFIX = 'fund:'

export function encodeProjectTarget(projectId: string) { return `${PROJECT_ID_PREFIX}${projectId}` }

export function parseDonationTargetId(value: string): { projectId: string | null; fundType: string } {
  if (value.startsWith(FUND_ID_PREFIX)) return { projectId: null, fundType: value.slice(FUND_ID_PREFIX.length) }
  if (value.startsWith(PROJECT_ID_PREFIX)) return { projectId: value.slice(PROJECT_ID_PREFIX.length), fundType: 'general' }
  return { projectId: null, fundType: 'general' }
}

// Same collapse used on the category filter row elsewhere — infrastructure/
// water/environment/welfare/other all read as one general "Projects" bucket
// to a donor picking where their money goes; health/education/training/
// sports carry enough of their own identity to deserve their own heading.
const PROJECT_GROUP_KEY: Record<string, string> = {
  infrastructure: 'dt.groupProjects', water: 'dt.groupProjects', environment: 'dt.groupProjects',
  welfare: 'dt.groupProjects', other: 'dt.groupProjects',
  health: 'dt.groupMedical', education: 'dt.groupEducation',
  training: 'dt.groupTraining', sports: 'dt.groupSports',
}
const GROUP_ORDER = ['dt.groupProjects', 'dt.groupMedical', 'dt.groupEducation', 'dt.groupTraining', 'dt.groupSports']

const FUND_TYPES = ['zakat', 'ushr', 'sadqa', 'kafalat', 'esal_e_sawab'] as const
const FUND_LABEL_KEY: Record<string, string> = {
  zakat: 'dt.fundZakat', ushr: 'dt.fundUshr', sadqa: 'dt.fundSadqa', kafalat: 'dt.fundKafalat', esal_e_sawab: 'dt.fundEsalESawab',
}

function fmtPkr(n: number) {
  return Math.round(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

interface ProjectRow {
  id: string; title: string; display_name: string | null; category: string | null
  budget_pkr: number | null; funding_model: string | null; monthly_operating_cost_pkr: number | null
  is_committee_main: boolean
}

export async function fetchDonationTargets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>, locale: Locale
): Promise<{ items: PickerItem[]; defaultTargetId: string }> {
  // Looked up straight from the dictionary rather than taking a t()
  // callback — /donate/submit (public, unauthenticated) resolves its own
  // language from site_settings ahead of the shared LocaleProvider ever
  // settling, so its picker needs to follow that same local choice, not
  // whatever the global provider (which can briefly disagree, or default
  // English for a signed-out visitor) happens to say.
  const t = (key: string) => messages[locale][key] ?? messages.en[key] ?? key
  // Same "still needs donors" filter the plain <select> always used — a
  // finished one-time build doesn't need more money, a recurring_support
  // one (a trainer's salary, a running cost) always does.
  const { data: rows } = await supabase.from('projects')
    .select('id, title, display_name, category, budget_pkr, funding_model, monthly_operating_cost_pkr, is_committee_main')
    .or('funding_model.eq.recurring_support,and(status.neq.completed,status.neq.upcoming)')
    .order('title')

  const projects = (rows ?? []) as ProjectRow[]
  const ids = projects.map((p) => p.id)
  const received: Record<string, number> = {}
  if (ids.length > 0) {
    const { data: donationRows } = await supabase.from('donors_public').select('project_id, amount_pkr').eq('is_verified', true).in('project_id', ids)
    for (const d of (donationRows ?? []) as { project_id: string; amount_pkr: number }[]) {
      received[d.project_id] = (received[d.project_id] ?? 0) + Number(d.amount_pkr)
    }
  }

  const items: PickerItem[] = []
  const committeeMain = projects.find((p) => p.is_committee_main)
  if (committeeMain) {
    items.push({ id: encodeProjectTarget(committeeMain.id), label: committeeMain.display_name || committeeMain.title, group: t('dt.groupCommitteeMain') })
  }

  const amountFor = (p: ProjectRow): string | undefined => {
    if (p.funding_model === 'recurring_support' && p.monthly_operating_cost_pkr) {
      return `${fmtPkr(p.monthly_operating_cost_pkr)}${t('dt.perMonthNeeded')}`
    }
    if (p.budget_pkr) {
      const remaining = Math.max(0, Number(p.budget_pkr) - (received[p.id] ?? 0))
      if (remaining > 0) return `${fmtPkr(remaining)} ${t('dt.amountNeeded')}`
    }
    return undefined
  }

  // Built group-by-group (not in whatever order the alphabetised query
  // happened to return) so the headings always come out in a fixed,
  // predictable order regardless of which project titles start with what.
  for (const groupKey of GROUP_ORDER) {
    for (const p of projects) {
      if (p.is_committee_main) continue
      if ((PROJECT_GROUP_KEY[p.category ?? 'other'] ?? 'dt.groupProjects') !== groupKey) continue
      items.push({ id: encodeProjectTarget(p.id), label: p.display_name || p.title, sublabel: amountFor(p), group: t(groupKey) })
    }
  }

  for (const f of FUND_TYPES) {
    items.push({ id: `${FUND_ID_PREFIX}${f}`, label: t(FUND_LABEL_KEY[f]), group: t('dt.groupFunds') })
  }

  return { items, defaultTargetId: committeeMain ? encodeProjectTarget(committeeMain.id) : '' }
}
