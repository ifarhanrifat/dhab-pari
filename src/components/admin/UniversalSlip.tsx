'use client'

import { forwardRef } from 'react'
import { dtBoth, type DocStringKey, type SlipLang } from '@/lib/docTranslations'
import { fmt, fmtDate, isRtlText, Ltr, PhoneLink, prettyUrl, splitNumbers, waHref } from './slipShared'
import { SlipIcon, type SlipIconName } from './SlipIcons'
import type { ReceiptData } from './ReceiptDocument'
import { SITE } from '@/lib/constants'

export type SlipFormat = 'a4' | 'thermal'

// One document design for every transaction type. The chrome — org header,
// meta row, signature, footer — is identical for a water bill, a donation
// receipt, a payment voucher and a purchase; only the body shape changes, and
// there are just two of those:
//
//   itemized — a line-items table plus total/paid/balance   (bills)
//   hero     — one large amount plus a couple of summary rows (everything else)
//
// Print target is a runtime choice, not a property of the record: the same
// receipt renders to A4 (794px ≈ A4 at 96dpi) or to a 58mm Bluetooth thermal
// roll (181px ≈ its 48mm printable strip). Nothing about the stored
// transaction changes. The chrome is deliberately identical across the two —
// same header lockup, same badge, same contact box — so a consumer handed a
// roll and a donor handed a sheet are holding recognisably the same document.

interface Props {
  data: ReceiptData
  format?: SlipFormat
}

// Prints "English / اردو" when the slip is in bilingual mode, one script
// otherwise. Kept as a component rather than a joined string because the two
// scripts need different fonts and independent bidi handling.
function L({ data, k, className = '', style, stack = false, phrase = false }: { data: ReceiptData; k: DocStringKey; className?: string; style?: React.CSSProperties; stack?: boolean; phrase?: boolean }) {
  const mode: SlipLang = data.slipDisplayMode ?? 'both'
  const { en, ur } = dtBoth(mode, k)
  // Inline "English / اردو" is right on A4, where a label cell is wide enough
  // to hold both scripts with the figure still beside them. On a 58mm roll a
  // two-column money row leaves the label barely thirty characters, so the
  // same pair wraps mid-phrase and strands the slash at the end of a line.
  // Stacking the two scripts is the fix LStack already applies to the narrow
  // icon captions below — same reasoning, applied wherever the column is the
  // thing that's narrow rather than the caption.
  if (stack && en && ur) {
    // Both lines carry their own leading rather than inheriting the row's.
    // Nastaliq's ascenders and descenders reach far outside the em box, so at
    // the line-height that suits the Latin half it climbs into whatever sits
    // above it — the stacked labels printed on top of each other until these
    // were set explicitly.
    return (
      <span className={className} style={{ display: 'inline-block', ...style }}>
        <span style={{ display: 'block', lineHeight: 1.25 }}>{en.trim().replace(/:$/, '')}</span>
        <span style={{ display: 'block', fontFamily: 'var(--font-urdu), serif', fontSize: '0.82em', lineHeight: 1.95 }}>{ur.trim().replace(/:$/, '')}</span>
      </span>
    )
  }
  return (
    // The pair is one isolated unit, deliberately. A bilingual label ends in
    // Urdu, and an unisolated Urdu tail merges with whatever RTL text comes
    // after it into a single right-to-left run — which the bidi algorithm
    // then reverses as a whole, stranding the label's Urdu half at the far
    // end of the line with the value printed between the two halves of its
    // own label. That is the "Remarks is displaying in the middle of the
    // description" bug, and it can bite any label followed by Urdu content,
    // not just Remarks, so the fix belongs here rather than at each call.
    <span className={className} style={{ unicodeBidi: 'isolate', ...style }}>
      {/* phrase: each script holds together and the line may only break at
          the slash between them. A label short enough to fit ("Receipt /
          رسید") stays on one line; one that isn't ("Payment Voucher /
          ادائیگی واؤچر") breaks cleanly between the two scripts instead of
          dropping a single Urdu word onto the next line. Off by default —
          a few labels here are whole sentences that must be free to wrap
          wherever they need to. */}
      {en && <span style={phrase ? { whiteSpace: 'nowrap' } : undefined}>{en.trim().replace(/:$/, '')}</span>}
      {en && ur && <span style={{ opacity: 0.55 }}> / </span>}
      {/* Nastaliq renders visibly larger than the Latin face at the same
          pixel size — sized down (em, so it scales with whatever this
          label's own size is) rather than up, so a bilingual pair like
          "Paid To / ادائیگی بنام" doesn't read as the Urdu half shouting
          over the English half. */}
      {ur && <span style={{ fontFamily: 'var(--font-urdu), serif', fontSize: '0.82em', ...(phrase ? { whiteSpace: 'nowrap' } : null) }}>{ur.trim().replace(/:$/, '')}</span>}
    </span>
  )
}

// Free text an admin typed: a voucher narration, a particular. It may be
// Urdu, English, or Urdu carrying Latin digits ("… 60000 الگ جمع کرایا گیا
// اور 97363 …"). dir="auto" lets each one take its base direction from its
// own first strong character, so an Urdu remark reads right-to-left and an
// English one left-to-right without the document having to guess; the
// isolate stops it fusing with the label in front of it.
function Prose({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span dir="auto" style={{ unicodeBidi: 'isolate', ...style }}>{children}</span>
}

// One fact, one line: "Label / اردو: value". The label and the value it
// introduces belong on the same row — split across two rows they read as two
// separate facts, and on a 58mm roll that doubles the height of the meta
// block to say the same thing.
function Field({
  data, k, labelSize, valueStyle, align = 'left', children,
}: {
  data: ReceiptData
  k: DocStringKey
  labelSize: number
  valueStyle?: React.CSSProperties
  align?: 'left' | 'right'
  children: React.ReactNode
}) {
  return (
    <div style={{ fontSize: labelSize, color: MUTED, textAlign: align, lineHeight: 1.5 }}>
      <L data={data} k={k} phrase />
      <span>: </span>
      <span style={{ color: INK, unicodeBidi: 'isolate', ...valueStyle }}>{children}</span>
    </div>
  )
}

// A printed number is only "tappable" if it reads as one object. This used to
// be a bare glyph sitting next to bare digits with a margin between them, and
// which side the glyph took flipped with the reading direction — which meant
// that inside the RTL contact box the digits drifted to the far edge of the
// line, visually divorced from the label that explains what they're for. That
// is the "WhatsApp buttons are not Urdu friendly" complaint.
//
// Binding them inside one bordered pill fixes it structurally instead of by
// tuning margins: the glyph and the digits cannot be separated by the bidi
// algorithm because they are one inline-flex box, and the border makes the
// affordance explicit on paper as well as on screen. The glyph leads in both
// scripts deliberately — it is the app's mark, not a word that has to obey
// reading order — and dir="ltr" keeps the digits in dialling order inside an
// Urdu paragraph.
function WaChip({ number, size }: { number: string; size: number }) {
  const href = waHref(number)
  const body = (
    <span
      dir="ltr"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: '#fff', border: '1px solid #b7dfc4', borderRadius: 999,
        padding: '1px 8px', fontSize: size, fontWeight: 700, color: '#14532d',
        lineHeight: 1.75, whiteSpace: 'nowrap',
      }}
    >
      <SlipIcon name="whatsapp" size={Math.round(size * 1.15)} />
      <Ltr>{number}</Ltr>
    </span>
  )
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{body}</a> : body
}

// One contact = one label (each script on its own line) with its numbers
// directly beneath it. Both rows of the green box use this, so the helpline
// and the complaint line finally have the same anatomy — previously the
// helpline was two stacked rows and the complaint was a single inline
// "English / اردو" row, in the same box.
function ContactRow({ en, ur, numbers, font }: { en: string | null; ur: string | null; numbers: string[]; font: number }) {
  return (
    <div>
      {en && <div dir="ltr" style={{ fontSize: font, lineHeight: 1.45 }}>{en}</div>}
      {ur && <div dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif', fontSize: font, lineHeight: 1.85 }}>{ur}</div>}
      <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
        {numbers.map((n) => <WaChip key={n} number={n} size={font} />)}
      </div>
    </div>
  )
}

function LStack({ data, k, size }: { data: ReceiptData; k: DocStringKey; size: number }) {
  const mode: SlipLang = data.slipDisplayMode ?? 'both'
  const { en, ur } = dtBoth(mode, k)
  return (
    <span style={{ display: 'block', textAlign: 'center', fontSize: size, lineHeight: 1.3, color: MUTED }}>
      {en && <span style={{ display: 'block' }}>{en}</span>}
      {ur && <span style={{ display: 'block', fontFamily: 'var(--font-urdu), serif', fontSize: '0.9em' }}>{ur}</span>}
    </span>
  )
}

const MUTED = '#5b6470'
const INK = '#1a1d21'
const RULE = '#d8dce1'

export const UniversalSlip = forwardRef<HTMLDivElement, Props>(function UniversalSlip({ data, format = 'a4' }, ref) {
  const thermal = format === 'thermal'
  const mode: SlipLang = data.slipDisplayMode ?? 'both'

  // Three admin-tunable tiers (Settings → Documents → Universal Slip). Every
  // size below is derived from one of them, so raising "data" nudges the whole
  // body in proportion instead of leaving half the slip behind.
  const fH = data.slipFontHeading ?? 21
  const fB = data.slipFontBody ?? 14
  const fF = data.slipFontFooter ?? 12
  // Thermal paper is a fraction the width of A4; type has to come down with it
  // or a single line wraps three times.
  const k = thermal ? 0.68 : 1
  // Thermal has a hard legibility floor that A4 does not. The export path
  // rasterizes this node and gives the PDF a page exactly as wide as the node
  // (see nodeToPdfBlob), so the print bridge scales that page onto the roll's
  // printable width — every pixel here maps to a fixed physical size, and the
  // admin's font settings scale straight through it. Production runs
  // slip_font_footer = 10, which at the old scale printed the green contact box
  // at ~1.1mm of type: a 203dpi head smears Nastaliq that small into a blur.
  // Clamp the *base* of each tier on thermal only — A4 keeps the admin's
  // chosen sizes exactly, because a sheet printer has no such floor.
  const floorAt = (v: number, min: number) => (thermal ? Math.max(v, min) : v)
  const baseH = floorAt(fH * k, 13)
  const baseB = floorAt(fB * k, 10)
  const baseF = floorAt(fF * k, 9)
  const h = (n: number) => Math.round(baseH * n)
  const b = (n: number) => floorAt(Math.round(baseB * n), 9)
  const f = (n: number) => floorAt(Math.round(baseF * n), 8)

  const logoPx = thermal ? 44 : (data.logoWidth ?? 56)
  // 58mm roll, not 80mm. The committee's printer takes 58mm paper, whose
  // printable strip is 48mm (384 dots at 203dpi) — 181px at the 96dpi this
  // document is measured in. The old 302px was 80mm of paper, so every slip
  // was built at 80mm and then squeezed to ~60% by the print bridge on the way
  // to the roll: nothing reflowed (the PDF is a raster), it just came out
  // uniformly tiny. Sizing the node to the real printable width means 1px here
  // is 1px on the paper and the type above prints at its stated size.
  //
  // Which roll is no longer a constant in this file. It is a Settings choice
  // per system (migration 443), because when a printout comes out misaligned
  // the committee has to be able to fix it themselves rather than wait for a
  // deploy — and the two systems can own different printers.
  //
  // 58mm prints on a 48mm strip (384 dots at 203dpi) = 181px at 96dpi;
  // 80mm prints on a 72mm strip (576 dots) = 272px. Both map a pixel here to
  // the same 0.265mm on paper, so widening the roll buys horizontal room
  // without changing how large the type comes out — which is why the scale
  // and the legibility floors below are shared by both.
  const rollMm = data.slipThermalWidthMm === 80 ? 80 : 58
  const width = thermal ? (rollMm === 80 ? 272 : 181) : 794
  // ~2.6mm of margin. Nothing bleeds to the edge, so the few percent of
  // clipping a mis-calibrated print bridge might introduce costs only padding.
  const pad = thermal ? (rollMm === 80 ? 12 : 10) : 48

  const isBill = data.kind === 'bill'
  const isDonation = data.kind === 'donation'
  const isPurchase = data.kind === 'purchase_payment'
  // A salary slip without payroll data would render an empty body — fall back
  // to the hero amount rather than printing a blank grid.
  const payroll = data.kind === 'salary' ? data.payroll : undefined
  // A bill is always itemized even with one line; a purchase payment always
  // gets its own Paid From / Paid To body (below) regardless of whether it
  // has real line items, so a plain single-account expense still reads as
  // the double-entry document it is; anything else earns the generic
  // itemized table only when it actually has real lineItems to show — a
  // multi-category voucher (Kafalat's monthly payment) or a multi-item
  // purchase, not every plain receipt.
  const hasRealLineItems = !!data.lineItems && data.lineItems.length > 0
  const body: 'itemized' | 'hero' | 'payroll' | 'expense' = payroll ? 'payroll' : isPurchase ? 'expense' : (isBill || hasRealLineItems) ? 'itemized' : 'hero'

  const titleKey: DocStringKey = data.kind === 'salary' ? 'titleSalarySlip' : isBill ? 'titleBill' : isPurchase ? 'titlePaymentVoucher' : 'titleReceipt'
  const partyKey: DocStringKey = data.kind === 'salary' ? 'employee' : isPurchase ? 'paidTo' : isDonation ? 'donor' : isBill ? 'billedTo' : 'receivedFrom'

  // A muted, desaturated badge per document type — the same "designate it at
  // a glance" job as this app's own status pills elsewhere (paid/overdue on a
  // bill, approved/pending on a voucher), applied here to the document kind
  // itself. Money leaving reads amber (caution), money arriving reads green
  // (donation gets its own violet so a donation receipt is still visibly not
  // a water-bill receipt), a bill is neutral slate since nothing has moved
  // yet, salary its own indigo. Never the accent color scheme of any single
  // system — this badge has to mean the same thing on both.
  const kindAccent = data.kind === 'salary'
    ? { bg: '#eaecfb', fg: '#3730a3' }
    : isBill
      ? { bg: '#eceff3', fg: '#3f4c5c' }
      : isPurchase
        ? { bg: '#fbebd9', fg: '#9a5714' }
        : isDonation
          ? { bg: '#f3e8fb', fg: '#7e3aa8' }
          : { bg: '#e3f5e9', fg: '#0f7a4d' }

  const isDonorSystem = isDonation || /donor/i.test(data.systemLabel ?? '')
  const helplineKey: DocStringKey = data.kind === 'salary'
    ? 'helplineGeneral'
    : isDonorSystem ? 'helplineDonation' : 'helplineWater'

  const helplines = splitNumbers(data.helplineNumbers)
  const complaints = splitNumbers(data.footerComplaintNumber)
  const contacts = data.footerManagementContacts ?? []

  // Icons are rendered only for links that are actually configured — a dead
  // icon on a printed slip is worse than a missing one.
  const iconLinks: { name: SlipIconName; href: string; key: DocStringKey }[] = []
  if (data.footerFacebookLink) iconLinks.push({ name: 'facebook', href: data.footerFacebookLink, key: 'facebook' })
  if (data.footerWhatsappGroupLink) iconLinks.push({ name: 'whatsapp', href: data.footerWhatsappGroupLink, key: 'groupShort' })
  if (data.footerWhatsappChat) {
    const chat = waHref(data.footerWhatsappChat)
    if (chat) iconLinks.push({ name: 'whatsappChat', href: chat, key: 'chatWithUs' })
  }
  if (data.footerWebsiteLink) iconLinks.push({ name: 'website', href: data.footerWebsiteLink, key: 'website' })
  if (data.companyEmail) iconLinks.push({ name: 'email', href: `mailto:${data.companyEmail}`, key: 'email' })
  if (data.footerProjectsLink) iconLinks.push({ name: 'projects', href: data.footerProjectsLink, key: 'projectsShort' })
  if (data.footerDonationLink) iconLinks.push({ name: 'donate', href: data.footerDonationLink, key: 'donate' })
  if (data.footerSuggestionsLink) iconLinks.push({ name: 'suggestions', href: data.footerSuggestionsLink, key: 'suggestionsShort' })
  if (data.footerComplaintsLink) iconLinks.push({ name: 'complaints', href: data.footerComplaintsLink, key: 'complaintsShort' })

  // This box carries the one thing a consumer needs when something has gone
  // wrong with their money, so it does not get shrunk below the rest of the
  // footer any more — it is the same size, and on thermal the floor in f()
  // keeps it above the point where the print head stops resolving Nastaliq.
  // Nothing in here is nowrap: a long label plus a number used to overflow
  // right out of the green background instead of wrapping inside it — the
  // "number is displaying outside the green belt" bug. Staying inside the
  // box's own painted area matters far more than staying on one line.
  const boxFont = f(1)
  // Settings wording wins where it has been filled in; the built-in strings
  // remain the fallback so a blank field prints the sensible default rather
  // than an empty row. Salary slips keep the neutral built-in wording either
  // way — the water supply's label would tell an employee to call about a
  // water fault.
  const helpPair = dtBoth(mode, helplineKey)
  const cmpPair = dtBoth(mode, 'complaint')
  const custom = data.kind !== 'salary'
  const pickLabel = (setting: string | null | undefined, builtIn: string | null) => {
    if (!builtIn) return null           // language switched off for this slip
    const v = custom ? setting?.trim() : ''
    return v || builtIn
  }
  const helpEn = pickLabel(data.helplineLabelEn, helpPair.en?.trim().replace(/:$/, '') ?? null)
  const helpUr = pickLabel(data.helplineLabelUr, helpPair.ur?.trim().replace(/:$/, '') ?? null)
  const cmpEn = pickLabel(data.complaintLabelEn, cmpPair.en?.trim().replace(/:$/, '') ?? null)
  const cmpUr = pickLabel(data.complaintLabelUr, cmpPair.ur?.trim().replace(/:$/, '') ?? null)

  const iconGap = iconLinks.length > 7 ? 12 : 18
  const iconCell = iconLinks.length > 7 ? 62 : 70

  const discount = data.discountAmount ?? 0
  const paid = data.paidAmount ?? 0

  const money = (n: number) => (thermal ? fmt(n) : `${fmt(n)}`)

  // Summary rows under the hero amount. Donations speak donation vocabulary
  // (lifetime total, announced-but-unpaid); everything else uses the generic
  // outstanding pair. Zero rows are dropped rather than printed as 0.00.
  // An unconfirmed donation has not been counted into the fund yet, so its
  // lifetime total is legitimately zero — printing that bare number reads as a
  // bug. Drop the row and let the "not yet confirmed" marker explain it.
  const unconfirmed = isDonation && data.isConfirmed === false
  const summaryRows: { k: DocStringKey; v: number }[] = []
  if (isDonation) {
    if (!unconfirmed) summaryRows.push({ k: 'totalContributed', v: data.balanceAfter })
    if ((data.announcedRemaining ?? 0) > 0) summaryRows.push({ k: 'announcedRemaining', v: data.announcedRemaining! })
  } else if (data.balanceAfter > 0) {
    summaryRows.push({ k: 'outstandingAmount', v: data.balanceAfter })
    if (data.kind === 'payment' && (data.advanceBalance ?? 0) > 0) summaryRows.push({ k: 'advanceBalance', v: data.advanceBalance! })
  } else if (data.kind === 'payment' && (data.advanceBalance ?? 0) > 0) {
    // No outstanding on this bill, but the consumer still carries a credit
    // on the account — worth printing on its own row rather than only
    // appearing when there also happens to be something owed.
    summaryRows.push({ k: 'advanceBalance', v: data.advanceBalance! })
  }

  const urduFont = { fontFamily: 'var(--font-urdu), serif' } as const
  // On a 58mm roll a two-column money row leaves the label about thirty
  // characters, which a bilingual pair cannot hold beside a bold figure on
  // one line — stack the scripts there instead of letting them wrap
  // mid-phrase. An 80mm roll has the room and does not need to.
  //
  // Note this now applies to the money rows only. The meta block used to
  // stack too, which is why "Receipt / رسید" printed on two lines above its
  // own number; measuring that row showed the inline pair plus the number
  // clears 161px with ~15px to spare, so it was paying two lines of height
  // to solve a problem it never had. See the meta block below.
  const stackLabels = thermal && rollMm === 58
  // Label wraps if it must; the figure never does.
  const totalRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: thermal ? 6 : 12, lineHeight: 1.7 }
  const moneyCell: React.CSSProperties = { whiteSpace: 'nowrap', flexShrink: 0 }

  return (
    <div
      ref={ref}
      dir="ltr"
      style={{
        width, background: '#fff', padding: pad, color: INK,
        fontFamily: 'var(--font-sans), sans-serif', fontSize: b(1), lineHeight: 1.5,
      }}
    >
      {/* ── Header: identical for every document type ─────────────────
          One centred lockup, logo on top. It used to be a flex row with the
          logo on the left and a spacer on the right to fake centring, which
          spent both logo widths of the line on nothing and left the name
          block barely a quarter of a 58mm roll to sit in — that squeeze is
          what pushed the heading onto several ragged rows.

          The three lines are now deliberately three different ranks rather
          than three sizes that happened to fall out of the font settings.
          The Urdu name is the organisation's actual name so it still leads,
          but it no longer shouts: Nastaliq renders much larger than Latin at
          the same pixel size, so the old h(1.3) against a footer-sized
          English name read as roughly three to one. "Dhab Pari" is now body
          sized, weighted and in full ink — it is a name, not a caption — and
          only the system label stays small, muted and tracked, because that
          genuinely is a caption. Same structure on both targets so an A4
          sheet and a roll are recognisably the same document. */}
      <div style={{ borderBottom: `2px solid ${INK}`, paddingBottom: thermal ? 8 : 18, textAlign: 'center' }}>
        {data.logoUrl && (
          <img
            src={data.logoUrl} alt=""
            style={{ width: logoPx, height: logoPx, objectFit: 'contain', borderRadius: 6, display: 'block', margin: '0 auto' }}
          />
        )}
        {mode !== 'en' && data.companyNameUr && (
          // Nastaliq hangs well below its baseline; the extra leading keeps the
          // descenders off the line under it instead of clipping them.
          <div
            style={{ ...urduFont, fontSize: thermal ? h(1) : h(1.15), fontWeight: 700, lineHeight: 1.95, marginTop: data.logoUrl ? (thermal ? 2 : 6) : 0 }}
            dir="rtl"
          >
            {data.companyNameUr}
          </div>
        )}
        {/* Nastaliq's closing sweep drops below anything line-height alone
            reserves for it, so the English name is nudged clear of the tail
            rather than sitting under it. */}
        <div style={{ fontSize: b(1.05), fontWeight: 600, letterSpacing: '0.02em', color: INK, lineHeight: 1.35, marginTop: mode !== 'en' && data.companyNameUr ? 3 : 0 }}>
          {data.companyNameEn || SITE.name}
        </div>
        {data.systemLabel && (
          // Tracking buys nothing on a 48mm strip except lost characters.
          <div style={{ fontSize: f(0.92), fontWeight: 400, letterSpacing: thermal ? '0.02em' : '0.08em', textTransform: 'uppercase', color: MUTED, lineHeight: 1.5, marginTop: 1 }}>
            {data.systemLabel}
          </div>
        )}
      </div>

      {/* ── Type badge: the one thing that must be readable in half a
          second — a bill, a receipt, a payment voucher and a donation
          receipt otherwise share the exact same chrome. */}
      <div style={{ textAlign: 'center', marginTop: thermal ? 8 : 14 }}>
        <span
          style={{
            display: 'inline-block', padding: thermal ? '3px 11px' : '5px 18px', borderRadius: 999,
            // Tracking is a luxury the roll cannot afford: at 0.08em
            // "PAYMENT VOUCHER / ادائیگی واؤچر" spills onto a third line.
            fontWeight: 700, letterSpacing: thermal ? '0.03em' : '0.08em', textTransform: 'uppercase',
            fontSize: Math.max(f(0.88), 10), background: kindAccent.bg, color: kindAccent.fg,
          }}
        >
          <L data={data} k={titleKey} />
        </span>
      </div>

      {/* ── Meta block ───────────────────────────────────────────────
          Date tucks under the header rule, then every fact below reads
          "label: value" on its own single line. Labels and values used to
          occupy separate rows, which meant pairing one with the other was a
          downward eye movement on a document people scan across. */}
      <div style={{ textAlign: 'right', fontSize: f(1), color: MUTED, marginTop: thermal ? 6 : 8 }}>
        <Ltr>{fmtDate(data.date)}</Ltr>
      </div>

      {thermal ? (
        // Two columns do not survive 48mm. Side by side, a long consumer name
        // on the left and "Billing Period / بلنگ مدت" on the right grew into
        // each other until the Urdu name overlapped the address beneath it —
        // visible on any account whose name runs past one line. On the roll the
        // same facts run one per line instead: who the document is for, then
        // what the document is, each label beside its own value and nothing
        // competing for the same horizontal space.
        <div style={{ marginTop: 6 }}>
          {/* The name reads on the same line as the label that introduces
              it. It may still wrap onto a second line when a name is
              genuinely long — what it may not do is start on one. */}
          <Field data={data} k={partyKey} labelSize={f(1)} valueStyle={{ fontWeight: 600, fontSize: b(1.1) }}>
            {data.accountName}
          </Field>
          {/* Left-aligned like the Latin name it belongs to, not flushed to the
              right by its own direction — the two are one name, not two. */}
          {data.accountNameUr && <div style={{ ...urduFont, fontSize: b(0.95), color: MUTED, lineHeight: 1.9, marginBottom: 2, textAlign: 'left' }} dir="rtl">{data.accountNameUr}</div>}
          {data.accountAddress && <div style={{ fontSize: f(1), color: MUTED, lineHeight: 1.4 }}>{data.accountAddress}</div>}
          {data.accountPhone && <div style={{ fontSize: f(1), color: MUTED, lineHeight: 1.4 }}><Ltr>{data.accountPhone}</Ltr></div>}

          {/* Each fact gets its own row with real air around it.
              These labels are deliberately NOT stacked, unlike the money rows
              further down: the value beside them is a short number or a date,
              not a wide bold figure, so the bilingual pair and its value fit
              one line even on the 48mm strip. "Receipt / رسید" printing above
              its own number was costing a line of roll per fact to no end. */}
          <div style={{ marginTop: 6, borderTop: `1px solid ${RULE}`, paddingTop: 5, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ ...totalRow, alignItems: 'center' }}>
              <L data={data} k={titleKey} phrase style={{ fontSize: f(1), color: MUTED, lineHeight: 1.4 }} />
              {unconfirmed
                // The one value on the slip that is words rather than a figure,
                // so it gets the stacked treatment and is allowed to wrap —
                // "Not yet confirmed / ابھی تصدیق نہیں ہوئی" held on one
                // nowrap line would run straight off a 48mm roll.
                ? <L data={data} k="notYetConfirmed" stack={stackLabels} style={{ flexShrink: 1, fontWeight: 700, fontSize: b(0.95), color: '#b3261e', textAlign: 'right' }} />
                : <Ltr style={{ ...moneyCell, fontWeight: 700, fontSize: b(1.1) }}>{data.receiptNo}</Ltr>}
            </div>
            {payroll?.designation && (
              <div style={{ ...totalRow, alignItems: 'center' }}>
                <L data={data} k="designation" phrase style={{ fontSize: f(1), color: MUTED, lineHeight: 1.4 }} />
                <strong style={{ ...moneyCell, fontSize: f(1) }}>{payroll.designation}</strong>
              </div>
            )}
            {data.billingPeriod && (
              <div style={{ ...totalRow, alignItems: 'center' }}>
                <L data={data} k="billingPeriod" phrase style={{ fontSize: f(1), color: MUTED, lineHeight: 1.4 }} />
                <strong style={{ ...moneyCell, fontSize: f(1) }}>{data.billingPeriod}</strong>
              </div>
            )}
            {data.dueDate && (
              <div style={{ ...totalRow, alignItems: 'center' }}>
                <L data={data} k="due" phrase style={{ fontSize: f(1), color: MUTED, lineHeight: 1.4 }} />
                <Ltr style={{ ...moneyCell, fontWeight: 600, fontSize: f(1) }}>{fmtDate(data.dueDate)}</Ltr>
              </div>
            )}
          </div>
        </div>
      ) : (
        // Two columns, but each one now carries its label and its value on
        // the same line. This used to be a four-cell grid whose first row
        // held both labels and whose second held both values, so "Received
        // From / وصول کنندہ از" sat on one row with the consumer's name
        // directly beneath it — the eye had to read down to pair a label
        // with its own value, and on a document people scan for one fact
        // that is a row of height spent on nothing.
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', columnGap: 16, marginTop: 10, alignItems: 'start' }}>
          <div style={{ minWidth: 0 }}>
            <Field data={data} k={partyKey} labelSize={f(1)} valueStyle={{ fontWeight: 600, fontSize: b(1.15) - 2 }}>
              {data.accountName}
            </Field>
          </div>
          <div style={{ minWidth: 0 }}>
            <Field
              data={data} k={titleKey} labelSize={f(1)} align="right"
              valueStyle={unconfirmed
                ? { fontWeight: 700, fontSize: b(0.95), color: '#b3261e' }
                : { fontWeight: 700, fontSize: b(1.15) - 2 }}
            >
              {unconfirmed
                ? <L data={data} k="notYetConfirmed" />
                : <Ltr>{data.receiptNo}</Ltr>}
            </Field>
          </div>

          <div style={{ minWidth: 0 }}>
            {data.accountNameUr && <div style={{ ...urduFont, fontSize: b(0.95), color: MUTED, textAlign: 'left' }} dir="rtl">{data.accountNameUr}</div>}
            {data.accountAddress && <div style={{ fontSize: f(1), color: MUTED }}>{data.accountAddress}</div>}
            {data.accountPhone && <div style={{ fontSize: f(1), color: MUTED }}><Ltr>{data.accountPhone}</Ltr></div>}
          </div>
          <div style={{ textAlign: 'right', fontSize: f(1), color: MUTED }}>
            {payroll?.designation && (
              <div><L data={data} k="designation" />{' '}<strong style={{ color: INK }}>{payroll.designation}</strong></div>
            )}
            {data.billingPeriod && (
              <div><L data={data} k="billingPeriod" />{' '}<strong style={{ color: INK }}>{data.billingPeriod}</strong></div>
            )}
            {data.dueDate && (
              <div><L data={data} k="due" /> <Ltr>{fmtDate(data.dueDate)}</Ltr></div>
            )}
          </div>
        </div>
      )}

      {/* Project earmark — donations only */}
      {isDonation && (
        <div style={{ marginTop: thermal ? 8 : 14, fontSize: b(1) }}>
          <L data={data} k="forProject" style={{ color: MUTED }} />
          {': '}
          <strong>{data.projectName || dtBoth(mode, 'generalFund').en || dtBoth(mode, 'generalFund').ur}</strong>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────── */}
      {body === 'payroll' ? (
        <div style={{ marginTop: thermal ? 10 : 24 }}>
          <div style={{ display: thermal ? 'block' : 'grid', gridTemplateColumns: '1fr 1fr', gap: thermal ? 0 : 28 }}>
            <div>
              <L data={data} k="earningsThisCycle" stack={stackLabels} style={{ display: 'block', fontSize: f(0.95), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, borderBottom: `2px solid ${INK}`, paddingBottom: 6, lineHeight: 1.9 }} />
              {payroll!.earnings.map((e, i) => (
                <div key={i} style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', borderBottom: `1px solid ${RULE}`, fontSize: b(1) }}>
                  <span>{e.label}</span>
                  <Ltr style={moneyCell}>{money(e.amount)}</Ltr>
                </div>
              ))}
              <div style={{ ...totalRow, paddingTop: 8, fontWeight: 700, fontSize: b(1.05) }}>
                <L data={data} k="totalEarnings" stack={stackLabels} />
                <Ltr style={moneyCell}>{money(payroll!.totalEarnings)}</Ltr>
              </div>
            </div>

            <div style={{ marginTop: thermal ? 14 : 0 }}>
              <L data={data} k="settlement" stack={stackLabels} style={{ display: 'block', fontSize: f(0.95), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, borderBottom: `2px solid ${INK}`, paddingBottom: 6, lineHeight: 1.9 }} />
              <div style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', borderBottom: `1px solid ${RULE}`, fontSize: b(1) }}>
                <L data={data} k="balanceOwed" stack={stackLabels} />
                <Ltr style={moneyCell}>{money(payroll!.balanceOwed)}</Ltr>
              </div>
              <div style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', borderBottom: `1px solid ${RULE}`, fontSize: b(1), color: '#0f7a4d' }}>
                <L data={data} k="paidNow" stack={stackLabels} />
                <Ltr style={moneyCell}>− {money(payroll!.paidNow)}</Ltr>
              </div>
              <div style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', fontSize: b(1) }}>
                <L data={data} k="carriedForward" stack={stackLabels} />
                <Ltr style={moneyCell}>{money(payroll!.carriedForward)}</Ltr>
              </div>
            </div>
          </div>

          {/* Net Pay is the cash actually leaving the committee today — the
              number the employee signs for, not the accrued total. */}
          <div style={{ marginTop: thermal ? 10 : 22, paddingTop: thermal ? 8 : 14, borderTop: `2px solid ${INK}`, display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: thermal ? '100%' : 360, ...totalRow, fontWeight: 700, fontSize: b(1.35) }}>
              <L data={data} k="netPay" stack={stackLabels} />
              <Ltr style={moneyCell}>{money(payroll!.paidNow)}</Ltr>
            </div>
          </div>
        </div>
      ) : body === 'itemized' ? (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: thermal ? 10 : 24 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${INK}` }}>
                <th style={{ textAlign: 'left', paddingBottom: 6, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9 }}>
                  <L data={data} k="description" stack={stackLabels} />
                </th>
                <th style={{ textAlign: 'right', paddingBottom: 6, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9 }}>
                  <L data={data} k="amount" stack={stackLabels} />
                </th>
              </tr>
            </thead>
            <tbody>
              {(data.lineItems && data.lineItems.length > 0
                ? data.lineItems.map((l) => ({ label: l.quantity > 1 ? `${l.description} × ${l.quantity}` : l.description, amount: l.quantity * l.unitPrice }))
                : [{ label: data.particular, amount: data.amount + discount }]
              ).map((row, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${RULE}` }}>
                  <td style={{ padding: thermal ? '5px 0' : '9px 0', fontSize: b(1) }}>{row.label}</td>
                  <td style={{ padding: thermal ? '5px 0 5px 6px' : '9px 0', textAlign: 'right', fontSize: b(1), whiteSpace: 'nowrap' }}><Ltr>{money(row.amount)}</Ltr></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: thermal ? 8 : 18, paddingTop: thermal ? 8 : 12, borderTop: `2px solid ${INK}`, display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: thermal ? '100%' : 360 }}>
              {discount > 0 && (
                <div style={totalRow} >
                  <L data={data} k="discount" stack={stackLabels} style={{ color: '#0f7a4d', fontSize: b(1) }} />
                  <Ltr style={{ ...moneyCell, color: '#0f7a4d', fontSize: b(1) }}>− {money(discount)}</Ltr>
                </div>
              )}
              <div style={{ ...totalRow, marginTop: discount > 0 ? 4 : 0 }}>
                <L data={data} k="totalPayable" stack={stackLabels} style={{ fontWeight: 700, fontSize: b(1.25) }} />
                <Ltr style={{ ...moneyCell, fontWeight: 700, fontSize: b(1.25) }}>{money(data.amount)}</Ltr>
              </div>
              {paid > 0 && (
                <>
                  <div style={{ ...totalRow, marginTop: 6 }}>
                    <L data={data} k="paid" stack={stackLabels} style={{ color: '#0f7a4d', fontSize: b(1) }} />
                    <Ltr style={{ ...moneyCell, color: '#0f7a4d', fontSize: b(1) }}>{money(paid)}</Ltr>
                  </div>
                  <div style={{ ...totalRow, marginTop: 3 }}>
                    <L data={data} k="balanceDue" stack={stackLabels} style={{ color: '#b3261e', fontSize: b(1) }} />
                    <Ltr style={{ ...moneyCell, color: '#b3261e', fontSize: b(1) }}>{money(Math.max(data.amount - paid, 0))}</Ltr>
                  </div>
                </>
              )}
            </div>
          </div>

          {(data.securityDepositAmount ?? 0) > 0 && (
            <div style={{ marginTop: thermal ? 8 : 16, background: '#f2f4f6', borderRadius: 6, padding: thermal ? '8px 10px' : '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <L data={data} k={thermal ? 'depositRefundableSeparate' : 'securityDepositNote'} stack={stackLabels} style={{ fontSize: f(1), color: MUTED }} />
              <Ltr style={{ ...moneyCell, fontWeight: 600, fontSize: b(1) }}>{money(data.securityDepositAmount!)}</Ltr>
            </div>
          )}
        </>
      ) : body === 'expense' ? (
        // Every payment voucher is a double-entry document even when only one
        // account was paid — "Paid From" (credited) against "Paid To"
        // (debited), Total repeated in both columns because a real voucher
        // always balances. A split expense's several line items all sit
        // under the same "Paid To" group instead of each getting its own —
        // that grouping IS the fact being shown, not an accident of layout.
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: thermal ? 10 : 24 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${INK}` }}>
                <th style={{ textAlign: 'left', paddingBottom: 6, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9 }}>
                  <L data={data} k="particular" stack={stackLabels} />
                </th>
                {/* On a roll these columns size to their own figures instead
                    of being pinned to 48px. A pinned 48px column cannot hold
                    "157,363.00", so the debit and credit totals overflowed
                    their cells and printed touching — "157,363.00157,363.00",
                    two amounts read as one. A money column is only ever as
                    narrow as the money in it. */}
                <th style={{ textAlign: 'right', paddingBottom: 6, paddingLeft: thermal ? 6 : 0, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9, width: thermal ? undefined : 110 }}>
                  <L data={data} k="debit" stack={stackLabels} />
                </th>
                <th style={{ textAlign: 'right', paddingBottom: 6, paddingLeft: thermal ? 6 : 0, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9, width: thermal ? undefined : 110 }}>
                  <L data={data} k="credit" stack={stackLabels} />
                </th>
              </tr>
            </thead>
            <tbody>
              {data.paidFromName && (
                <>
                  <tr>
                    <td colSpan={3} style={{ paddingTop: thermal ? 6 : 12, paddingBottom: 2, fontSize: b(0.95), fontWeight: 700, fontStyle: 'italic' }}>
                      <L data={data} k="paidFrom" stack={stackLabels} />
                    </td>
                  </tr>
                  <tr style={{ borderBottom: `1px solid ${RULE}` }}>
                    <td style={{ padding: thermal ? '5px 0' : '9px 0', fontSize: b(1) }}>{data.paidFromName}</td>
                    <td style={{ padding: thermal ? '5px 0' : '9px 0' }} />
                    <td style={{ padding: thermal ? '5px 0 5px 6px' : '9px 0', textAlign: 'right', fontSize: b(1), whiteSpace: 'nowrap' }}><Ltr>{money(data.amount)}</Ltr></td>
                  </tr>
                </>
              )}
              <tr>
                <td colSpan={3} style={{ paddingTop: thermal ? 10 : 16, paddingBottom: 2, fontSize: b(0.95), fontWeight: 700, fontStyle: 'italic' }}>
                  <L data={data} k="paidTo" stack={stackLabels} />
                </td>
              </tr>
              {/* An ordinary (non-split) voucher's one "Paid To" row is the
                  account it actually posted to (data.accountName) — never
                  the narration. The narration gets its own Remarks line
                  below, same as every other document kind. */}
              {(hasRealLineItems
                ? data.lineItems!.map((l) => ({ label: l.quantity > 1 ? `${l.description} × ${l.quantity}` : l.description, amount: l.quantity * l.unitPrice }))
                : [{ label: data.accountName, amount: data.amount }]
              ).map((row, i, arr) => (
                <tr key={i} style={{ borderBottom: i === arr.length - 1 ? `1px solid ${INK}` : `1px solid ${RULE}` }}>
                  <td style={{ padding: thermal ? '5px 0' : '9px 0', fontSize: b(1) }}>{row.label}</td>
                  <td style={{ padding: thermal ? '5px 0 5px 6px' : '9px 0', textAlign: 'right', fontSize: b(1), whiteSpace: 'nowrap' }}><Ltr>{money(row.amount)}</Ltr></td>
                  <td style={{ padding: thermal ? '5px 0' : '9px 0' }} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ paddingTop: thermal ? 8 : 14, fontWeight: 700, fontSize: b(1.1) }}><L data={data} k="total" stack={stackLabels} /></td>
                <td style={{ paddingTop: thermal ? 8 : 14, paddingLeft: thermal ? 6 : 0, textAlign: 'right', fontWeight: 700, fontSize: b(1.1), whiteSpace: 'nowrap' }}><Ltr>{money(data.amount)}</Ltr></td>
                <td style={{ paddingTop: thermal ? 8 : 14, paddingLeft: thermal ? 6 : 0, textAlign: 'right', fontWeight: 700, fontSize: b(1.1), whiteSpace: 'nowrap' }}><Ltr>{money(data.amount)}</Ltr></td>
              </tr>
            </tfoot>
          </table>
          {data.particular && (
            // The block reads whichever way its narration does, so the label
            // leads the text instead of trailing it: an Urdu remark is a
            // right-to-left paragraph and "Remarks / تبصرہ" belongs at its
            // right-hand start, exactly like the instructions block in the
            // footer. Left as an LTR paragraph, the label ended up at the far
            // left — the last thing an Urdu reader reaches.
            <div dir={isRtlText(data.particular) ? 'rtl' : 'ltr'} style={{ marginTop: thermal ? 8 : 16, fontSize: b(1) }}>
              <L data={data} k="remarks" style={{ color: MUTED, fontWeight: 600 }} />{' '}<Prose>{data.particular}</Prose>
            </div>
          )}
        </>
      ) : (
        <div style={{ textAlign: 'center', marginTop: thermal ? 12 : 26 }}>
          <L data={data} k={isDonation ? 'donationReceived' : 'amount'} style={{ fontSize: f(1.05), color: MUTED, display: 'block' }} />
          <div style={{ fontWeight: 700, fontSize: (thermal ? b(1.9) : b(3)) - 3, marginTop: 4, letterSpacing: '-0.01em' }}>
            <Ltr>{fmt(data.amount)}</Ltr>
          </div>
          {data.particular && (
            <div dir={isRtlText(data.particular) ? 'rtl' : 'ltr'} style={{ fontSize: f(1.05), color: MUTED, marginTop: 6 }}>
              <L data={data} k="remarks" style={{ fontWeight: 600 }} />{' '}<Prose>{data.particular}</Prose>
            </div>
          )}
          {summaryRows.length > 0 && (
            <div style={{ marginTop: thermal ? 10 : 18, border: `1px solid ${RULE}`, borderRadius: 8, overflow: 'hidden', textAlign: 'left' }}>
              {summaryRows.map((row, i) => (
                <div
                  key={row.k}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                    padding: thermal ? '7px 10px' : '9px 16px',
                    borderBottom: i < summaryRows.length - 1 ? `1px solid ${RULE}` : 'none',
                  }}
                >
                  <L data={data} k={row.k} stack={stackLabels} style={{ fontSize: f(1.05), color: MUTED, lineHeight: 1.7 }} />
                  <Ltr style={{ ...moneyCell, fontWeight: 600, fontSize: b(1) }}>{money(row.v)}</Ltr>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {data.collectedByName && (
        <div style={{ marginTop: thermal ? 8 : 14, fontSize: f(1), color: MUTED }}>
          <L data={data} k="collectedBy" />{': '}{data.collectedByName}
        </div>
      )}

      {/* ── Signature: A4 only. Thermal rolls stay compact. ──────────── */}
      {!thermal && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 40 }}>
          <div style={{ textAlign: 'center' }}>
            {data.signatureUrl && <img src={data.signatureUrl} alt="" style={{ height: 38, marginLeft: 'auto', display: 'block', objectFit: 'contain' }} />}
            <div style={{ width: 170, borderBottom: `1px solid ${MUTED}`, height: data.signatureUrl ? 4 : 26 }} />
            <L data={data} k="authorizedSignatory" style={{ fontSize: f(1), color: MUTED, display: 'block', marginTop: 4 }} />
          </div>
        </div>
      )}

      {/* ── Footer: entirely settings-driven, same block everywhere ──── */}
      <div style={{ borderTop: `1px dashed ${RULE}`, marginTop: thermal ? 12 : 28, paddingTop: thermal ? 10 : 16, textAlign: 'center' }}>
        {data.instructions && (
          <div dir="rtl" style={{ ...urduFont, fontSize: f(1.05), lineHeight: 1.9, color: MUTED }}>{data.instructions}</div>
        )}
        {data.fundNote && (
          <div dir="rtl" style={{ ...urduFont, fontSize: f(1.05), lineHeight: 1.9, color: MUTED, marginTop: 4 }}>{data.fundNote}</div>
        )}

        {(helplines.length > 0 || complaints.length > 0) && (
          // The box used to be an RTL container that left-aligned nothing
          // consistently: the English sentence was force-right-aligned even
          // though it is LTR prose, and — worse — it printed "Call or WhatsApp
          // this number for any water supply issue" with no number on that line
          // at all, because the digits were only ever attached to the Urdu row.
          // An English reader was pointed at nothing.
          //
          // Centring the whole box removes the bidi problem rather than tuning
          // around it. There is no leading edge to fight over, each number sits
          // directly under the label that explains it in every display mode,
          // and it matches the footer around it, which is centred already.
          <div
            style={{
              background: '#e6f4ea', borderRadius: 8, color: '#14532d',
              padding: thermal ? '8px 8px' : '12px 16px', marginTop: 12,
              textAlign: 'center',
            }}
          >
            {helplines.length > 0 && (
              <ContactRow en={helpEn} ur={helpUr} numbers={helplines} font={boxFont} />
            )}
            {helplines.length > 0 && complaints.length > 0 && (
              <div style={{ borderTop: '1px solid #c2e2d0', marginTop: 7, paddingTop: 7 }} />
            )}
            {complaints.length > 0 && (
              <ContactRow en={cmpEn} ur={cmpUr} numbers={complaints} font={boxFont} />
            )}
          </div>
        )}

        {!thermal && contacts.length > 0 && (
          <div style={{ marginTop: 10, fontSize: f(1), color: MUTED }}>
            {contacts.map((c, i) => (
              <div key={i}>
                <strong style={{ color: INK }}>{c.name}</strong>
                {c.designation ? ` — ${c.designation}` : ''}
                {c.whatsapp ? <> — <PhoneLink number={c.whatsapp} /></> : null}
              </div>
            ))}
          </div>
        )}

        {/* Branded icon row — icon plus a small caption, so a reader who doesn't
            recognise a glyph still knows what it opens. Never raw URLs here;
            the full address stays in the href. Dropped for donor/donation
            receipts specifically (per the committee's own request) — kept
            for water bills/vouchers/salary slips, which weren't part of that
            ask. */}
        {!isDonorSystem && iconLinks.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: thermal ? 8 : iconGap, marginTop: thermal ? 10 : 16 }}>
            {iconLinks.map((l) => (
              <a
                key={l.name} href={l.href} target="_blank" rel="noopener noreferrer"
                // Three to a row on the roll (3 × 47 + gaps just clears the
                // 161px of content width), which buys each caption enough room
                // that "Chat with us / ہم سے بات کریں" stops fraying into
                // three lines.
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, textDecoration: 'none', width: thermal ? 47 : iconCell }}
              >
                <SlipIcon name={l.name} size={thermal ? 15 : 20} />
                {/* Same legibility floor as the rest of the thermal type — a
                    7px Nastaliq caption is a smudge at 203dpi. */}
                <LStack data={data} k={l.key} size={Math.max(f(0.72), thermal ? 8 : 7)} />
              </a>
            ))}
          </div>
        )}

        {!thermal && data.companyEmail && (
          <div style={{ fontSize: f(0.92), color: MUTED, marginTop: 10 }}>
            <Ltr>{prettyUrl(data.companyEmail)}</Ltr>
          </div>
        )}
      </div>
    </div>
  )
})
