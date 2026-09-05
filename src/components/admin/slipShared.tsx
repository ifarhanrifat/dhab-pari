// Primitives shared by every printable document — the ten legacy skins in
// ReceiptDocument.tsx and the Universal Slip. Extracted so number formatting,
// bidi handling and the wa.me link rule have exactly one definition; a receipt
// that formats money differently from a bill is how reconciliation disputes
// start.
import { normalizePakPhone } from '@/lib/receiptExport'

// Paisa are printed only when there are paisa. A committee that bills in whole
// rupees was getting "750.00" on every line of every document — two characters
// of noise per figure on a 48mm roll, and a decimal point the reader has to
// check before trusting the number. A real amount keeps its decimals.
//
// Deliberately all-or-nothing per figure rather than minimumFractionDigits: 0,
// which would print 750.5 for seven hundred fifty rupees fifty paisa. Money is
// written with both paisa digits or with none; one is a typo. The decision is
// made on the value *as it will be shown* (rounded to two places first), so a
// float carrying 750.000000001 from a sum reads as 750 rather than 750.00.
export function fmt(n: number) {
  const rounded = Math.round(Number(n) * 100) / 100
  const wholeRupees = Number.isInteger(rounded)
  return rounded.toLocaleString(undefined, {
    minimumFractionDigits: wholeRupees ? 0 : 2,
    maximumFractionDigits: 2,
  })
}

export function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB')
}

// Phone numbers, emails and URLs are logically left-to-right even inside an
// Urdu (RTL) paragraph. Without an explicit embedding the browser moves a
// leading "+" to the visual end — "+923333022794" renders as "923333022794+".
// inline-block keeps the embedding intact through html2canvas rasterization,
// which is how these documents get exported.
export function Ltr({ children, className = '', style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <span dir="ltr" className={className} style={{ unicodeBidi: 'embed', display: 'inline-block', ...style }}>
      {children}
    </span>
  )
}

// A committee phone number is only useful if it dials. Every number printed in
// a footer becomes a wa.me link so tapping it opens WhatsApp directly.
export function waHref(raw: string): string | null {
  const intl = normalizePakPhone(raw)
  return intl ? `https://wa.me/${intl}` : null
}

// Settings stores helpline/complaint numbers as free text, which in practice
// means "one number" or "two numbers separated by a comma/slash". Split so each
// one gets its own tappable link instead of the whole string becoming one
// unusable href.
export function splitNumbers(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(/[,،/|]+/).map((s) => s.trim()).filter(Boolean)
}

// Which way a block of admin-typed free text should read. Narrations on this
// system are usually Urdu but not always ("Monthly water bill", a supplier's
// name), and a paragraph laid out against its own script puts the label that
// introduces it at the end of the reader's line instead of the start.
// First strong character decides, the same rule dir="auto" uses — leading
// digits and punctuation are skipped so "60000 الگ جمع…" still counts as Urdu.
const RTL_FIRST_STRONG = /^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}]/u
export function isRtlText(s: string | null | undefined): boolean {
  return !!s && RTL_FIRST_STRONG.test(s)
}

export function prettyUrl(href: string): string {
  return href.replace(/^mailto:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}

export function PhoneLink({ number, className = '', style }: { number: string; className?: string; style?: React.CSSProperties }) {
  const href = waHref(number)
  const body = <Ltr className={className} style={style}>{number}</Ltr>
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-dp-secondary">{body}</a> : body
}
