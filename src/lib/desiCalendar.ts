// Hijri and Punjabi (Bikrami/Desi) calendar display — for the homepage
// header's date strip, not for religious rulings (fasting/prayer times
// need actual moon-sighting or a proper fiqh-council source, not this).

// Real report, 2026-10-01: the Hijri date wasn't reliably showing on the
// Android app (Capacitor's WebView ICU data doesn't consistently ship the
// islamic-umalqura calendar the way a desktop browser does, so Intl threw
// or silently fell back). Replaced with a deterministic tabular Hijri
// conversion (the widely-used "Kuwaiti algorithm") that needs no calendar
// data at all — verified against known reference points (1 Muharram 1447
// = 27 June 2025; 1 Jan 2000 fell in Ramadan 1420), both correct. Typically
// within a day of the real Umm al-Qura sighting-based calendar, which is
// fine for display — same non-ruling disclaimer as the file header.
const HIJRI_MONTHS_EN = [
  'Muharram', "Safar", "Rabi' al-Awwal", "Rabi' al-Thani", 'Jumada al-Awwal', 'Jumada al-Thani',
  'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qi'dah", 'Dhu al-Hijjah',
]
const HIJRI_MONTHS_UR = ['محرم', 'صفر', 'ربیع الاول', 'ربیع الثانی', 'جمادی الاول', 'جمادی الثانی', 'رجب', 'شعبان', 'رمضان', 'شوال', 'ذوالقعدہ', 'ذوالحجہ']
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAYS_UR = ['اتوار', 'پیر', 'منگل', 'بدھ', 'جمعرات', 'جمعہ', 'ہفتہ']

function gregorianToJDN(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12)
  const y2 = y + 4800 - a
  const m2 = m + 12 * a - 3
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4) - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045
}

function jdnToHijri(jdn: number): { year: number; month: number; day: number } {
  const l0 = jdn - 1948440 + 10632
  const n = Math.floor((l0 - 1) / 10631)
  let l = l0 - 10631 * n + 354
  const j = Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) + Math.floor(l / 5670) * Math.floor((43 * l) / 15238)
  l = l - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29
  const month = Math.floor((24 * l) / 709)
  const day = l - Math.floor((709 * month) / 24)
  const year = 30 * n + j - 30
  return { year, month, day }
}

export function formatHijri(date: Date, isUrdu: boolean, withWeekday = false): string {
  const { year, month, day } = jdnToHijri(gregorianToJDN(date.getFullYear(), date.getMonth() + 1, date.getDate()))
  const monthName = (isUrdu ? HIJRI_MONTHS_UR : HIJRI_MONTHS_EN)[month - 1] ?? ''
  const weekday = withWeekday ? `${(isUrdu ? WEEKDAYS_UR : WEEKDAYS_EN)[date.getDay()]} ` : ''
  return isUrdu ? `${weekday}${day} ${monthName} ${year}ھ` : `${weekday}${day} ${monthName} ${year} AH`
}

// Punjabi solar (Bikrami) calendar — 12 months, each starting on a roughly
// fixed Gregorian date (drifts by at most a day across leap years, same
// approximation printed on any Punjabi wall calendar). Day-of-month here is
// just days-since-month-start + 1 — the plain solar count these calendars
// show, not the lunar tithi the religious calendar tracks separately.
// Restored, 2026-10-01: "why you have removed the Punjabi date... restore
// that date, I have asked you to remove only the kable maseh date" — the
// removal was a misread of which of the two lines on the date card was
// meant; this one (Assu/Katak/Harh/Poh etc.) stays.
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
