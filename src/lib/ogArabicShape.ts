// Satori (the renderer behind next/og, used for every opengraph-image.tsx
// route) draws text exactly as given — no HarfHuzz, no OpenType shaping, no
// Unicode Bidi Algorithm. A plain Urdu string comes out as disconnected
// isolated letters in logical (left-to-right) order instead of properly
// joined letters read right-to-left, which is what the earlier "assumed
// Latin-script" comment on projects/[id]/opengraph-image.tsx was avoiding
// rather than fixing. This module does both steps by hand: pick each
// letter's correct isolated/initial/medial/final presentation-form glyph
// (Unicode Arabic Presentation Forms A/B), then reverse the shaped sequence
// so Satori's left-to-right draw order reads correctly for a right-to-left
// script. Only correct for a string that's ENTIRELY Urdu/Arabic script (no
// embedded Latin words or digits) — exactly the case for a project title,
// which callers should already be routing through the Urdu-only field
// before this ever runs.
//
// Joining-class data verified against Unicode's standard Arabic
// Presentation Forms-B block (the core Arabic alphabet, U+FE70-FEFF) plus
// the Arabic Presentation Forms-A extensions Urdu itself needs
// (پ چ ک گ ی already at U+FB56-FB95 for the "Farsi" letterforms Urdu uses
// instead of their bare Arabic equivalents; ٹ ڈ ڑ ں ھ ے are Urdu-only
// retroflex/aspirate letters with no Arabic equivalent at all, mapped from
// the same Presentation Forms-A block).
type Forms = { iso: number; init?: number; med?: number; fin?: number }

const SHAPE_TABLE: Record<number, Forms> = {
  0x0621: { iso: 0xfe80 }, // HAMZA (isolated only — never joins)
  0x0622: { iso: 0xfe81, fin: 0xfe82 }, // ALEF MADDA
  0x0623: { iso: 0xfe83, fin: 0xfe84 }, // ALEF HAMZA ABOVE
  0x0624: { iso: 0xfe85, fin: 0xfe86 }, // WAW HAMZA
  0x0625: { iso: 0xfe87, fin: 0xfe88 }, // ALEF HAMZA BELOW
  0x0626: { iso: 0xfe89, init: 0xfe8b, med: 0xfe8c, fin: 0xfe8a }, // YEH HAMZA
  0x0627: { iso: 0xfe8d, fin: 0xfe8e }, // ALEF
  0x0628: { iso: 0xfe8f, init: 0xfe91, med: 0xfe92, fin: 0xfe90 }, // BEH
  0x0629: { iso: 0xfe93, fin: 0xfe94 }, // TEH MARBUTA
  0x062a: { iso: 0xfe95, init: 0xfe97, med: 0xfe98, fin: 0xfe96 }, // TEH
  0x062b: { iso: 0xfe99, init: 0xfe9b, med: 0xfe9c, fin: 0xfe9a }, // THEH
  0x062c: { iso: 0xfe9d, init: 0xfe9f, med: 0xfea0, fin: 0xfe9e }, // JEEM
  0x062d: { iso: 0xfea1, init: 0xfea3, med: 0xfea4, fin: 0xfea2 }, // HAH
  0x062e: { iso: 0xfea5, init: 0xfea7, med: 0xfea8, fin: 0xfea6 }, // KHAH
  0x062f: { iso: 0xfea9, fin: 0xfeaa }, // DAL
  0x0630: { iso: 0xfeab, fin: 0xfeac }, // THAL
  0x0631: { iso: 0xfead, fin: 0xfeae }, // REH
  0x0632: { iso: 0xfeaf, fin: 0xfeb0 }, // ZAIN
  0x0633: { iso: 0xfeb1, init: 0xfeb3, med: 0xfeb4, fin: 0xfeb2 }, // SEEN
  0x0634: { iso: 0xfeb5, init: 0xfeb7, med: 0xfeb8, fin: 0xfeb6 }, // SHEEN
  0x0635: { iso: 0xfeb9, init: 0xfebb, med: 0xfebc, fin: 0xfeba }, // SAD
  0x0636: { iso: 0xfebd, init: 0xfebf, med: 0xfec0, fin: 0xfebe }, // DAD
  0x0637: { iso: 0xfec1, init: 0xfec3, med: 0xfec4, fin: 0xfec2 }, // TAH
  0x0638: { iso: 0xfec5, init: 0xfec7, med: 0xfec8, fin: 0xfec6 }, // ZAH
  0x0639: { iso: 0xfec9, init: 0xfecb, med: 0xfecc, fin: 0xfeca }, // AIN
  0x063a: { iso: 0xfecd, init: 0xfecf, med: 0xfed0, fin: 0xfece }, // GHAIN
  0x0641: { iso: 0xfed1, init: 0xfed3, med: 0xfed4, fin: 0xfed2 }, // FEH
  0x0642: { iso: 0xfed5, init: 0xfed7, med: 0xfed8, fin: 0xfed6 }, // QAF
  0x0643: { iso: 0xfed9, init: 0xfedb, med: 0xfedc, fin: 0xfeda }, // KAF (bare Arabic form)
  0x0644: { iso: 0xfedd, init: 0xfedf, med: 0xfee0, fin: 0xfede }, // LAM
  0x0645: { iso: 0xfee1, init: 0xfee3, med: 0xfee4, fin: 0xfee2 }, // MEEM
  0x0646: { iso: 0xfee5, init: 0xfee7, med: 0xfee8, fin: 0xfee6 }, // NOON
  0x0647: { iso: 0xfee9, init: 0xfeeb, med: 0xfeec, fin: 0xfeea }, // HEH
  0x0648: { iso: 0xfeed, fin: 0xfeee }, // WAW
  0x0649: { iso: 0xfeef, fin: 0xfef0 }, // ALEF MAKSURA
  0x064a: { iso: 0xfef1, init: 0xfef3, med: 0xfef4, fin: 0xfef2 }, // YEH (bare Arabic form)
  // Urdu-preferred letterforms (Arabic Presentation Forms-A)
  0x067e: { iso: 0xfb56, init: 0xfb58, med: 0xfb59, fin: 0xfb57 }, // PEH پ
  0x0686: { iso: 0xfb7a, init: 0xfb7c, med: 0xfb7d, fin: 0xfb7b }, // TCHEH چ
  0x06a9: { iso: 0xfb8e, init: 0xfb90, med: 0xfb91, fin: 0xfb8f }, // KEHEH ک (Urdu's kaf)
  0x06af: { iso: 0xfb92, init: 0xfb94, med: 0xfb95, fin: 0xfb93 }, // GAF گ
  0x06cc: { iso: 0xfbfc, init: 0xfbff, med: 0xfbfd, fin: 0xfbfe }, // YEH (Urdu/Farsi form) ی
  // Urdu-only retroflex/aspirate letters, no Arabic equivalent
  0x0679: { iso: 0xfb66, init: 0xfb68, med: 0xfb69, fin: 0xfb67 }, // TTEH ٹ
  0x0688: { iso: 0xfb88, fin: 0xfb89 }, // DDAL ڈ
  0x0691: { iso: 0xfb8c, fin: 0xfb8d }, // RREH ڑ
  0x06ba: { iso: 0xfb9e, fin: 0xfb9f }, // NOON GHUNNA ں
  0x06be: { iso: 0xfbaa, init: 0xfbac, med: 0xfbad, fin: 0xfbab }, // HEH DOACHASHMEE ھ
  0x06d2: { iso: 0xfbae, fin: 0xfbaf }, // YEH BARREE ے
}

// Combining diacritics (zabar/zer/pesh, hamza marks, etc.) don't break a
// joining chain — a letter followed only by one of these should still look
// for the NEXT real letter to decide whether it needs a medial/initial
// form. Rare in real project titles, but cheap to get right.
const TRANSPARENT = new Set([
  0x064b, 0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651, 0x0652, 0x0653,
  0x0654, 0x0655, 0x0656, 0x0657, 0x0670,
])

function joinsNext(cp: number): boolean {
  const f = SHAPE_TABLE[cp]
  return !!f && (f.init != null || f.med != null)
}
function joinsPrev(cp: number): boolean {
  const f = SHAPE_TABLE[cp]
  return !!f && (f.fin != null || f.med != null)
}

// Shapes (joins) and reverses ONE run of pure Arabic-script characters —
// never call this on a string that mixes in Latin/digits, see shapeUrdu().
function shapeRun(chars: string[]): string {
  const out: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)!
    const forms = SHAPE_TABLE[cp]
    if (!forms) { out.push(chars[i]); continue }

    let prevIdx = i - 1
    while (prevIdx >= 0 && TRANSPARENT.has(chars[prevIdx].codePointAt(0)!)) prevIdx--
    let nextIdx = i + 1
    while (nextIdx < chars.length && TRANSPARENT.has(chars[nextIdx].codePointAt(0)!)) nextIdx++

    const hasPrev = prevIdx >= 0 && joinsNext(chars[prevIdx].codePointAt(0)!)
    const hasNext = nextIdx < chars.length && joinsPrev(cp) && !!SHAPE_TABLE[chars[nextIdx].codePointAt(0)!]

    let code: number
    if (hasPrev && hasNext && forms.med != null) code = forms.med
    else if (hasPrev && forms.fin != null) code = forms.fin
    else if (hasNext && forms.init != null) code = forms.init
    else code = forms.iso
    out.push(String.fromCodePoint(code))
  }
  return out.reverse().join('')
}

const ARABIC_RANGE = /[؀-ۿ]/

// Real bug, 2026-09-25: a title with an embedded number ("Project Number
// 12...") came out as "21" — reversing the WHOLE string char-by-char
// (the naive single-run version this replaced) flips embedded Latin/digit
// runs too, which should stay in their own left-to-right order even inside
// an otherwise-RTL sentence. This is a poor man's bidi: split into runs of
// Arabic-script vs everything else (digits, Latin, spaces, punctuation),
// reverse the ORDER of runs (an RTL paragraph lays its runs out right to
// left) but only shape+reverse the CHARACTERS within an Arabic run — a
// non-Arabic run's own characters pass through untouched and in place.
export function shapeUrdu(text: string): string {
  const runs: { chars: string[]; rtl: boolean }[] = []
  for (const ch of Array.from(text)) {
    const rtl = ARABIC_RANGE.test(ch)
    const last = runs[runs.length - 1]
    // A space doesn't force a new run — it stays part of whichever run
    // it's already trailing, so "خاندان 12" doesn't split into three tiny
    // runs (Arabic, space, digit) with the space's own direction undecided.
    if (last && (ch === ' ' || last.rtl === rtl)) last.chars.push(ch)
    else runs.push({ chars: [ch], rtl })
  }
  return runs
    .reverse()
    .map((r) => (r.rtl ? shapeRun(r.chars) : r.chars.join('')))
    .join('')
}

// Correct for a single line; a caller whose text might wrap onto multiple
// lines should use shapeUrduLines() instead — reversing run order across a
// whole multi-line string then letting Satori's own (left-to-right)
// wrapping break it moves entire word groups to the wrong line, not just
// mirrors them within one.

// Greedy word-wrap BEFORE shaping/reversing, so each line is its own
// independently-correct RTL unit — the caller renders one flex row per
// returned line instead of handing Satori one long string to wrap itself.
// maxCharsPerLine is a rough character-count budget, not a pixel
// measurement (Satori gives no way to measure text ahead of layout); pick
// it from the title's own font-size/max-width to get a reasonable balance,
// perfect wrapping isn't the point — correct reading order within and
// across lines is.
export function shapeUrduLines(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (current && candidate.length > maxCharsPerLine) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines.map(shapeUrdu)
}
