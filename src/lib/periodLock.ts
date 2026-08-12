import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A browser-side mirror of `period_is_locked()` from migration 204.
 *
 * The database is the authority — every write goes through triggers that refuse
 * a closed month regardless of what the screen believes. This exists so a
 * screen can grey a button out and say why, rather than letting an accountant
 * fill in a form, press Save, and only then be told the month closed a week
 * ago. Getting this wrong in the optimistic direction is harmless (the server
 * still refuses); getting it wrong in the pessimistic direction only greys out
 * a button that would have worked.
 */
export interface PeriodLockRule {
  enabled: boolean
  graceDays: number
}

export const DEFAULT_PERIOD_LOCK: PeriodLockRule = { enabled: true, graceDays: 10 }

export async function fetchPeriodLockRule(
  supabase: SupabaseClient,
): Promise<PeriodLockRule> {
  const { data } = await supabase
    .from('site_settings')
    .select('key, value')
    .in('key', ['period_lock_enabled', 'period_lock_grace_days'])
  const map = Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value as string]))
  const grace = Number.parseInt(map.period_lock_grace_days ?? '', 10)
  return {
    enabled: (map.period_lock_enabled ?? 'true') === 'true',
    graceDays: Number.isFinite(grace) ? grace : DEFAULT_PERIOD_LOCK.graceDays,
  }
}

/**
 * Today in Pakistan, as YYYY-MM-DD.
 *
 * The server runs on UTC, where the 1st of a month is still the 31st of the
 * previous one for five hours — long enough to close a month a day early for
 * anyone working in the evening.
 */
function todayInPakistan(): { year: number; month: number; day: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number)
  return { year: y, month: m, day: d }
}

/** Months are 1-12, matching `bills.month` and the database function. */
export function periodIsLocked(
  year: number,
  month: number,
  rule: PeriodLockRule = DEFAULT_PERIOD_LOCK,
): boolean {
  if (!rule.enabled) return false
  const today = todayInPakistan()

  // Everything before the 1st of the current month is closed — except during
  // the grace window, when the previous month is still open so the books can be
  // finished after the month itself has ended.
  let cutoffYear = today.year
  let cutoffMonth = today.month
  if (today.day <= rule.graceDays) {
    cutoffMonth -= 1
    if (cutoffMonth === 0) { cutoffMonth = 12; cutoffYear -= 1 }
  }

  return year < cutoffYear || (year === cutoffYear && month < cutoffMonth)
}

export function dateIsLocked(date: string | Date, rule: PeriodLockRule = DEFAULT_PERIOD_LOCK): boolean {
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return false
  return periodIsLocked(d.getFullYear(), d.getMonth() + 1, rule)
}
