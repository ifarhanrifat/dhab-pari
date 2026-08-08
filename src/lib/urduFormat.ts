// Small Urdu-digit/date/time formatting helpers, split out of the old
// MeetingNoticeDocument (PNG notice) so the meeting-notice feature can keep
// using them for its now-text-only WhatsApp message.

const MONTH_UR = [
  'جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون',
  'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر',
]
const DIGIT_UR = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']
export const toUrduDigits = (n: string | number) => String(n).replace(/[0-9]/g, (d) => DIGIT_UR[+d])

// meeting_date is a plain date (YYYY-MM-DD) — parse manually rather than
// via `new Date()` to avoid any UTC-offset day-shift.
export function formatUrduDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return `${toUrduDigits(d)} ${MONTH_UR[m - 1]} ${toUrduDigits(y)}`
}
// meeting_time is a plain time (HH:MM[:SS]) from a Postgres `time` column.
export function formatUrduTime(time: string): string {
  const [hStr, mStr] = time.split(':')
  let h = Number(hStr)
  const suffix = h >= 12 ? 'شام' : 'صبح'
  h = h % 12 || 12
  return `${toUrduDigits(h)}:${mStr} ${suffix}`
}
