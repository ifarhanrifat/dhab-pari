// Shared "Today / This Week / This Month / 3 Months / 6 Months / Custom"
// date-range presets — used by the Filter Transaction sheet on both All
// Transactions and the Transactions Workspace's Recent Transactions list,
// so picking "This Month" means the same thing (and the same Monday-start
// week) in both places.

export type DateRangePreset = 'today' | 'week' | 'month' | '3m' | '6m' | 'custom'

// Pakistan is a fixed UTC+5, no DST. Every voucher_date/donor date in the
// database is stamped via (now() AT TIME ZONE 'Asia/Karachi')::date — but
// this file used to compute "today" from the raw UTC instant. Those agree
// most of the day, but for the ~5 hours after local midnight (UTC is still
// "yesterday" until 5am PKT) the two disagreed: the database would already
// have posted a voucher under today's PKT date while this file's `to`
// still pointed at yesterday, silently dropping same-day activity off the
// end of "This Month". Working off a PKT-shifted instant — and reading it
// back out through the UTC getters/setters below, so the browser's own
// ambient local timezone (which might not even be PKT) never gets applied
// a second time on top — keeps this file in agreement with the database
// regardless of what timezone the admin's own device happens to be set to.
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000
function pktNow() { return new Date(Date.now() + PKT_OFFSET_MS) }

export const today = () => toStr(pktNow())

function toStr(d: Date) {
  return d.toISOString().slice(0, 10)
}

function startOfWeek(d: Date) {
  // Monday-start, matching the work week this app's billing/reminders
  // already run on. d is already PKT-shifted — UTC getters/setters read
  // and write that shifted instant directly, instead of letting the
  // browser's own local timezone reinterpret it.
  const day = d.getUTCDay() // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() + diff)
  return monday
}

export const monthStart = () => { const d = pktNow(); d.setUTCDate(1); return toStr(d) }

function monthsAgo(n: number) {
  const d = pktNow()
  d.setUTCMonth(d.getUTCMonth() - n)
  return toStr(d)
}

/** {from, to} for a given preset key, `to` always today except for a
 *  deliberately-picked custom range (handled by the caller, not here). */
export function presetRange(key: Exclude<DateRangePreset, 'custom'>): { from: string; to: string } {
  const t = today()
  switch (key) {
    case 'today': return { from: t, to: t }
    case 'week': return { from: toStr(startOfWeek(pktNow())), to: t }
    case 'month': return { from: monthStart(), to: t }
    case '3m': return { from: monthsAgo(3), to: t }
    case '6m': return { from: monthsAgo(6), to: t }
  }
}

/** Given a {from, to} pair, which preset (if any) it currently matches —
 *  so the sheet can highlight the right pill after a manual date edit, or
 *  fall back to "Custom" when it matches none of them. */
export function detectPreset(from: string, to: string): DateRangePreset {
  if (to !== today()) return 'custom'
  for (const key of ['today', 'week', 'month', '3m', '6m'] as const) {
    if (presetRange(key).from === from) return key
  }
  return 'custom'
}

export function presetLabelKey(key: DateRangePreset): string {
  return {
    today: 'fr.today', week: 'fr.thisWeek', month: 'tx.thisMonth',
    '3m': 'fr.months3', '6m': 'fr.months6', custom: 'fr.custom',
  }[key]
}

export const PRESET_ORDER: DateRangePreset[] = ['today', 'week', 'month', '3m', '6m', 'custom']

/** "01 Aug '26 – 22 Aug '26" — the compact label shown on the filter
 *  trigger button itself, so the active range is visible without opening
 *  the sheet. */
export function formatRangeLabel(from: string, to: string): string {
  const fmt = (s: string) => {
    const d = new Date(s)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ (\d{2})$/, " '$1")
  }
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`
}
