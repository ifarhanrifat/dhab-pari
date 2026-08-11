'use client'

import { forwardRef } from 'react'
import { dt, type Lang, type SlipLang } from '@/lib/docTranslations'
import { UniversalSlip, type SlipFormat } from './UniversalSlip'
import { fmt, fmtDate, Ltr, PhoneLink, prettyUrl, splitNumbers } from './slipShared'
import { SITE } from '@/lib/constants'

export type InvoiceTemplate =
  | 'universal'
  | 'classic' | 'modern' | 'minimal' | 'detailed' | 'compact'
  | 'ledger' | 'cardSections' | 'boldBand' | 'twoColumn' | 'statement'

export interface ReceiptLineItem { description: string; quantity: number; unitPrice: number }

export interface ManagementContact { name: string; designation: string; whatsapp: string }

export interface ReceiptData {
  kind: 'bill' | 'payment' | 'donation' | 'manual' | 'purchase_payment' | 'salary'
  receiptNo: string
  date: string
  dueDate?: string | null
  billingPeriod?: string | null
  systemLabel: string
  accountName: string
  accountNameUr?: string | null
  accountAddress?: string | null
  accountPhone?: string | null
  particular: string
  amount: number
  // For a donation this is the donor's lifetime total INCLUDING this receipt
  // (see donor_receipt_totals()); for a bill/payment it is the outstanding
  // balance left on the account afterwards.
  balanceAfter: number
  // Donation receipts only: announced/pledged but not yet collected.
  announcedRemaining?: number | null
  // Donation receipts only: which project the money is earmarked for.
  projectName?: string | null
  paidAmount?: number
  billOutstandingAfter?: number | null
  lineItems?: ReceiptLineItem[]
  discountAmount?: number
  securityDepositAmount?: number
  securityDepositReceiptNo?: string | null
  logoUrl?: string | null
  logoWidth?: number
  logoOffsetY?: number
  signatureUrl?: string | null
  helplineNumbers?: string | null
  instructions?: string | null
  // "If your own records don't match this receipt, call/WhatsApp the helpline" —
  // editable per system from Settings (receipt_fund_note / donor_receipt_fund_note).
  fundNote?: string | null
  language?: 'en' | 'ur'
  companyNameEn?: string
  companyNameUr?: string
  companyEmail?: string
  footerComplaintNumber?: string | null
  footerManagementContacts?: ManagementContact[]
  footerFacebookLink?: string | null
  footerWhatsappGroupLink?: string | null
  footerProjectsLink?: string | null
  footerDonationLink?: string | null
  footerWebsiteLink?: string | null
  footerWhatsappChat?: string | null
  // Admin-editable green-box wording (migration 174); blank falls back to the
  // built-in strings in docTranslations.
  helplineLabelEn?: string | null
  helplineLabelUr?: string | null
  complaintLabelEn?: string | null
  complaintLabelUr?: string | null
  footerSuggestionsLink?: string | null
  footerComplaintsLink?: string | null
  // Donation receipts: false when the donation has not been confirmed yet, so
  // the slip can say so instead of printing a blank number and a zero total.
  isConfirmed?: boolean
  collectedByName?: string | null
  // Universal Slip only (migration 172) — bilingual label mode and the three
  // admin-tunable type tiers. Ignored by the ten legacy skins.
  slipDisplayMode?: SlipLang
  slipFontHeading?: number
  slipFontBody?: number
  slipFontFooter?: number
  // Payroll body (kind: 'salary'), Universal Slip only.
  payroll?: {
    designation?: string | null
    earnings: { label: string; amount: number }[]
    totalEarnings: number
    balanceOwed: number
    paidNow: number
    carriedForward: number
  }
}

interface Props { data: ReceiptData; template?: InvoiceTemplate; format?: SlipFormat }

// Sized and vertically nudged from Settings (Branding) — always absolutely
// positioned in the top-left corner of its (relative) header container, so it never
// drags the centered company heading off to one side.
function Logo({ data, className = '' }: { data: ReceiptData; className?: string }) {
  if (!data.logoUrl) return null
  const size = data.logoWidth ?? 56
  return (
    <img
      src={data.logoUrl} alt="Logo"
      className={`absolute start-0 top-0 object-contain ${className}`}
      style={{ width: size, height: size, marginTop: data.logoOffsetY ?? 0 }}
    />
  )
}

// The logo sits absolutely in the top-left corner, so centered heading text
// slides underneath it and clips the first letter ("Dhab Pari" losing its D).
// Reserve the logo's width on BOTH sides so the heading clears it and still
// reads as optically centered.
function LogoGutter({ data, children, className = '' }: { data: ReceiptData; children: React.ReactNode; className?: string }) {
  const pad = data.logoUrl ? (data.logoWidth ?? 56) + 12 : 0
  return (
    <div className={className} style={pad ? { paddingLeft: pad, paddingRight: pad } : undefined}>
      {children}
    </div>
  )
}

function Signature({ data }: { data: ReceiptData }) {
  const lang: Lang = data.language ?? 'en'
  return (
    <div className="text-end text-[12px] inline-block">
      {data.signatureUrl && <img src={data.signatureUrl} alt="Signature" className="h-10 ms-auto mb-1 object-contain" />}
      <p className="border-t border-dp-outline-variant pt-1">{dt(lang, 'authorizedSignatory')}</p>
    </div>
  )
}

// Everything here is admin-editable from Settings — contact/complaint numbers, the
// management team to reach out to, and social/project links.
//
// Laid out as label→value rows rather than a bare list of link words: someone
// holding a printed receipt should be told what each address is FOR ("Join our
// WhatsApp group"), with the address itself on the same line. Renders
// end-to-left in Urdu font when the site's display language is Urdu.
//
// Real anchors throughout, so they're clickable wherever the receipt is viewed
// as HTML (on-screen preview, print popup). The PDF/PNG download path
// rasterizes via html2canvas, so in a downloaded/shared file these stay visible
// but aren't tappable — a limitation of image export, not of this markup.
function Footer({ data }: { data: ReceiptData }) {
  const lang: Lang = data.language ?? 'en'
  const isUrdu = lang === 'ur'
  const contacts = data.footerManagementContacts ?? []
  const helplines = splitNumbers(data.helplineNumbers)
  const complaints = splitNumbers(data.footerComplaintNumber)

  const connectRows: { label: string; href: string }[] = []
  if (data.footerFacebookLink) connectRows.push({ label: dt(lang, 'joinFacebookPage'), href: data.footerFacebookLink })
  if (data.footerWhatsappGroupLink) connectRows.push({ label: dt(lang, 'joinWhatsappGroup'), href: data.footerWhatsappGroupLink })
  if (data.footerProjectsLink) connectRows.push({ label: dt(lang, 'seeCurrentProjects'), href: data.footerProjectsLink })
  if (data.footerDonationLink) connectRows.push({ label: dt(lang, 'donateOnline'), href: data.footerDonationLink })
  if (data.companyEmail) connectRows.push({ label: dt(lang, 'emailUs'), href: `mailto:${data.companyEmail}` })

  const hasAnything = helplines.length > 0 || data.instructions || data.fundNote
    || complaints.length > 0 || contacts.length > 0 || connectRows.length > 0
  if (!hasAnything) return null

  return (
    <div
      className="border-t border-dp-outline-variant mt-5 pt-3 text-[10.5px] leading-[1.6] text-dp-on-surface-variant"
      dir={isUrdu ? 'rtl' : 'ltr'}
      style={isUrdu ? { fontFamily: 'var(--font-urdu), serif', textAlign: 'right' } : { textAlign: 'left' }}
    >
      {(data.instructions || data.fundNote) && (
        <div className="mb-2 space-y-1">
          {data.instructions && <p>{data.instructions}</p>}
          {data.fundNote && <p>{data.fundNote}</p>}
        </div>
      )}

      {(helplines.length > 0 || complaints.length > 0) && (
        <div className="rounded-md bg-dp-surface-container-low px-3 py-2 mb-2 space-y-0.5">
          {helplines.length > 0 && (
            <p className="font-semibold text-dp-on-surface">
              {(lang === 'ur' ? data.helplineLabelUr : data.helplineLabelEn)?.trim()
                || dt(lang, data.kind === 'donation' ? 'helplineDonation' : 'helplineWater').replace(/:\s*$/, '')}
              {': '}
              {helplines.map((n, i) => (
                <span key={n}>{i > 0 && <span className="mx-1">·</span>}<PhoneLink number={n} className="font-semibold" /></span>
              ))}
            </p>
          )}
          {complaints.length > 0 && (
            <p className="font-semibold text-dp-on-surface">
              {(lang === 'ur' ? data.complaintLabelUr : data.complaintLabelEn)?.trim() || dt(lang, 'complaint').replace(/:\s*$/, '')}
              {': '}
              {complaints.map((n, i) => (
                <span key={n}>{i > 0 && <span className="mx-1">·</span>}<PhoneLink number={n} className="font-semibold" /></span>
              ))}
            </p>
          )}
        </div>
      )}

      {contacts.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {contacts.map((c, i) => (
            <p key={i}>
              <span className="font-semibold text-dp-on-surface">{c.name}</span>
              {c.designation ? <span> — {c.designation}</span> : null}
              {c.whatsapp ? <> — <PhoneLink number={c.whatsapp} /></> : null}
            </p>
          ))}
        </div>
      )}

      {connectRows.length > 0 && (
        <div>
          <p className="font-semibold text-dp-on-surface mb-0.5">{dt(lang, 'stayConnected')}</p>
          <div className="space-y-0.5">
            {connectRows.map((r) => (
              <p key={r.href} className="flex items-baseline gap-x-1.5">
                <span className="shrink-0">{r.label}</span>
                <span className="flex-1 border-b border-dotted border-dp-outline-variant/70 translate-y-[-2px]" />
                <a
                  href={r.href} target="_blank" rel="noopener noreferrer"
                  className="text-dp-secondary shrink-0 max-w-[58%] truncate text-[10px]"
                >
                  <Ltr className="max-w-full truncate">{prettyUrl(r.href)}</Ltr>
                </a>
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Renders the money story exactly once — Subtotal (only if there's a discount to
// explain), Discount, Total Payable, and Paid/Balance Due (only when something has
// actually been paid — an unpaid bill just shows Total Payable, not the same number
// twice under two labels).
function BillSummary({ data }: { data: ReceiptData }) {
  const lang: Lang = data.language ?? 'en'
  const subtotal = data.lineItems && data.lineItems.length > 0
    ? data.lineItems.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
    : data.amount + (data.discountAmount ?? 0)
  const discount = data.discountAmount ?? 0
  const paid = data.paidAmount ?? 0
  return (
    <div className="font-sans text-[13px] space-y-1">
      {discount > 0 && (
        <div className="flex justify-between text-dp-on-surface-variant">
          <span>{dt(lang, 'subtotal')}</span><span>Rs. {fmt(subtotal)}</span>
        </div>
      )}
      {discount > 0 && (
        <div className="flex justify-between text-emerald-700">
          <span>{dt(lang, 'discount')}</span><span>− Rs. {fmt(discount)}</span>
        </div>
      )}
      <div className="flex justify-between font-bold text-[15px] border-t border-dp-outline-variant pt-1.5 mt-1">
        <span>{dt(lang, 'totalPayable')}</span><span>Rs. {fmt(data.amount)}</span>
      </div>
      {paid > 0 && (
        <>
          <div className="flex justify-between text-emerald-700">
            <span>{dt(lang, 'paid')}</span><span>Rs. {fmt(paid)}</span>
          </div>
          <div className="flex justify-between font-bold text-dp-error">
            <span>{dt(lang, 'balanceDue')}</span><span>Rs. {fmt(Math.max(data.amount - paid, 0))}</span>
          </div>
        </>
      )}
    </div>
  )
}

// Kept visually and semantically separate from Total Payable above — a security
// deposit is a refundable liability the committee holds, not part of what's owed on
// this bill, so it must never read as if it adds to the amount due.
function DepositBox({ data }: { data: ReceiptData }) {
  const lang: Lang = data.language ?? 'en'
  if (!data.securityDepositAmount || data.securityDepositAmount <= 0) return null
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[12px] text-amber-900 flex justify-between items-center gap-3">
      <span>
        {dt(lang, 'securityDepositNote')}
        {data.securityDepositReceiptNo && <span className="block font-semibold">{dt(lang, 'receiptHash')}{data.securityDepositReceiptNo}</span>}
      </span>
      <span className="font-bold whitespace-nowrap">Rs. {fmt(data.securityDepositAmount)}</span>
    </div>
  )
}

// Which project the donation is earmarked for — a donor looking at this receipt
// months later should not have to guess. Falls back to "General Fund" for
// unearmarked giving. The donation-side counterpart of BillingPeriod below, and
// rendered in the same slot in every template.
function ProjectLine({ data, className = '' }: { data: ReceiptData; className?: string }) {
  const lang: Lang = data.language ?? 'en'
  if (data.kind !== 'donation') return null
  return (
    <p className={`font-sans text-[12.5px] ${className}`}>
      <span className="text-dp-on-surface-variant">{dt(lang, 'forProject')}: </span>
      <span className="font-semibold text-dp-on-surface">{data.projectName || dt(lang, 'generalFund')}</span>
    </p>
  )
}

function BillingPeriod({ data, className = '' }: { data: ReceiptData; className?: string }) {
  const lang: Lang = data.language ?? 'en'
  if (data.kind !== 'bill' || !data.billingPeriod) return null
  return <p className={`font-sans text-[12.5px] font-semibold text-dp-on-surface-variant ${className}`}>{dt(lang, 'billingPeriod')}{data.billingPeriod}</p>
}

// A bill is "paid"/"partial" based on paidAmount vs. what's payable. A cash receipt
// (kind: 'payment') needs the linked bill's own remaining balance, passed explicitly
// as billOutstandingAfter — NOT the generic balanceAfter, which on the account
// statement is a running balance across every entry on the account (bills, other
// payments, donations, manual entries), not this one bill's outstanding amount, and
// would misclassify receipts whenever the account carries any other activity.
// Donations and manual entries have no "owed" concept, so no stamp applies to them.
function paymentStatus(data: ReceiptData): 'paid' | 'partial' | null {
  if (data.kind === 'bill') {
    const paid = data.paidAmount ?? 0
    if (paid <= 0) return null
    return paid >= data.amount ? 'paid' : 'partial'
  }
  if (data.kind === 'payment' && data.billOutstandingAfter != null) {
    return data.billOutstandingAfter <= 0 ? 'paid' : 'partial'
  }
  return null
}

function PaymentStamp({ data, compact = false }: { data: ReceiptData; compact?: boolean }) {
  const lang: Lang = data.language ?? 'en'
  const status = paymentStatus(data)
  if (!status) return null
  const label = status === 'paid' ? dt(lang, 'paidStamp') : dt(lang, 'partialPaymentStamp')
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-20 overflow-hidden">
      <span
        className="border-[3px] border-eed-600 text-red-600 font-extrabold uppercase text-center"
        style={{
          transform: 'rotate(-18deg)',
          opacity: 0.72,
          fontSize: compact ? 15 : status === 'paid' ? 34 : 21,
          letterSpacing: compact ? '0.08em' : '0.12em',
          padding: compact ? '3px 8px' : '8px 18px',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-sans), sans-serif',
        }}
      >
        {label}
      </span>
    </div>
  )
}

export const ReceiptDocument = forwardRef<HTMLDivElement, Props>(function ReceiptDocument({ data, template = 'classic', format = 'a4' }, ref) {
  // The Universal Slip is its own document — one design that covers every
  // transaction type and both print targets. The ten skins below stay
  // available as alternates.
  if (template === 'universal') return <UniversalSlip ref={ref} data={data} format={format} />

  const lang: Lang = data.language ?? 'en'
  const isBill = data.kind === 'bill'
  const isPurchasePayment = data.kind === 'purchase_payment'
  const isCredit = data.kind === 'payment' || data.kind === 'donation'
  const isDonation = data.kind === 'donation'
  const title = isBill ? dt(lang, 'titleBill') : isPurchasePayment ? dt(lang, 'titlePaymentVoucher') : dt(lang, 'titleReceipt')
  // On a donation receipt "Total" means the amount just received, and the
  // running figure below it is the donor's lifetime total — both need donation
  // wording, not the generic Total/Outstanding pair a water bill uses.
  const totalLabel = isDonation ? dt(lang, 'donationReceived') : dt(lang, 'total')
  const totalLabelCaps = isBill ? dt(lang, 'totalPayableCaps') : isDonation ? dt(lang, 'donationReceived') : dt(lang, 'totalCaps')
  const balanceLabel = isDonation ? dt(lang, 'totalContributed') : dt(lang, 'outstandingAmount')
  // Announced but not yet collected — printed on donation receipts in the same
  // slot a water bill uses for the consumer's outstanding amount. Hidden when
  // the donor has nothing outstanding, so an ordinary receipt stays clean.
  const announcedRemaining = isDonation ? (data.announcedRemaining ?? 0) : 0
  const showAnnounced = announcedRemaining > 0
  const announcedLabel = dt(lang, 'announcedRemaining')
  // "Donor" for a donation, "Received From" for other cash coming in, "Paid To"
  // for cash going out to a vendor, "Billed To"/"Customer/Debtor" only for an
  // actual bill being issued to a consumer.
  // The short "From/To" heading some templates use needs the same donation
  // vocabulary as the long one — a bare "از" says nothing about a donor.
  const fromLabel = isDonation ? dt(lang, 'donor') : isCredit ? dt(lang, 'from') : dt(lang, 'to')
  const partyLabelFull = isPurchasePayment ? dt(lang, 'paidTo') : isDonation ? dt(lang, 'donor') : isCredit ? dt(lang, 'receivedFrom') : dt(lang, 'billedTo')
  const partyLabelShort = isPurchasePayment ? dt(lang, 'vendor') : isDonation ? dt(lang, 'donor') : isCredit ? dt(lang, 'customerDebtor') : dt(lang, 'billedTo')
  const partyLine = isPurchasePayment ? `${dt(lang, 'paidToLine')}${data.accountName}` : isDonation ? `${dt(lang, 'receivedWithThanksFromDonor')}${data.accountName}` : isCredit ? `${dt(lang, 'receivedWithThanksFrom')}${data.accountName}` : `${dt(lang, 'amountBilledTo')}${data.accountName}`
  const hasDiscount = !!data.discountAmount && data.discountAmount > 0
  const showUrdu = data.language === 'ur'
  const logoPad = data.logoUrl ? (data.logoWidth ?? 56) + 12 : 0
  const companyNameEn = data.companyNameEn || SITE.name
  const companyNameUr = data.companyNameUr || 'واٹر اینڈ ویلفئیر کمیٹی'
  const companyEmail = data.companyEmail || 'dhabpariwelfare@gmail.com'

  if (template === 'modern') {
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white w-[520px] font-sans text-dp-on-surface overflow-hidden rounded-lg" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="bg-dp-primary text-white p-6 relative">
          <Logo data={data} className="rounded bg-white/10 p-1" />
          <LogoGutter data={data} className="text-center">
            {showUrdu && <p className="text-[13px] opacity-80 mb-1" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
            <p className="text-[22px] font-bold">{companyNameEn}</p>
            <p className="text-[12px] opacity-80">{data.systemLabel}</p>
          </LogoGutter>
          <div className="flex justify-between items-end mt-4">
            <div>
              <p className="text-[11px] uppercase tracking-widest opacity-70">{title}</p>
              <p className="text-[16px] font-bold">{data.receiptNo}</p>
            </div>
            <div className="text-end">
              <p className="text-[12px] opacity-80">{fmtDate(data.date)}</p>
              {data.dueDate && <p className="text-[11px] opacity-70">{dt(lang, 'due')}{fmtDate(data.dueDate)}</p>}
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="bg-dp-surface-container-low rounded-lg p-4 mb-4">
            <p className="text-[11px] uppercase tracking-widest text-dp-on-surface-variant font-bold">{partyLabelFull}</p>
            <p className="text-[16px] font-bold text-dp-primary">{data.accountName}</p>
            {showUrdu && data.accountNameUr && <p className="text-[13px]" style={{ fontFamily: 'var(--font-urdu), serif' }}>{data.accountNameUr}</p>}
            {data.accountAddress && <p className="text-[12px] text-dp-on-surface-variant mt-1">{data.accountAddress}</p>}
            {data.accountPhone && <p className="text-[12px] text-dp-on-surface-variant"><Ltr>{data.accountPhone}</Ltr></p>}
          </div>
          <BillingPeriod data={data} className="mb-3" />
          <ProjectLine data={data} className="mb-3" />
          {data.lineItems && data.lineItems.length > 0 && (
            <div className="space-y-1.5 mb-4">
              {data.lineItems.map((l, i) => (
                <div key={i} className="flex justify-between text-[13px]">
                  <span>{l.description} {l.quantity > 1 && <span className="text-dp-on-surface-variant">x{l.quantity}</span>}</span>
                  <span className="font-semibold">Rs. {fmt(l.quantity * l.unitPrice)}</span>
                </div>
              ))}
            </div>
          )}
          {!isBill && <p className="text-[13px] text-dp-on-surface-variant mb-1">{data.particular}</p>}
          {isBill && data.particular && <p className="text-[12.5px] text-dp-on-surface-variant mb-2 italic">{data.particular}</p>}

          {isBill ? (
            <div className="space-y-3">
              <BillSummary data={data} />
              <DepositBox data={data} />
            </div>
          ) : (
            <>
              {hasDiscount && (
                <div className="flex justify-between text-[13px] text-emerald-700 mb-1">
                  <span>{dt(lang, 'discount')}</span><span>− Rs. {fmt(data.discountAmount!)}</span>
                </div>
              )}
              {isDonation && <p className="text-[12px] text-dp-on-surface-variant mb-0.5">{totalLabel}</p>}
              <p className="text-[32px] font-bold text-dp-primary mb-4">Rs. {fmt(data.amount)}</p>
              <div className="flex justify-between border-t border-dp-outline-variant pt-3 text-[13px]">
                <span className="font-semibold text-dp-on-surface-variant">{balanceLabel}</span>
                <span className="font-bold">Rs. {fmt(Math.max(data.balanceAfter, 0))}</span>
              </div>
              {showAnnounced && (
                <div className="flex justify-between text-[13px] mt-1">
                  <span className="font-semibold text-dp-on-surface-variant">{announcedLabel}</span>
                  <span className="font-bold">Rs. {fmt(announcedRemaining)}</span>
                </div>
              )}
            </>
          )}
          <div className="flex justify-end mt-12">
            <Signature data={data} />
          </div>
          <Footer data={data} />
        </div>
      </div>
    )
  }

  if (template === 'minimal') {
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white p-10 w-[520px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative text-center mb-1">
          <Logo data={data} />
          <LogoGutter data={data}>
            <p className="text-[13px] tracking-[0.2em] uppercase text-dp-on-surface-variant">{companyNameEn} · {data.systemLabel}</p>
          </LogoGutter>
        </div>
        <p className="text-[26px] font-bold mb-8 text-center">{title} <span className="text-dp-on-surface-variant text-[15px] font-normal">{data.receiptNo}</span></p>
        <div className="grid grid-cols-2 gap-6 mb-6 text-[13px]">
          <div>
            <p className="text-dp-on-surface-variant mb-0.5">{fromLabel}</p>
            <p className="font-semibold">{data.accountName}</p>
            {data.accountAddress && <p className="text-dp-on-surface-variant text-[12px]">{data.accountAddress}</p>}
            {data.accountPhone && <p className="text-dp-on-surface-variant text-[12px]"><Ltr>{data.accountPhone}</Ltr></p>}
          </div>
          <div className="text-end">
            <p className="text-dp-on-surface-variant mb-0.5">{dt(lang, 'date')}</p>
            <p className="font-semibold">{fmtDate(data.date)}</p>
            {data.dueDate && <p className="text-[12px] text-dp-on-surface-variant">{dt(lang, 'due')}{fmtDate(data.dueDate)}</p>}
          </div>
        </div>
        <BillingPeriod data={data} className="mb-4" />
        <ProjectLine data={data} className="mb-4" />
        {data.lineItems && data.lineItems.length > 0 && (
          <div className="space-y-1.5 mb-6 text-[13px]">
            {data.lineItems.map((l, i) => (
              <div key={i} className="flex justify-between">
                <span>{l.description}{l.quantity > 1 && ` x${l.quantity}`}</span><span>{fmt(l.quantity * l.unitPrice)}</span>
              </div>
            ))}
          </div>
        )}
        {!isBill && <p className="text-[13px] text-dp-on-surface-variant mb-2">{data.particular}</p>}
        {isBill && data.particular && <p className="text-[12.5px] text-dp-on-surface-variant mb-3 italic">{data.particular}</p>}

        {isBill ? (
          <div className="space-y-3 mb-6">
            <BillSummary data={data} />
            <DepositBox data={data} />
          </div>
        ) : (
          <>
            {hasDiscount && <p className="text-[13px] text-emerald-700 mb-2">{dt(lang, 'discountAppliedColon')}{fmt(data.discountAmount!)}</p>}
            {isDonation && <p className="text-[12.5px] text-dp-on-surface-variant mb-0.5">{totalLabel}</p>}
            <p className="text-[40px] font-bold mb-6">Rs. {fmt(data.amount)}</p>
            <p className="text-[13px] text-dp-on-surface-variant">{balanceLabel}: <span className="font-bold text-dp-on-surface">Rs. {fmt(Math.max(data.balanceAfter, 0))}</span></p>
            {showAnnounced && <p className="text-[13px] text-dp-on-surface-variant mt-1">{announcedLabel}: <span className="font-bold text-dp-on-surface">Rs. {fmt(announcedRemaining)}</span></p>}
          </>
        )}
        <div className="flex justify-end mt-16">
          <Signature data={data} />
        </div>
        <Footer data={data} />
      </div>
    )
  }

  if (template === 'detailed') {
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white p-8 w-[560px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative text-center mb-4">
          <Logo data={data} />
          <LogoGutter data={data}>
            {showUrdu && <p className="text-[18px] font-bold mb-1.5" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
            <p className="text-[16px] font-bold">{companyNameEn}</p>
            <p className="text-[12px] text-dp-on-surface-variant">{data.systemLabel}</p>
          </LogoGutter>
        </div>
        <div className="flex justify-between text-[13px] border-y border-dp-outline-variant py-2 mb-4">
          <div>
            <p className="font-bold">{title} {dt(lang, 'noSuffix')}</p>
            <p>{data.receiptNo}</p>
          </div>
          <div className="text-center">
            <p className="font-bold">{partyLabelFull}</p>
            <p>{data.accountName}</p>
            {data.accountAddress && <p className="text-[12px] text-dp-on-surface-variant">{data.accountAddress}</p>}
            {data.accountPhone && <p className="text-[12px] text-dp-on-surface-variant"><Ltr>{data.accountPhone}</Ltr></p>}
          </div>
          <div className="text-end">
            <p className="font-bold">{dt(lang, 'date')}</p>
            <p>{fmtDate(data.date)}</p>
            {data.dueDate && <p className="text-[12px] text-dp-on-surface-variant">{dt(lang, 'due')}{fmtDate(data.dueDate)}</p>}
          </div>
        </div>
        <BillingPeriod data={data} className="mb-3" />
        <ProjectLine data={data} className="mb-3" />
        <table className="w-full text-[13px] mb-4">
          <thead>
            <tr className="border-b-2 border-dp-outline-variant text-start text-dp-on-surface-variant">
              <th className="py-1.5">{dt(lang, 'description')}</th>
              <th className="py-1.5 text-end">{dt(lang, 'qty')}</th>
              <th className="py-1.5 text-end">{dt(lang, 'rate')}</th>
              <th className="py-1.5 text-end">{dt(lang, 'amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.lineItems && data.lineItems.length > 0 ? (
              data.lineItems.map((l, i) => (
                <tr key={i} className="border-b border-dp-outline-variant">
                  <td className="py-1.5">{l.description}</td>
                  <td className="py-1.5 text-end">{l.quantity}</td>
                  <td className="py-1.5 text-end">{fmt(l.unitPrice)}</td>
                  <td className="py-1.5 text-end">{fmt(l.quantity * l.unitPrice)}</td>
                </tr>
              ))
            ) : (
              <tr className="border-b border-dp-outline-variant">
                <td className="py-1.5">{data.particular}</td>
                <td className="py-1.5 text-end">1</td>
                <td className="py-1.5 text-end">{fmt(data.amount)}</td>
                <td className="py-1.5 text-end">{fmt(data.amount)}</td>
              </tr>
            )}
          </tbody>
        </table>
        {isBill ? (
          <div className="flex justify-end mb-6">
            <div className="w-3/5 space-y-3">
              <BillSummary data={data} />
              <DepositBox data={data} />
            </div>
          </div>
        ) : (
          <div className="flex justify-end mb-6">
            <div className="w-1/2 text-[13px] space-y-1">
              {hasDiscount && (
                <div className="flex justify-between text-emerald-700">
                  <span>{dt(lang, 'discount')}</span><span>− Rs. {fmt(data.discountAmount!)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold border-t border-dp-outline-variant pt-1">
                <span>{totalLabel}</span><span>Rs. {fmt(data.amount)}</span>
              </div>
              <div className="flex justify-between text-dp-on-surface-variant">
                <span>{balanceLabel}</span><span>Rs. {fmt(Math.max(data.balanceAfter, 0))}</span>
              </div>
              {showAnnounced && (
                <div className="flex justify-between text-[13px] text-dp-on-surface-variant mt-1">
                  <span>{announcedLabel}</span><span>Rs. {fmt(announcedRemaining)}</span>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-end mt-10">
          <Signature data={data} />
        </div>
        <Footer data={data} />
      </div>
    )
  }

  if (template === 'compact') {
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white p-4 w-[300px] font-mono text-dp-on-surface text-[12px]" style={{ fontFamily: 'var(--font-sans), monospace' }}>
        <PaymentStamp data={data} compact />
        <div className="relative text-center mb-2">
          <Logo data={data} />
          <LogoGutter data={data}>
            <p className="font-bold">{companyNameEn.toUpperCase()}</p>
            <p className="text-[10px]">{data.systemLabel}</p>
          </LogoGutter>
        </div>
        <p className="text-center border-t border-b border-dashed border-dp-outline-variant py-1 my-1">{title} #{data.receiptNo}</p>
        <p>{dt(lang, 'dateColon')}{fmtDate(data.date)}</p>
        {data.dueDate && <p>{dt(lang, 'dueColon')}{fmtDate(data.dueDate)}</p>}
        {isBill && data.billingPeriod && <p>{dt(lang, 'periodColon')}{data.billingPeriod}</p>}
        <p>{fromLabel}: {data.accountName}</p>
        {data.accountPhone && <p><Ltr>{data.accountPhone}</Ltr></p>}
        <p className="my-1 border-t border-dashed border-dp-outline-variant" />
        {data.lineItems && data.lineItems.length > 0 ? (
          data.lineItems.map((l, i) => (
            <div key={i} className="flex justify-between">
              <span>{l.description} x{l.quantity}</span><span>{fmt(l.quantity * l.unitPrice)}</span>
            </div>
          ))
        ) : (
          <div className="flex justify-between"><span>{data.particular}</span></div>
        )}
        {hasDiscount && (
          <div className="flex justify-between"><span>{dt(lang, 'discount')}</span><span>-{fmt(data.discountAmount!)}</span></div>
        )}
        <p className="my-1 border-t border-dashed border-dp-outline-variant" />
        <div className="flex justify-between font-bold text-[14px]">
          <span>{totalLabelCaps}</span><span>Rs.{fmt(data.amount)}</span>
        </div>
        {isBill && (data.paidAmount ?? 0) > 0 && (
          <>
            <div className="flex justify-between text-[11px]"><span>{dt(lang, 'paid')}</span><span>{fmt(data.paidAmount!)}</span></div>
            <div className="flex justify-between text-[11px] font-bold"><span>{dt(lang, 'balanceDue')}</span><span>{fmt(Math.max(data.amount - data.paidAmount!, 0))}</span></div>
          </>
        )}
        {!isBill && (
          <div className="flex justify-between text-[11px] mt-1">
            <span>{balanceLabel}</span><span>{fmt(Math.max(data.balanceAfter, 0))}</span>
          </div>
        )}
        {showAnnounced && (
          <div className="flex justify-between text-[11px] mt-1">
            <span>{announcedLabel}</span><span>{fmt(announcedRemaining)}</span>
          </div>
        )}
        {isBill && (data.securityDepositAmount ?? 0) > 0 && (
          <div className="flex justify-between text-[11px] mt-1"><span>{dt(lang, 'depositRefundableSeparate')}</span><span>{fmt(data.securityDepositAmount!)}</span></div>
        )}
        {data.fundNote && <p className="text-center mt-2 text-[10px]">{data.fundNote}</p>}
        {data.helplineNumbers && (
          <p className="text-center mt-2 text-[10px]">
            {(lang === 'ur' ? data.helplineLabelUr : data.helplineLabelEn)?.trim()
              || dt(lang, isDonation ? 'helplineDonation' : 'helplineWater').replace(/:\s*$/, '')}
            {': '}{data.helplineNumbers}
          </p>
        )}
        <p className="text-center mt-1 text-[10px]">{dt(lang, 'thankYou')}</p>
      </div>
    )
  }

  if (template === 'ledger') {
    const accent = '#1b6b64'
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white p-8 w-[520px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative flex justify-between items-end border-b-2 pb-4" style={{ borderColor: accent }}>
          <Logo data={data} />
          <div style={{ paddingLeft: logoPad }}>
            <p className="text-[19px] font-bold">{companyNameEn}</p>
            {showUrdu && <p className="text-[13px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
            <p className="text-[10px] uppercase tracking-[0.15em] text-dp-on-surface-variant mt-0.5">{data.systemLabel}</p>
          </div>
          <div className="text-end">
            <p className="text-[10px] uppercase tracking-[0.15em] text-dp-on-surface-variant">{title}</p>
            <p className="text-[20px] font-bold" style={{ color: accent }}>{data.receiptNo}</p>
            <p className="text-[12px] text-dp-on-surface-variant mt-0.5">{fmtDate(data.date)}</p>
            {data.dueDate && <p className="text-[11px] text-dp-on-surface-variant">{dt(lang, 'due')}{fmtDate(data.dueDate)}</p>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 mt-6 text-[13px]">
          <div>
            <p className="text-[11px] uppercase tracking-[0.1em] text-dp-on-surface-variant">{partyLabelFull}</p>
            <p className="font-bold text-[16px] mt-0.5">{data.accountName}</p>
            {showUrdu && data.accountNameUr && <p style={{ fontFamily: 'var(--font-urdu), serif' }}>{data.accountNameUr}</p>}
            {data.accountAddress && <p className="text-dp-on-surface-variant mt-0.5">{data.accountAddress}</p>}
            {data.accountPhone && <p className="text-dp-on-surface-variant"><Ltr>{data.accountPhone}</Ltr></p>}
          </div>
          <div className="text-end"><BillingPeriod data={data} /><ProjectLine data={data} /></div>
        </div>

        <table className="w-full text-[13px] mt-8">
          <thead>
            <tr className="border-b" style={{ borderColor: accent }}>
              <th className="text-start text-[11px] uppercase tracking-[0.06em] text-dp-on-surface-variant font-semibold pb-2">{dt(lang, 'description')}</th>
              <th className="text-end text-[11px] uppercase tracking-[0.06em] text-dp-on-surface-variant font-semibold pb-2">{dt(lang, 'amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.lineItems && data.lineItems.length > 0 ? (
              data.lineItems.map((l, i) => (
                <tr key={i} className="border-b border-dp-outline-variant">
                  <td className="py-2.5">{l.description}{l.quantity > 1 && ` x${l.quantity}`}</td>
                  <td className="py-2.5 text-end">Rs. {fmt(l.quantity * l.unitPrice)}</td>
                </tr>
              ))
            ) : (
              <tr className="border-b border-dp-outline-variant">
                <td className="py-2.5">{data.particular}</td>
                <td className="py-2.5 text-end">Rs. {fmt(data.amount)}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="flex justify-end mt-4 pt-4 border-t-2" style={{ borderColor: accent }}>
          <div className="w-[260px]">
            {isBill ? (
              <div className="space-y-3">
                <BillSummary data={data} />
                <DepositBox data={data} />
              </div>
            ) : (
              <>
                {hasDiscount && (
                  <div className="flex justify-between text-emerald-700 text-[13px] mb-1">
                    <span>{dt(lang, 'discount')}</span><span>− Rs. {fmt(data.discountAmount!)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-[19px]">
                  <span>{totalLabel}</span><span>Rs. {fmt(data.amount)}</span>
                </div>
                <div className="flex justify-between text-[13px] text-dp-on-surface-variant mt-1">
                  <span>{balanceLabel}</span><span>Rs. {fmt(Math.max(data.balanceAfter, 0))}</span>
                </div>
                {showAnnounced && (
                  <div className="flex justify-between text-[13px] text-dp-on-surface-variant mt-1">
                    <span>{announcedLabel}</span><span>Rs. {fmt(announcedRemaining)}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {!isBill && data.collectedByName && (
          <p className="text-[12px] text-dp-on-surface-variant mt-2">{dt(lang, 'collectedBy')}{data.collectedByName}</p>
        )}

        <div className="flex justify-end mt-10">
          <Signature data={data} />
        </div>
        <Footer data={data} />
      </div>
    )
  }

  if (template === 'cardSections') {
    const accent = '#6b2c58'
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-dp-surface-container-low w-[500px] p-6 flex flex-col gap-3 font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative bg-white rounded-2xl px-5 py-4 flex justify-between items-center shadow-sm">
          <Logo data={data} />
          <div style={{ paddingLeft: logoPad }}>
            <p className="text-[17px] font-bold">{companyNameEn}</p>
            {showUrdu && <p className="text-[13px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
            <p className="text-[11px] text-dp-on-surface-variant">{data.systemLabel}</p>
          </div>
          <div className="text-white rounded-full px-4 py-1.5 text-[12px] font-bold shrink-0" style={{ backgroundColor: accent }}>{data.receiptNo}</div>
        </div>

        <div className="bg-white rounded-2xl px-5 py-4 shadow-sm grid grid-cols-2 gap-4 text-[13px]">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-dp-on-surface-variant">{partyLabelFull}</p>
            <p className="font-bold text-[15px] mt-0.5">{data.accountName}</p>
            {data.accountAddress && <p className="text-dp-on-surface-variant text-[12px] mt-0.5">{data.accountAddress}{data.accountPhone && <> · <Ltr>{data.accountPhone}</Ltr></>}</p>}
          </div>
          <div className="text-end">
            <p className="text-[11px] uppercase tracking-[0.08em] text-dp-on-surface-variant">{dt(lang, 'date')}</p>
            <p className="font-semibold">{fmtDate(data.date)}</p>
            {data.dueDate && <p className="text-[11px] text-dp-on-surface-variant">{dt(lang, 'due')}{fmtDate(data.dueDate)}</p>}
            <BillingPeriod data={data} className="mt-1" />
            <ProjectLine data={data} className="mt-1" />
          </div>
        </div>

        <div className="bg-white rounded-2xl px-5 py-4 shadow-sm text-[13px]">
          {data.lineItems && data.lineItems.length > 0 ? (
            data.lineItems.map((l, i) => (
              <div key={i} className={`flex justify-between py-2 ${i < data.lineItems!.length - 1 ? 'border-b border-dp-outline-variant' : ''}`}>
                <span>{l.description}{l.quantity > 1 && ` x${l.quantity}`}</span>
                <span className="font-semibold">Rs. {fmt(l.quantity * l.unitPrice)}</span>
              </div>
            ))
          ) : (
            <p>{data.particular}</p>
          )}
        </div>

        {isBill ? (
          <div className="bg-white rounded-2xl px-5 py-4 shadow-sm space-y-3">
            <BillSummary data={data} />
            <DepositBox data={data} />
          </div>
        ) : (
          <div className="rounded-2xl px-5 py-4 text-white" style={{ backgroundColor: accent }}>
            {hasDiscount && (
              <div className="flex justify-between text-[13px] opacity-90 mb-1">
                <span>{dt(lang, 'discount')}</span><span>− Rs. {fmt(data.discountAmount!)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-[19px]"><span>{totalLabel}</span><span>Rs. {fmt(data.amount)}</span></div>
            <div className="flex justify-between text-[13px] opacity-90 mt-1"><span>{balanceLabel}</span><span>Rs. {fmt(Math.max(data.balanceAfter, 0))}</span></div>
            {showAnnounced && <div className="flex justify-between text-[13px] opacity-90 mt-1"><span>{announcedLabel}</span><span>Rs. {fmt(announcedRemaining)}</span></div>}
          </div>
        )}

        <div className="flex justify-between items-end px-1">
          <div className="max-w-[280px]">
            {!isBill && data.collectedByName && <p className="text-[11px] text-dp-on-surface-variant">{dt(lang, 'collectedBy')}{data.collectedByName}</p>}
          </div>
          <Signature data={data} />
        </div>
        <Footer data={data} />
      </div>
    )
  }

  if (template === 'boldBand') {
    const accent = '#6b1f2c'
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white w-[560px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative text-white px-8 py-6 flex justify-between items-center" style={{ backgroundColor: accent }}>
          <Logo data={data} className="bg-white/10 p-1 rounded" />
          <div style={{ paddingLeft: logoPad }}>
            <p className="text-[20px] font-bold">{companyNameEn}</p>
            {showUrdu && <p className="text-[14px] opacity-85" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
            <p className="text-[10px] uppercase tracking-[0.15em] opacity-75 mt-0.5">{data.systemLabel}</p>
          </div>
          <div className="text-end">
            <p className="text-[11px] uppercase tracking-[0.1em] opacity-80">{title}</p>
            <p className="text-[20px] font-bold">{data.receiptNo}</p>
            <p className="text-[12px] opacity-85 mt-0.5">{fmtDate(data.date)}</p>
          </div>
        </div>

        <div className="p-8">
          <div className="rounded-lg px-5 py-4 grid grid-cols-2 gap-5" style={{ backgroundColor: '#faf1f2' }}>
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-dp-on-surface-variant">{partyLabelFull}</p>
              <p className="font-bold text-[16px] mt-0.5">{data.accountName}</p>
              {data.accountAddress && <p className="text-[13px] text-dp-on-surface-variant mt-0.5">{data.accountAddress}{data.accountPhone && <> · <Ltr>{data.accountPhone}</Ltr></>}</p>}
            </div>
            <div className="text-end"><BillingPeriod data={data} /><ProjectLine data={data} /></div>
          </div>

          <table className="w-full text-[13px] mt-6">
            <thead>
              <tr className="border-b-2" style={{ borderColor: accent }}>
                <th className="text-start pb-2 text-[12px] uppercase tracking-[0.05em] text-dp-on-surface-variant">{dt(lang, 'description')}</th>
                <th className="text-end pb-2 text-[12px] uppercase tracking-[0.05em] text-dp-on-surface-variant">{dt(lang, 'amount')}</th>
              </tr>
            </thead>
            <tbody>
              {data.lineItems && data.lineItems.length > 0 ? (
                data.lineItems.map((l, i) => (
                  <tr key={i} className="border-b border-dp-outline-variant">
                    <td className="py-2.5">{l.description}{l.quantity > 1 && ` x${l.quantity}`}</td>
                    <td className="py-2.5 text-end">Rs. {fmt(l.quantity * l.unitPrice)}</td>
                  </tr>
                ))
              ) : (
                <tr className="border-b border-dp-outline-variant">
                  <td className="py-2.5">{data.particular}</td>
                  <td className="py-2.5 text-end">Rs. {fmt(data.amount)}</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="mt-5 rounded-lg border px-5 py-4 flex justify-end" style={{ borderColor: accent }}>
            <div className="w-[240px]">
              {isBill ? (
                <div className="space-y-3">
                  <BillSummary data={data} />
                  <DepositBox data={data} />
                </div>
              ) : (
                <>
                  {hasDiscount && (
                    <div className="flex justify-between text-emerald-700 text-[13px] mb-1">
                      <span>{dt(lang, 'discount')}</span><span>− Rs. {fmt(data.discountAmount!)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-[19px]"><span>{totalLabel}</span><span>Rs. {fmt(data.amount)}</span></div>
                  <div className="flex justify-between text-[13px] text-dp-on-surface-variant mt-1"><span>{balanceLabel}</span><span>Rs. {fmt(Math.max(data.balanceAfter, 0))}</span></div>
                  {showAnnounced && <div className="flex justify-between text-[13px] text-dp-on-surface-variant mt-1"><span>{announcedLabel}</span><span>Rs. {fmt(announcedRemaining)}</span></div>}
                </>
              )}
            </div>
          </div>
          {!isBill && data.collectedByName && (
            <p className="text-[12px] text-dp-on-surface-variant mt-2">{dt(lang, 'collectedBy')}{data.collectedByName}</p>
          )}

          <div className="flex justify-end mt-9">
            <Signature data={data} />
          </div>
          <Footer data={data} />
        </div>
      </div>
    )
  }

  if (template === 'twoColumn') {
    const accent = '#33397a'
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white w-[600px] flex font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="w-[210px] p-6 flex flex-col gap-5" style={{ backgroundColor: '#f0f1f8' }}>
          <div className="relative">
            <Logo data={data} />
            <div style={{ paddingTop: logoPad }}>
              <p className="text-[15px] font-bold">{companyNameEn}</p>
              {showUrdu && <p className="text-[12px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
            </div>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.08em] text-dp-on-surface-variant">{title} No.</p>
            <p className="font-bold text-[16px]" style={{ color: accent }}>{data.receiptNo}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.08em] text-dp-on-surface-variant">{dt(lang, 'date')}</p>
            <p className="text-[13px] font-medium">{fmtDate(data.date)}</p>
            {data.dueDate && <p className="text-[11px] text-dp-on-surface-variant mt-0.5">{dt(lang, 'due')}{fmtDate(data.dueDate)}</p>}
          </div>
          <BillingPeriod data={data} />
          <ProjectLine data={data} />
          <div className="border-t pt-4" style={{ borderColor: '#dcdeef' }}>
            <p className="text-[11px] uppercase tracking-[0.08em] text-dp-on-surface-variant">{partyLabelFull}</p>
            <p className="font-bold text-[14px] mt-0.5">{data.accountName}</p>
            {data.accountAddress && <p className="text-[12px] text-dp-on-surface-variant mt-0.5 leading-snug">{data.accountAddress}<br /><Ltr>{data.accountPhone}</Ltr></p>}
          </div>
        </div>

        <div className="flex-1 p-7">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b-2" style={{ borderColor: accent }}>
                <th className="text-start pb-2 text-[12px] uppercase tracking-[0.05em] text-dp-on-surface-variant">{dt(lang, 'description')}</th>
                <th className="text-end pb-2 text-[12px] uppercase tracking-[0.05em] text-dp-on-surface-variant">{dt(lang, 'amount')}</th>
              </tr>
            </thead>
            <tbody>
              {data.lineItems && data.lineItems.length > 0 ? (
                data.lineItems.map((l, i) => (
                  <tr key={i} className="border-b border-dp-outline-variant">
                    <td className="py-2.5">{l.description}{l.quantity > 1 && ` x${l.quantity}`}</td>
                    <td className="py-2.5 text-end">Rs. {fmt(l.quantity * l.unitPrice)}</td>
                  </tr>
                ))
              ) : (
                <tr className="border-b border-dp-outline-variant">
                  <td className="py-2.5">{data.particular}</td>
                  <td className="py-2.5 text-end">Rs. {fmt(data.amount)}</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="mt-5 rounded-lg px-5 py-4" style={{ backgroundColor: '#f0f1f8' }}>
            {isBill ? (
              <div className="space-y-3">
                <BillSummary data={data} />
                <DepositBox data={data} />
              </div>
            ) : (
              <>
                {hasDiscount && (
                  <div className="flex justify-between text-emerald-700 text-[13px] mb-1">
                    <span>{dt(lang, 'discount')}</span><span>− Rs. {fmt(data.discountAmount!)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-[19px]" style={{ color: accent }}><span>{totalLabel}</span><span>Rs. {fmt(data.amount)}</span></div>
                <div className="flex justify-between text-[13px] text-dp-on-surface-variant mt-1"><span>{balanceLabel}</span><span>Rs. {fmt(Math.max(data.balanceAfter, 0))}</span></div>
                {showAnnounced && <div className="flex justify-between text-[13px] text-dp-on-surface-variant mt-1"><span>{announcedLabel}</span><span>Rs. {fmt(announcedRemaining)}</span></div>}
              </>
            )}
          </div>
          {!isBill && data.collectedByName && (
            <p className="text-[11px] text-dp-on-surface-variant mt-2">{dt(lang, 'collectedBy')}{data.collectedByName}</p>
          )}

          <div className="flex justify-end mt-8">
            <Signature data={data} />
          </div>
          <Footer data={data} />
        </div>
      </div>
    )
  }

  if (template === 'statement') {
    const accent = '#37424c'
    return (
      <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white p-8 w-[520px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative flex justify-between items-center border-b pb-3" style={{ borderColor: accent }}>
          <Logo data={data} />
          <div style={{ paddingLeft: logoPad }}>
            <p className="text-[15px] font-semibold">{companyNameEn}</p>
            {showUrdu && <p className="text-[11px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
          </div>
          <div className="text-end text-[11px] text-dp-on-surface-variant">
            <p>{title} No. <span className="font-bold text-dp-on-surface">{data.receiptNo}</span></p>
            <p>{fmtDate(data.date)}{data.billingPeriod ? ` · ${data.billingPeriod}` : ''}</p>
          </div>
        </div>

        <p className="text-[13px] mt-3">
          <span className="text-dp-on-surface-variant">{partyLabelFull}: </span>
          <strong>{data.accountName}</strong>
          {data.accountAddress && <span className="text-dp-on-surface-variant"> — {data.accountAddress}{data.accountPhone && <> · <Ltr>{data.accountPhone}</Ltr></>}</span>}
        </p>

        <table className="w-full text-[13px] mt-4">
          <thead>
            <tr style={{ backgroundColor: '#f4f5f6' }}>
              <th className="text-start px-2.5 py-2 text-[12px] font-semibold text-dp-on-surface-variant">{dt(lang, 'description')}</th>
              <th className="text-end px-2.5 py-2 text-[12px] font-semibold text-dp-on-surface-variant">{dt(lang, 'amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.lineItems && data.lineItems.length > 0 ? (
              data.lineItems.map((l, i) => (
                <tr key={i} style={i % 2 === 1 ? { backgroundColor: '#f4f5f6' } : undefined}>
                  <td className="px-2.5 py-2">{l.description}{l.quantity > 1 && ` x${l.quantity}`}</td>
                  <td className="px-2.5 py-2 text-end">{fmt(l.quantity * l.unitPrice)}</td>
                </tr>
              ))
            ) : (
              <tr><td className="px-2.5 py-2">{data.particular}</td><td className="px-2.5 py-2 text-end">{fmt(data.amount)}</td></tr>
            )}
          </tbody>
          <tfoot>
            {isBill ? (
              <>
                {hasDiscount && (
                  <tr><td className="px-2.5 py-1 text-[12px] text-dp-on-surface-variant">{dt(lang, 'subtotal')}</td><td className="px-2.5 py-1 text-end text-[12px] text-dp-on-surface-variant">{fmt(data.amount + (data.discountAmount ?? 0))}</td></tr>
                )}
                {hasDiscount && (
                  <tr><td className="px-2.5 py-1 text-[12px] text-emerald-700">{dt(lang, 'discount')}</td><td className="px-2.5 py-1 text-end text-[12px] text-emerald-700">− {fmt(data.discountAmount!)}</td></tr>
                )}
                <tr style={{ borderTop: `1px solid ${accent}` }}>
                  <td className="px-2.5 py-2 font-bold">{dt(lang, 'totalPayable')}</td>
                  <td className="px-2.5 py-2 text-end font-bold">{fmt(data.amount)}</td>
                </tr>
                {(data.paidAmount ?? 0) > 0 && (
                  <>
                    <tr><td className="px-2.5 py-1 text-[12px] text-emerald-700">{dt(lang, 'paid')}</td><td className="px-2.5 py-1 text-end text-[12px] text-emerald-700">{fmt(data.paidAmount!)}</td></tr>
                    <tr><td className="px-2.5 pb-2 text-[12px] text-dp-error">{dt(lang, 'balanceDue')}</td><td className="px-2.5 pb-2 text-end text-[12px] text-dp-error">{fmt(Math.max(data.amount - data.paidAmount!, 0))}</td></tr>
                  </>
                )}
              </>
            ) : (
              <>
                {hasDiscount && (
                  <tr><td className="px-2.5 py-1 text-[12px] text-emerald-700">{dt(lang, 'discount')}</td><td className="px-2.5 py-1 text-end text-[12px] text-emerald-700">− {fmt(data.discountAmount!)}</td></tr>
                )}
                <tr style={{ borderTop: `1px solid ${accent}` }}>
                  <td className="px-2.5 py-2 font-bold">{totalLabel}</td>
                  <td className="px-2.5 py-2 text-end font-bold">{fmt(data.amount)}</td>
                </tr>
                <tr><td className="px-2.5 pb-2 text-[12px] text-dp-on-surface-variant">{balanceLabel}</td><td className="px-2.5 pb-2 text-end text-[12px] text-dp-on-surface-variant">{fmt(Math.max(data.balanceAfter, 0))}</td></tr>
                {showAnnounced && <tr><td className="px-2.5 pb-2 text-[12px] text-dp-on-surface-variant">{announcedLabel}</td><td className="px-2.5 pb-2 text-end text-[12px] text-dp-on-surface-variant">{fmt(announcedRemaining)}</td></tr>}
              </>
            )}
          </tfoot>
        </table>

        <div className="flex justify-between items-center mt-4 text-[12px] text-dp-on-surface-variant">
          {!!data.securityDepositAmount && data.securityDepositAmount > 0 && (
            <span>{dt(lang, 'depositRefundableSeparate')}: Rs. {fmt(data.securityDepositAmount)}</span>
          )}
          {!isBill && data.collectedByName && <span>{dt(lang, 'collectedBy')}{data.collectedByName}</span>}
        </div>

        <div className="flex justify-end mt-8">
          <Signature data={data} />
        </div>
        <Footer data={data} />
      </div>
    )
  }

  // classic (default)
  return (
    <div ref={ref} dir={showUrdu ? 'rtl' : 'ltr'} className="relative bg-white p-8 w-[520px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
      <PaymentStamp data={data} />
      <div className="relative text-center mb-4">
        <Logo data={data} />
        <LogoGutter data={data}>
          {showUrdu && <p className="text-[20px] font-bold mb-2" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
          <p className="text-[16px] font-bold">{companyNameEn}</p>
          <p className="text-[12px] text-dp-on-surface-variant mt-1"><Ltr>{companyEmail}</Ltr></p>
          <p className="text-[12px] text-dp-on-surface-variant">{data.systemLabel}</p>
        </LogoGutter>
      </div>

      <div className="border-t border-b border-dp-outline-variant py-2 text-center mb-3">
        <h2 className="text-[18px] font-bold">{title}</h2>
        <p className="text-[12px] text-dp-on-surface-variant">{data.receiptNo}</p>
      </div>

      <div className="flex justify-between border border-dp-outline-variant text-[13px] mb-4">
        <div className="p-2.5 border-e border-dp-outline-variant flex-1">
          <p className="font-bold">{partyLabelShort}:</p>
          <p className="font-bold">{data.accountName}</p>
          {showUrdu && data.accountNameUr && <p style={{ fontFamily: 'var(--font-urdu), serif' }}>{data.accountNameUr}</p>}
          {data.accountAddress && <p>{data.accountAddress}</p>}
          {data.accountPhone && <p><Ltr>{data.accountPhone}</Ltr></p>}
        </div>
        <div className="p-2.5 text-end">
          <p>{dt(lang, 'receiptNoDot')}{data.receiptNo}</p>
          <p>{dt(lang, 'dated')}{fmtDate(data.date)}</p>
          {data.dueDate && <p>{dt(lang, 'dueColon')}{fmtDate(data.dueDate)}</p>}
        </div>
      </div>

      <BillingPeriod data={data} className="mb-2" />
      <ProjectLine data={data} className="mb-2" />

      {data.lineItems && data.lineItems.length > 0 && (
        <table className="w-full text-[13px] mb-3">
          <thead>
            <tr className="border-b border-dp-outline-variant text-start text-dp-on-surface-variant">
              <th className="py-1">{dt(lang, 'description')}</th>
              <th className="py-1 text-end">{dt(lang, 'qty')}</th>
              <th className="py-1 text-end">{dt(lang, 'amount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.lineItems.map((l, i) => (
              <tr key={i} className="border-b border-dp-outline-variant">
                <td className="py-1">{l.description}</td>
                <td className="py-1 text-end">{l.quantity}</td>
                <td className="py-1 text-end">{fmt(l.quantity * l.unitPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!isBill && (
        <p className="text-[14px] mb-1">
          {partyLine}
        </p>
      )}
      {!isBill && data.collectedByName && (
        <p className="text-[12.5px] text-dp-on-surface-variant mb-1">{dt(lang, 'collectedBy')}{data.collectedByName}</p>
      )}
      {isBill && data.particular && (
        <p className="text-[13px] mb-3"><span className="font-semibold">{dt(lang, 'remarks')}</span>{data.particular}</p>
      )}

      {isBill ? (
        <div className="space-y-3 mb-6">
          <BillSummary data={data} />
          <DepositBox data={data} />
        </div>
      ) : (
        <>
          {hasDiscount && (
            <p className="text-[13px] mb-1 text-emerald-700">{dt(lang, 'discount')}: − Rs. {fmt(data.discountAmount!)}</p>
          )}
          <p className="text-[14px] font-bold mb-3">
            {dt(lang, 'amountColon')}{fmt(data.amount)}{showUrdu && <span style={{ fontFamily: 'var(--font-urdu), serif' }}> روپے</span>}
          </p>
          <p className="text-[13px] mb-3">
            <span className="font-semibold">{dt(lang, 'remarks')}</span>{data.particular}
          </p>
          <p className={`text-[13px] font-bold ${showAnnounced ? 'mb-2' : 'mb-8'}`}>
            {balanceLabel}{dt(lang, 'asOn')}{fmtDate(data.date)}{dt(lang, 'closeParen')}: {fmt(Math.max(data.balanceAfter, 0))}{showUrdu && <span style={{ fontFamily: 'var(--font-urdu), serif' }}> روپے</span>}
          </p>
          {showAnnounced && (
            <p className="text-[13px] font-bold mb-8">
              {announcedLabel}: {fmt(announcedRemaining)}{showUrdu && <span style={{ fontFamily: 'var(--font-urdu), serif' }}> روپے</span>}
            </p>
          )}
        </>
      )}

      <div className="flex justify-end mt-8">
        <Signature data={data} />
      </div>
      <Footer data={data} />
    </div>
  )
})
