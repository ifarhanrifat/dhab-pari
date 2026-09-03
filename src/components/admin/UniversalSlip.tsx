'use client'

import { forwardRef } from 'react'
import { dtBoth, type DocStringKey, type SlipLang } from '@/lib/docTranslations'
import { fmt, fmtDate, Ltr, PhoneLink, prettyUrl, splitNumbers, waHref } from './slipShared'
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
// receipt renders to A4 (794px ≈ A4 at 96dpi) or to a 58/80mm Bluetooth
// thermal roll (302px). Nothing about the stored transaction changes.

interface Props {
  data: ReceiptData
  format?: SlipFormat
}

// Prints "English / اردو" when the slip is in bilingual mode, one script
// otherwise. Kept as a component rather than a joined string because the two
// scripts need different fonts and independent bidi handling.
function L({ data, k, className = '', style }: { data: ReceiptData; k: DocStringKey; className?: string; style?: React.CSSProperties }) {
  const mode: SlipLang = data.slipDisplayMode ?? 'both'
  const { en, ur } = dtBoth(mode, k)
  return (
    <span className={className} style={style}>
      {en && <span>{en.trim().replace(/:$/, '')}</span>}
      {en && ur && <span style={{ opacity: 0.55 }}> / </span>}
      {/* Nastaliq renders visibly larger than the Latin face at the same
          pixel size — sized down (em, so it scales with whatever this
          label's own size is) rather than up, so a bilingual pair like
          "Paid To / ادائیگی بنام" doesn't read as the Urdu half shouting
          over the English half. */}
      {ur && <span style={{ fontFamily: 'var(--font-urdu), serif', fontSize: '0.82em' }}>{ur.trim().replace(/:$/, '')}</span>}
    </span>
  )
}

// In a ~70px icon caption the inline "English / اردو" form wraps mid-phrase.
// Stack the two scripts on their own lines there instead.
//
// The pair's own digits always run left-to-right (a phone number doesn't
// reverse in Urdu) — what changes is which side the icon sits on: English
// reads left-to-right, so the icon leads (icon, then number); Urdu reads
// right-to-left, so the icon should trail on the right of the number
// instead — reversing the DOM order inside this still-LTR flex row is
// what actually moves it there.
function WaNumber({ number, size, gap, reverse = false }: { number: string; size: number; gap: number; reverse?: boolean }) {
  const href = waHref(number)
  const icon = <SlipIcon name="whatsapp" size={size} />
  const digits = <Ltr style={{ fontWeight: 700 }}>{number}</Ltr>
  const pair = (
    <span dir="ltr" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {reverse ? <>{digits}{icon}</> : <>{icon}{digits}</>}
    </span>
  )
  const body = <span style={{ marginInlineStart: gap, display: 'inline-block' }}>{pair}</span>
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{body}</a> : body
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
  // Thermal paper is a quarter the width of A4; type has to come down with it
  // or a single line wraps three times.
  const k = thermal ? 0.78 : 1
  const h = (n: number) => Math.round(fH * n * k)
  const b = (n: number) => Math.round(fB * n * k)
  const f = (n: number) => Math.round(fF * n * k)

  const logoPx = thermal ? 38 : (data.logoWidth ?? 56)
  const width = thermal ? 302 : 794
  const pad = thermal ? 18 : 48

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

  // Bilingual is roughly double the characters of one language, so it needs the
  // extra step down to stay on a single line inside the box.
  // Split into its own rows rather than one bilingual sentence, so the box has
  // room for the full wording at a readable size.
  const boxFont = thermal ? f(0.9) : f(1)
  // whiteSpace was 'nowrap' to keep each line tight, but that forced a long
  // label + number + icon combination wider than the box itself to overflow
  // right out of the green background instead of wrapping inside it —
  // exactly the "number is displaying outside the green belt" bug. Letting
  // it wrap keeps everything inside the box's own painted area, which
  // matters far more than staying on one line.
  const boxRow: React.CSSProperties = { fontSize: boxFont, color: '#14532d', lineHeight: 2, whiteSpace: 'normal' }
  const waSize = Math.round(boxFont * 1.15)
  const waGap = thermal ? 6 : 12
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
  // Urdu is the leading script only when it is the chosen language; in
  // bilingual mode English leads, so the block stays left-aligned.
  const urduLed = mode !== 'en'
  // Label wraps if it must; the figure never does.
  const totalRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, lineHeight: 1.7 }
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
          The Urdu name is the organisation's actual name, so it leads and is
          the largest thing in the header; "Dhab Pari" is the short/English
          form and sits under it at the same weight and size as the system
          label. The block is optically centred in the row — the trailing
          spacer matches the logo's width so the logo doesn't drag it left. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: thermal ? 8 : 14, borderBottom: `2px solid ${INK}`, paddingBottom: thermal ? 10 : 18 }}>
        {data.logoUrl && (
          <img
            src={data.logoUrl} alt=""
            style={{ width: logoPx, height: logoPx, objectFit: 'contain', borderRadius: 6, flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
          {mode !== 'en' && data.companyNameUr && (
            <div style={{ ...urduFont, fontSize: h(1.3) - 3, fontWeight: 700, lineHeight: 1.75 }} dir="rtl">{data.companyNameUr}</div>
          )}
          <div style={{ fontSize: f(0.92), fontWeight: 400, letterSpacing: '0.08em', color: MUTED, lineHeight: 1.5 }}>
            {data.companyNameEn || SITE.name}
          </div>
          <div style={{ fontSize: f(0.92), fontWeight: 400, letterSpacing: '0.08em', textTransform: 'uppercase', color: MUTED, lineHeight: 1.5 }}>
            {data.systemLabel}
          </div>
        </div>
        {data.logoUrl && <div style={{ width: logoPx, flexShrink: 0 }} aria-hidden />}
      </div>

      {/* ── Type badge: the one thing that must be readable in half a
          second — a bill, a receipt, a payment voucher and a donation
          receipt otherwise share the exact same chrome. */}
      <div style={{ textAlign: 'center', marginTop: thermal ? 8 : 14 }}>
        <span
          style={{
            display: 'inline-block', padding: thermal ? '3px 11px' : '5px 18px', borderRadius: 999,
            fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontSize: Math.max(f(0.88), 10), background: kindAccent.bg, color: kindAccent.fg,
          }}
        >
          <L data={data} k={titleKey} />
        </span>
      </div>

      {/* ── Meta block ───────────────────────────────────────────────
          Date tucks under the header rule; then the party heading and the
          document heading share one row, and their two values share the next,
          so the eye reads straight across instead of down two columns. */}
      <div style={{ textAlign: 'right', fontSize: f(1), color: MUTED, marginTop: thermal ? 6 : 8 }}>
        <Ltr>{fmtDate(data.date)}</Ltr>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', columnGap: 16, marginTop: thermal ? 6 : 10 }}>
        <L data={data} k={partyKey} style={{ fontSize: f(1), color: MUTED }} />
        <L data={data} k={titleKey} style={{ fontSize: f(1), color: MUTED, textAlign: 'right' }} />

        <div style={{ fontWeight: 600, fontSize: b(1.15) - 2, minWidth: 0 }}>{data.accountName}</div>
        <div style={{ textAlign: 'right' }}>
          {unconfirmed
            ? <L data={data} k="notYetConfirmed" style={{ fontWeight: 700, fontSize: b(0.95), color: '#b3261e' }} />
            : <Ltr style={{ fontWeight: 700, fontSize: b(1.15) - 2 }}>{data.receiptNo}</Ltr>}
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
              <L data={data} k="earningsThisCycle" style={{ display: 'block', fontSize: f(0.95), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, borderBottom: `2px solid ${INK}`, paddingBottom: 6, lineHeight: 1.9 }} />
              {payroll!.earnings.map((e, i) => (
                <div key={i} style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', borderBottom: `1px solid ${RULE}`, fontSize: b(1) }}>
                  <span>{e.label}</span>
                  <Ltr style={moneyCell}>{money(e.amount)}</Ltr>
                </div>
              ))}
              <div style={{ ...totalRow, paddingTop: 8, fontWeight: 700, fontSize: b(1.05) }}>
                <L data={data} k="totalEarnings" />
                <Ltr style={moneyCell}>{money(payroll!.totalEarnings)}</Ltr>
              </div>
            </div>

            <div style={{ marginTop: thermal ? 14 : 0 }}>
              <L data={data} k="settlement" style={{ display: 'block', fontSize: f(0.95), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, borderBottom: `2px solid ${INK}`, paddingBottom: 6, lineHeight: 1.9 }} />
              <div style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', borderBottom: `1px solid ${RULE}`, fontSize: b(1) }}>
                <L data={data} k="balanceOwed" />
                <Ltr style={moneyCell}>{money(payroll!.balanceOwed)}</Ltr>
              </div>
              <div style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', borderBottom: `1px solid ${RULE}`, fontSize: b(1), color: '#0f7a4d' }}>
                <L data={data} k="paidNow" />
                <Ltr style={moneyCell}>− {money(payroll!.paidNow)}</Ltr>
              </div>
              <div style={{ ...totalRow, padding: thermal ? '5px 0' : '8px 0', fontSize: b(1) }}>
                <L data={data} k="carriedForward" />
                <Ltr style={moneyCell}>{money(payroll!.carriedForward)}</Ltr>
              </div>
            </div>
          </div>

          {/* Net Pay is the cash actually leaving the committee today — the
              number the employee signs for, not the accrued total. */}
          <div style={{ marginTop: thermal ? 10 : 22, paddingTop: thermal ? 8 : 14, borderTop: `2px solid ${INK}`, display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: thermal ? '100%' : 360, ...totalRow, fontWeight: 700, fontSize: b(1.35) }}>
              <L data={data} k="netPay" />
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
                  <L data={data} k="description" />
                </th>
                <th style={{ textAlign: 'right', paddingBottom: 6, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9 }}>
                  <L data={data} k="amount" />
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
                  <td style={{ padding: thermal ? '5px 0' : '9px 0', textAlign: 'right', fontSize: b(1), whiteSpace: 'nowrap' }}><Ltr>{money(row.amount)}</Ltr></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: thermal ? 8 : 18, paddingTop: thermal ? 8 : 12, borderTop: `2px solid ${INK}`, display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: thermal ? '100%' : 360 }}>
              {discount > 0 && (
                <div style={totalRow} >
                  <L data={data} k="discount" style={{ color: '#0f7a4d', fontSize: b(1) }} />
                  <Ltr style={{ ...moneyCell, color: '#0f7a4d', fontSize: b(1) }}>− {money(discount)}</Ltr>
                </div>
              )}
              <div style={{ ...totalRow, marginTop: discount > 0 ? 4 : 0 }}>
                <L data={data} k="totalPayable" style={{ fontWeight: 700, fontSize: b(1.25) }} />
                <Ltr style={{ ...moneyCell, fontWeight: 700, fontSize: b(1.25) }}>{money(data.amount)}</Ltr>
              </div>
              {paid > 0 && (
                <>
                  <div style={{ ...totalRow, marginTop: 6 }}>
                    <L data={data} k="paid" style={{ color: '#0f7a4d', fontSize: b(1) }} />
                    <Ltr style={{ ...moneyCell, color: '#0f7a4d', fontSize: b(1) }}>{money(paid)}</Ltr>
                  </div>
                  <div style={{ ...totalRow, marginTop: 3 }}>
                    <L data={data} k="balanceDue" style={{ color: '#b3261e', fontSize: b(1) }} />
                    <Ltr style={{ ...moneyCell, color: '#b3261e', fontSize: b(1) }}>{money(Math.max(data.amount - paid, 0))}</Ltr>
                  </div>
                </>
              )}
            </div>
          </div>

          {(data.securityDepositAmount ?? 0) > 0 && (
            <div style={{ marginTop: thermal ? 8 : 16, background: '#f2f4f6', borderRadius: 6, padding: thermal ? '8px 10px' : '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <L data={data} k={thermal ? 'depositRefundableSeparate' : 'securityDepositNote'} style={{ fontSize: f(1), color: MUTED }} />
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
                  <L data={data} k="particular" />
                </th>
                <th style={{ textAlign: 'right', paddingBottom: 6, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9, width: thermal ? 64 : 110 }}>
                  <L data={data} k="debit" />
                </th>
                <th style={{ textAlign: 'right', paddingBottom: 6, fontSize: f(0.92), textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, fontWeight: 600, lineHeight: 1.9, width: thermal ? 64 : 110 }}>
                  <L data={data} k="credit" />
                </th>
              </tr>
            </thead>
            <tbody>
              {data.paidFromName && (
                <>
                  <tr>
                    <td colSpan={3} style={{ paddingTop: thermal ? 6 : 12, paddingBottom: 2, fontSize: b(0.95), fontWeight: 700, fontStyle: 'italic' }}>
                      <L data={data} k="paidFrom" />
                    </td>
                  </tr>
                  <tr style={{ borderBottom: `1px solid ${RULE}` }}>
                    <td style={{ padding: thermal ? '5px 0' : '9px 0', fontSize: b(1) }}>{data.paidFromName}</td>
                    <td style={{ padding: thermal ? '5px 0' : '9px 0' }} />
                    <td style={{ padding: thermal ? '5px 0' : '9px 0', textAlign: 'right', fontSize: b(1), whiteSpace: 'nowrap' }}><Ltr>{money(data.amount)}</Ltr></td>
                  </tr>
                </>
              )}
              <tr>
                <td colSpan={3} style={{ paddingTop: thermal ? 10 : 16, paddingBottom: 2, fontSize: b(0.95), fontWeight: 700, fontStyle: 'italic' }}>
                  <L data={data} k="paidTo" />
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
                  <td style={{ padding: thermal ? '5px 0' : '9px 0', textAlign: 'right', fontSize: b(1), whiteSpace: 'nowrap' }}><Ltr>{money(row.amount)}</Ltr></td>
                  <td style={{ padding: thermal ? '5px 0' : '9px 0' }} />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ paddingTop: thermal ? 8 : 14, fontWeight: 700, fontSize: b(1.1) }}><L data={data} k="total" /></td>
                <td style={{ paddingTop: thermal ? 8 : 14, textAlign: 'right', fontWeight: 700, fontSize: b(1.1) }}><Ltr>{money(data.amount)}</Ltr></td>
                <td style={{ paddingTop: thermal ? 8 : 14, textAlign: 'right', fontWeight: 700, fontSize: b(1.1) }}><Ltr>{money(data.amount)}</Ltr></td>
              </tr>
            </tfoot>
          </table>
          {data.particular && (
            <div style={{ marginTop: thermal ? 8 : 16, fontSize: b(1) }}>
              <L data={data} k="remarks" style={{ color: MUTED, fontWeight: 600 }} />{' '}{data.particular}
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
            <div style={{ fontSize: f(1.05), color: MUTED, marginTop: 6 }}>
              <L data={data} k="remarks" style={{ fontWeight: 600 }} />{' '}{data.particular}
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
                  <L data={data} k={row.k} style={{ fontSize: f(1.05), color: MUTED, lineHeight: 1.7 }} />
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
          // Urdu reads right-to-left, so in Urdu mode the label starts at the
          // right edge and its number follows immediately on the same line —
          // no colon, no gap between the wording and the digits.
          <div
            dir={urduLed ? 'rtl' : 'ltr'}
            style={{
              display: 'block', background: '#e6f4ea', borderRadius: 8,
              padding: thermal ? '7px 10px' : '10px 16px', marginTop: 12,
              textAlign: urduLed ? 'right' : 'left',
            }}
          >
            {helplines.length > 0 && helpEn && (
              <div dir="ltr" style={{ ...boxRow, textAlign: urduLed ? 'right' : 'left' }}>{helpEn}</div>
            )}
            {helplines.length > 0 && helpUr && (
              <div dir="rtl" style={{ ...boxRow, ...urduFont, textAlign: 'right' }}>
                {helpUr}
                {helplines.map((n) => <WaNumber key={n} number={n} size={waSize} gap={waGap} reverse />)}
              </div>
            )}
            {helplines.length > 0 && !helpUr && helpEn && (
              <div dir="ltr" style={{ ...boxRow, textAlign: urduLed ? 'right' : 'left' }}>
                {helplines.map((n) => <WaNumber key={n} number={n} size={waSize} gap={0} />)}
              </div>
            )}
            {complaints.length > 0 && (
              <div dir={urduLed ? 'rtl' : 'ltr'} style={{ ...boxRow, textAlign: urduLed ? 'right' : 'left' }}>
                {cmpEn && <span dir="ltr" style={{ display: 'inline-block' }}>{cmpEn}</span>}
                {cmpEn && cmpUr && <span style={{ opacity: 0.55 }}> / </span>}
                {cmpUr && <span dir="rtl" style={{ ...urduFont, display: 'inline-block' }}>{cmpUr}</span>}
                {complaints.map((n) => <WaNumber key={n} number={n} size={waSize} gap={waGap} reverse={urduLed} />)}
              </div>
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
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, textDecoration: 'none', width: thermal ? 42 : iconCell }}
              >
                <SlipIcon name={l.name} size={thermal ? 15 : 20} />
                <LStack data={data} k={l.key} size={Math.max(f(0.72), 7)} />
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
