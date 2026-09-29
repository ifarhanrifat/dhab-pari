// Hijri and Punjabi (Bikrami/Desi) calendar display — for the homepage
// header's date strip, not for religious rulings (fasting/prayer times
// need actual moon-sighting or a proper fiqh-council source, not this).

// Hijri: the JS Intl Islamic (Umm al-Qura) calendar ships in every modern
// browser already — no library needed. -nu-latn forces Western digits, the
// same convention every number on this site already follows (see ltr-num).
export function formatHijri(date: Date, isUrdu: boolean): string {
  try {
    return new Intl.DateTimeFormat(
      isUrdu ? 'ur-u-ca-islamic-umalqura-nu-latn' : 'en-u-ca-islamic-umalqura-nu-latn',
      { day: 'numeric', month: 'long', year: 'numeric' }
    ).format(date)
  } catch {
    return ''
  }
}

// Punjabi solar (Bikrami) calendar — 12 months, each starting on a roughly
// fixed Gregorian date (drifts by at most a day across leap years, same
// approximation printed on any Punjabi wall calendar). Day-of-month here is
// just days-since-month-start + 1 — the plain solar count these calendars
// show, not the lunar tithi the religious calendar tracks separately.
const PUNJABI_MONTHS_UR = ['چیت', 'وساکھ', 'جیٹھ', 'ہاڑ', 'ساون', 'بھادوں', 'اسو', 'کاتک', 'مگھر', 'پوہ', 'ماگھ', 'پھاگن']
const PUNJABI_MONTHS_EN = ['Chet', 'Vaisakh', 'Jeth', 'Harh', 'Sawan', 'Bhadon', 'Assu', 'Katak', 'Maghar', 'Poh', 'Magh', 'Phagan']
// [gregorian month (0=Jan), day] each Punjabi month starts on. Index 10
// (Magh) and 11 (Phagan) fall in the Gregorian year AFTER the one Chet (0)
// starts in — the Punjabi year runs mid-March to mid-February.
const STARTS: [number, number][] = [
  [2, 14], [3, 14], [4, 15], [5, 15], [6, 16], [7, 16],
  [8, 16], [9, 16], [10, 15], [11, 15], [0, 13], [1, 12],
]

export function formatPunjabi(date: Date, isUrdu: boolean): string {
  const names = isUrdu ? PUNJABI_MONTHS_UR : PUNJABI_MONTHS_EN
  const y = date.getFullYear()
  // Build every month-start for the Punjabi years straddling `date` (last
  // Gregorian year's and this one's) so the mid-March-to-mid-February wrap
  // is just "find the latest boundary at or before today" — no special
  // casing for December/January.
  const starts: { at: Date; monthIdx: number }[] = []
  for (const baseY of [y - 1, y]) {
    STARTS.forEach(([m, d], i) => {
      starts.push({ at: new Date(baseY + (i >= 10 ? 1 : 0), m, d), monthIdx: i })
    })
  }
  starts.sort((a, b) => a.at.getTime() - b.at.getTime())
  let current = starts[0]
  for (const s of starts) {
    if (s.at.getTime() <= date.getTime()) current = s
    else break
  }
  const dayNum = Math.floor((date.getTime() - current.at.getTime()) / 86400000) + 1
  return `${dayNum} ${names[current.monthIdx]}`
}
