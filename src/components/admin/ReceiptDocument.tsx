'use client'

import { forwardRef } from 'react'

export type InvoiceTemplate = 'classic' | 'modern' | 'minimal' | 'detailed' | 'compact'

export interface ReceiptLineItem { description: string; quantity: number; unitPrice: number }

export interface ManagementContact { name: string; designation: string; whatsapp: string }

export interface ReceiptData {
  kind: 'bill' | 'payment' | 'donation' | 'manual' | 'purchase_payment'
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
  balanceAfter: number
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
  collectedByName?: string | null
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB')
}

interface Props { data: ReceiptData; template?: InvoiceTemplate }

// Sized and vertically nudged from Settings (Branding) — always absolutely
// positioned in the top-left corner of its (relative) header container, so it never
// drags the centered company heading off to one side.
function Logo({ data, className = '' }: { data: ReceiptData; className?: string }) {
  if (!data.logoUrl) return null
  const size = data.logoWidth ?? 56
  return (
    <img
      src={data.logoUrl} alt="Logo"
      className={`absolute left-0 top-0 object-contain ${className}`}
      style={{ width: size, height: size, marginTop: data.logoOffsetY ?? 0 }}
    />
  )
}

function Signature({ data }: { data: ReceiptData }) {
  return (
    <div className="text-right text-[12px] inline-block">
      {data.signatureUrl && <img src={data.signatureUrl} alt="Signature" className="h-10 ml-auto mb-1 object-contain" />}
      <p className="border-t border-dp-outline-variant pt-1">Authorized Signatory</p>
    </div>
  )
}

// Everything here is admin-editable from Settings — contact/complaint numbers, the
// management team to reach out to, and social/project links — and renders
// right-to-left in Urdu font when the site's display language is Urdu, left-to-right
// otherwise. Only appears on bills, cash receipts, and payment vouchers.
function Footer({ data }: { data: ReceiptData }) {
  const contacts = data.footerManagementContacts ?? []
  const links: [string, string | null | undefined][] = [
    ['Facebook', data.footerFacebookLink],
    ['WhatsApp Group', data.footerWhatsappGroupLink],
    ['Current Projects', data.footerProjectsLink],
    ['Donate', data.footerDonationLink],
  ]
  const hasLinks = links.some(([, v]) => v)
  const hasAnything = data.helplineNumbers || data.instructions || data.footerComplaintNumber || contacts.length > 0 || hasLinks
  if (!hasAnything) return null
  const isUrdu = data.language === 'ur'
  return (
    <div
      className="border-t border-dashed border-dp-outline-variant mt-4 pt-2 text-[11px] text-dp-on-surface-variant space-y-1"
      dir={isUrdu ? 'rtl' : 'ltr'}
      style={isUrdu ? { fontFamily: 'var(--font-urdu), serif', textAlign: 'right' } : { textAlign: 'left' }}
    >
      {data.instructions && <p>{data.instructions}</p>}
      {data.helplineNumbers && <p className="font-semibold">Helpline: {data.helplineNumbers}</p>}
      {data.footerComplaintNumber && <p className="font-semibold">Complaint: {data.footerComplaintNumber}</p>}
      {contacts.length > 0 && (
        <div>
          {contacts.map((c, i) => (
            <p key={i}>{c.name}{c.designation ? ` — ${c.designation}` : ''}{c.whatsapp ? ` — ${c.whatsapp}` : ''}</p>
          ))}
        </div>
      )}
      {hasLinks && (
        <p>{links.filter(([, v]) => v).map(([label, v]) => `${label}: ${v}`).join('  ·  ')}</p>
      )}
    </div>
  )
}

// Renders the money story exactly once — Subtotal (only if there's a discount to
// explain), Discount, Total Payable, and Paid/Balance Due (only when something has
// actually been paid — an unpaid bill just shows Total Payable, not the same number
// twice under two labels).
function BillSummary({ data }: { data: ReceiptData }) {
  const subtotal = data.lineItems && data.lineItems.length > 0
    ? data.lineItems.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
    : data.amount + (data.discountAmount ?? 0)
  const discount = data.discountAmount ?? 0
  const paid = data.paidAmount ?? 0
  return (
    <div className="font-sans text-[13px] space-y-1">
      {discount > 0 && (
        <div className="flex justify-between text-dp-on-surface-variant">
          <span>Subtotal</span><span>Rs. {fmt(subtotal)}</span>
        </div>
      )}
      {discount > 0 && (
        <div className="flex justify-between text-emerald-700">
          <span>Discount</span><span>− Rs. {fmt(discount)}</span>
        </div>
      )}
      <div className="flex justify-between font-bold text-[15px] border-t border-dp-outline-variant pt-1.5 mt-1">
        <span>Total Payable</span><span>Rs. {fmt(data.amount)}</span>
      </div>
      {paid > 0 && (
        <>
          <div className="flex justify-between text-emerald-700">
            <span>Paid</span><span>Rs. {fmt(paid)}</span>
          </div>
          <div className="flex justify-between font-bold text-dp-error">
            <span>Balance Due</span><span>Rs. {fmt(Math.max(data.amount - paid, 0))}</span>
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
  if (!data.securityDepositAmount || data.securityDepositAmount <= 0) return null
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[12px] text-amber-900 flex justify-between items-center gap-3">
      <span>
        Security Deposit — collected separately, refundable (not included in Total Payable)
        {data.securityDepositReceiptNo && <span className="block font-semibold">Receipt #{data.securityDepositReceiptNo}</span>}
      </span>
      <span className="font-bold whitespace-nowrap">Rs. {fmt(data.securityDepositAmount)}</span>
    </div>
  )
}

function BillingPeriod({ data, className = '' }: { data: ReceiptData; className?: string }) {
  if (data.kind !== 'bill' || !data.billingPeriod) return null
  return <p className={`font-sans text-[12.5px] font-semibold text-dp-on-surface-variant ${className}`}>Billing Period: {data.billingPeriod}</p>
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
  const status = paymentStatus(data)
  if (!status) return null
  const label = status === 'paid' ? 'PAID' : 'PARTIAL PAYMENT'
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-20 overflow-hidden">
      <span
        className="border-[3px] border-red-600 text-red-600 font-extrabold uppercase text-center"
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

export const ReceiptDocument = forwardRef<HTMLDivElement, Props>(function ReceiptDocument({ data, template = 'classic' }, ref) {
  const isBill = data.kind === 'bill'
  const isPurchasePayment = data.kind === 'purchase_payment'
  const isCredit = data.kind === 'payment' || data.kind === 'donation'
  const title = isBill ? 'Bill' : isPurchasePayment ? 'Payment Voucher' : 'Receipt'
  const balanceLabel = data.kind === 'donation' ? 'Total Contributed' : 'Outstanding Amount'
  // "Received From" for cash coming in, "Paid To" for cash going out to a vendor,
  // "Billed To"/"Customer/Debtor" only for an actual bill being issued to a consumer.
  const partyLabelFull = isPurchasePayment ? 'Paid To' : isCredit ? 'Received From' : 'Billed To'
  const partyLabelShort = isPurchasePayment ? 'Vendor' : isCredit ? 'Customer/Debtor' : 'Billed To'
  const partyLine = isPurchasePayment ? `Paid to: ${data.accountName}` : isCredit ? `Received with thanks from: ${data.accountName}` : `Amount billed to: ${data.accountName}`
  const hasDiscount = !!data.discountAmount && data.discountAmount > 0
  const showUrdu = data.language === 'ur'
  const companyNameEn = data.companyNameEn || 'Dhab Pari'
  const companyNameUr = data.companyNameUr || 'واٹر اینڈ ویلفئیر کمیٹی'
  const companyEmail = data.companyEmail || 'dhabpariwelfare@gmail.com'

  if (template === 'modern') {
    return (
      <div ref={ref} className="relative bg-white w-[520px] font-sans text-dp-on-surface overflow-hidden rounded-lg" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="bg-dp-primary text-white p-6 relative">
          <Logo data={data} className="rounded bg-white/10 p-1" />
          <div className="text-center">
            {showUrdu && <p className="text-[13px] opacity-80 mb-1" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
            <p className="text-[22px] font-bold">{companyNameEn}</p>
            <p className="text-[12px] opacity-80">{data.systemLabel}</p>
          </div>
          <div className="flex justify-between items-end mt-4">
            <div>
              <p className="text-[11px] uppercase tracking-widest opacity-70">{title}</p>
              <p className="text-[16px] font-bold">{data.receiptNo}</p>
            </div>
            <div className="text-right">
              <p className="text-[12px] opacity-80">{fmtDate(data.date)}</p>
              {data.dueDate && <p className="text-[11px] opacity-70">Due {fmtDate(data.dueDate)}</p>}
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="bg-dp-surface-container-low rounded-lg p-4 mb-4">
            <p className="text-[11px] uppercase tracking-widest text-dp-on-surface-variant font-bold">{partyLabelFull}</p>
            <p className="text-[16px] font-bold text-dp-primary">{data.accountName}</p>
            {showUrdu && data.accountNameUr && <p className="text-[13px]" style={{ fontFamily: 'var(--font-urdu), serif' }}>{data.accountNameUr}</p>}
            {data.accountAddress && <p className="text-[12px] text-dp-on-surface-variant mt-1">{data.accountAddress}</p>}
            {data.accountPhone && <p className="text-[12px] text-dp-on-surface-variant">{data.accountPhone}</p>}
          </div>
          <BillingPeriod data={data} className="mb-3" />
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
                  <span>Discount</span><span>− Rs. {fmt(data.discountAmount!)}</span>
                </div>
              )}
              <p className="text-[32px] font-bold text-dp-primary mb-4">Rs. {fmt(data.amount)}</p>
              <div className="flex justify-between border-t border-dp-outline-variant pt-3 text-[13px]">
                <span className="font-semibold text-dp-on-surface-variant">{balanceLabel}</span>
                <span className="font-bold">Rs. {fmt(Math.max(data.balanceAfter, 0))}</span>
              </div>
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
      <div ref={ref} className="relative bg-white p-10 w-[520px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative text-center mb-1">
          <Logo data={data} />
          <p className="text-[13px] tracking-[0.2em] uppercase text-dp-on-surface-variant">{companyNameEn} · {data.systemLabel}</p>
        </div>
        <p className="text-[26px] font-bold mb-8 text-center">{title} <span className="text-dp-on-surface-variant text-[15px] font-normal">{data.receiptNo}</span></p>
        <div className="grid grid-cols-2 gap-6 mb-6 text-[13px]">
          <div>
            <p className="text-dp-on-surface-variant mb-0.5">{isCredit ? 'From' : 'To'}</p>
            <p className="font-semibold">{data.accountName}</p>
            {data.accountAddress && <p className="text-dp-on-surface-variant text-[12px]">{data.accountAddress}</p>}
            {data.accountPhone && <p className="text-dp-on-surface-variant text-[12px]">{data.accountPhone}</p>}
          </div>
          <div className="text-right">
            <p className="text-dp-on-surface-variant mb-0.5">Date</p>
            <p className="font-semibold">{fmtDate(data.date)}</p>
            {data.dueDate && <p className="text-[12px] text-dp-on-surface-variant">Due {fmtDate(data.dueDate)}</p>}
          </div>
        </div>
        <BillingPeriod data={data} className="mb-4" />
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
            {hasDiscount && <p className="text-[13px] text-emerald-700 mb-2">Discount applied: − Rs. {fmt(data.discountAmount!)}</p>}
            <p className="text-[40px] font-bold mb-8">Rs. {fmt(data.amount)}</p>
            <p className="text-[13px] text-dp-on-surface-variant">{balanceLabel}: <span className="font-bold text-dp-on-surface">Rs. {fmt(Math.max(data.balanceAfter, 0))}</span></p>
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
      <div ref={ref} className="relative bg-white p-8 w-[560px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
        <PaymentStamp data={data} />
        <div className="relative text-center mb-4">
          <Logo data={data} />
          {showUrdu && <p className="text-[18px] font-bold mb-1.5" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
          <p className="text-[16px] font-bold">{companyNameEn}</p>
          <p className="text-[12px] text-dp-on-surface-variant">{data.systemLabel}</p>
        </div>
        <div className="flex justify-between text-[13px] border-y border-dp-outline-variant py-2 mb-4">
          <div>
            <p className="font-bold">{title} No.</p>
            <p>{data.receiptNo}</p>
          </div>
          <div className="text-center">
            <p className="font-bold">{partyLabelFull}</p>
            <p>{data.accountName}</p>
            {data.accountAddress && <p className="text-[12px] text-dp-on-surface-variant">{data.accountAddress}</p>}
            {data.accountPhone && <p className="text-[12px] text-dp-on-surface-variant">{data.accountPhone}</p>}
          </div>
          <div className="text-right">
            <p className="font-bold">Date</p>
            <p>{fmtDate(data.date)}</p>
            {data.dueDate && <p className="text-[12px] text-dp-on-surface-variant">Due {fmtDate(data.dueDate)}</p>}
          </div>
        </div>
        <BillingPeriod data={data} className="mb-3" />
        <table className="w-full text-[13px] mb-4">
          <thead>
            <tr className="border-b-2 border-dp-outline-variant text-left text-dp-on-surface-variant">
              <th className="py-1.5">Description</th>
              <th className="py-1.5 text-right">Qty</th>
              <th className="py-1.5 text-right">Rate</th>
              <th className="py-1.5 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.lineItems && data.lineItems.length > 0 ? (
              data.lineItems.map((l, i) => (
                <tr key={i} className="border-b border-dp-outline-variant">
                  <td className="py-1.5">{l.description}</td>
                  <td className="py-1.5 text-right">{l.quantity}</td>
                  <td className="py-1.5 text-right">{fmt(l.unitPrice)}</td>
                  <td className="py-1.5 text-right">{fmt(l.quantity * l.unitPrice)}</td>
                </tr>
              ))
            ) : (
              <tr className="border-b border-dp-outline-variant">
                <td className="py-1.5">{data.particular}</td>
                <td className="py-1.5 text-right">1</td>
                <td className="py-1.5 text-right">{fmt(data.amount)}</td>
                <td className="py-1.5 text-right">{fmt(data.amount)}</td>
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
                  <span>Discount</span><span>− Rs. {fmt(data.discountAmount!)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold border-t border-dp-outline-variant pt-1">
                <span>Total</span><span>Rs. {fmt(data.amount)}</span>
              </div>
              <div className="flex justify-between text-dp-on-surface-variant">
                <span>{balanceLabel}</span><span>Rs. {fmt(Math.max(data.balanceAfter, 0))}</span>
              </div>
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
      <div ref={ref} className="relative bg-white p-4 w-[300px] font-mono text-dp-on-surface text-[12px]" style={{ fontFamily: 'var(--font-sans), monospace' }}>
        <PaymentStamp data={data} compact />
        <div className="relative text-center mb-2">
          <Logo data={data} />
          <p className="font-bold">{companyNameEn.toUpperCase()}</p>
          <p className="text-[10px]">{data.systemLabel}</p>
        </div>
        <p className="text-center border-t border-b border-dashed border-dp-outline-variant py-1 my-1">{title} #{data.receiptNo}</p>
        <p>Date: {fmtDate(data.date)}</p>
        {data.dueDate && <p>Due: {fmtDate(data.dueDate)}</p>}
        {isBill && data.billingPeriod && <p>Period: {data.billingPeriod}</p>}
        <p>{isCredit ? 'From' : 'To'}: {data.accountName}</p>
        {data.accountPhone && <p>{data.accountPhone}</p>}
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
          <div className="flex justify-between"><span>Discount</span><span>-{fmt(data.discountAmount!)}</span></div>
        )}
        <p className="my-1 border-t border-dashed border-dp-outline-variant" />
        <div className="flex justify-between font-bold text-[14px]">
          <span>{isBill ? 'TOTAL PAYABLE' : 'TOTAL'}</span><span>Rs.{fmt(data.amount)}</span>
        </div>
        {isBill && (data.paidAmount ?? 0) > 0 && (
          <>
            <div className="flex justify-between text-[11px]"><span>Paid</span><span>{fmt(data.paidAmount!)}</span></div>
            <div className="flex justify-between text-[11px] font-bold"><span>Balance Due</span><span>{fmt(Math.max(data.amount - data.paidAmount!, 0))}</span></div>
          </>
        )}
        {!isBill && (
          <div className="flex justify-between text-[11px] mt-1">
            <span>{balanceLabel}</span><span>{fmt(Math.max(data.balanceAfter, 0))}</span>
          </div>
        )}
        {isBill && (data.securityDepositAmount ?? 0) > 0 && (
          <div className="flex justify-between text-[11px] mt-1"><span>Deposit (refundable, separate)</span><span>{fmt(data.securityDepositAmount!)}</span></div>
        )}
        {data.helplineNumbers && <p className="text-center mt-2 text-[10px]">Helpline: {data.helplineNumbers}</p>}
        <p className="text-center mt-1 text-[10px]">Thank you</p>
      </div>
    )
  }

  // classic (default)
  return (
    <div ref={ref} className="relative bg-white p-8 w-[520px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
      <PaymentStamp data={data} />
      <div className="relative text-center mb-4">
        <Logo data={data} />
        {showUrdu && <p className="text-[20px] font-bold mb-2" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>}
        <p className="text-[16px] font-bold">{companyNameEn}</p>
        <p className="text-[12px] text-dp-on-surface-variant mt-1">{companyEmail}</p>
        <p className="text-[12px] text-dp-on-surface-variant">{data.systemLabel}</p>
      </div>

      <div className="border-t border-b border-dp-outline-variant py-2 text-center mb-3">
        <h2 className="text-[18px] font-bold">{title}</h2>
        <p className="text-[12px] text-dp-on-surface-variant">{data.receiptNo}</p>
      </div>

      <div className="flex justify-between border border-dp-outline-variant text-[13px] mb-4">
        <div className="p-2.5 border-r border-dp-outline-variant flex-1">
          <p className="font-bold">{partyLabelShort}:</p>
          <p className="font-bold">{data.accountName}</p>
          {showUrdu && data.accountNameUr && <p style={{ fontFamily: 'var(--font-urdu), serif' }}>{data.accountNameUr}</p>}
          {data.accountAddress && <p>{data.accountAddress}</p>}
          {data.accountPhone && <p>{data.accountPhone}</p>}
        </div>
        <div className="p-2.5 text-right">
          <p>Receipt No. {data.receiptNo}</p>
          <p>Dated: {fmtDate(data.date)}</p>
          {data.dueDate && <p>Due: {fmtDate(data.dueDate)}</p>}
        </div>
      </div>

      <BillingPeriod data={data} className="mb-2" />

      {data.lineItems && data.lineItems.length > 0 && (
        <table className="w-full text-[13px] mb-3">
          <thead>
            <tr className="border-b border-dp-outline-variant text-left text-dp-on-surface-variant">
              <th className="py-1">Description</th>
              <th className="py-1 text-right">Qty</th>
              <th className="py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.lineItems.map((l, i) => (
              <tr key={i} className="border-b border-dp-outline-variant">
                <td className="py-1">{l.description}</td>
                <td className="py-1 text-right">{l.quantity}</td>
                <td className="py-1 text-right">{fmt(l.quantity * l.unitPrice)}</td>
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
        <p className="text-[12.5px] text-dp-on-surface-variant mb-1">Collected by: {data.collectedByName}</p>
      )}
      {isBill && data.particular && (
        <p className="text-[13px] mb-3"><span className="font-semibold">Remarks: </span>{data.particular}</p>
      )}

      {isBill ? (
        <div className="space-y-3 mb-6">
          <BillSummary data={data} />
          <DepositBox data={data} />
        </div>
      ) : (
        <>
          {hasDiscount && (
            <p className="text-[13px] mb-1 text-emerald-700">Discount: − Rs. {fmt(data.discountAmount!)}</p>
          )}
          <p className="text-[14px] font-bold mb-3">
            Amount: {fmt(data.amount)}{showUrdu && <span style={{ fontFamily: 'var(--font-urdu), serif' }}> روپے</span>}
          </p>
          <p className="text-[13px] mb-3">
            <span className="font-semibold">Remarks: </span>{data.particular}
          </p>
          <p className="text-[13px] font-bold mb-8">
            {balanceLabel} (As on {fmtDate(data.date)}): {fmt(Math.max(data.balanceAfter, 0))}{showUrdu && <span style={{ fontFamily: 'var(--font-urdu), serif' }}> روپے</span>}
          </p>
        </>
      )}

      <div className="flex justify-end mt-8">
        <Signature data={data} />
      </div>
      <Footer data={data} />
    </div>
  )
})
