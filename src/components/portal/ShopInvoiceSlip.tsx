'use client'

// The udhar bill, rendered as an actual small thermal-roll-style receipt
// image instead of a plain WhatsApp text message — a real, specific
// request: a shopkeeper handing someone a "receipt" that's just chat
// text doesn't read as a real bill the way a printed slip does. Sized
// to an 86mm roll (the width the shopkeeper asked for — there's no
// physical printer calibration riding on this number the way there is
// for the admin panel's Bluetooth thermal receipts, since this is only
// ever exported as a PNG and shared as an image, never fed to a print
// bridge — so it doesn't need to line up with a real 58/80mm print head
// the way UniversalSlip.tsx does).
//
// Deliberately its own small component rather than a reuse of
// UniversalSlip: that one is the committee's own org-branded document
// (Dhab Pari name/logo/helpline, admin Settings-driven), built for
// water bills/donations/vouchers. This is one shop's own bill to its
// own customer — the shop's name is the letterhead, not the
// organisation's — so it never belonged in that template.

import { forwardRef } from 'react'

export interface SlipSaleItem {
  product_name_snapshot: string
  quantity: number
  unit_price_pkr: number
  line_total_pkr: number
  pack_label_snapshot: string | null
}
export interface SlipSaleGroup {
  sale_id: string
  created_at: string
  total_amount_pkr: number
  items: SlipSaleItem[]
}

interface Props {
  shopName: string
  shopNameUr?: string | null
  customerName: string
  customerNameUr?: string | null
  invoiceNumber: number
  periodStart: string
  periodEnd: string
  sales: SlipSaleGroup[]
  totalAmount: number
  outstandingBalance: number
  isUrdu: boolean
}

const INK = '#201e1d'
const MUTED = '#6b6560'
const ACCENT_DARK = '#ae1800'
const RULE = '#d8dce1'
const PAPER = '#ffffff'

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// A short dashed "tear here" band — the one purely decorative touch that
// makes this read as a roll receipt rather than a plain white card. Two
// diagonal gradients painting small white triangles against the rule
// color, not a real transparent cut, so it renders identically however
// html2canvas fills the page behind it.
function TearEdge() {
  return (
    <div
      style={{
        height: 8, marginTop: 2,
        backgroundImage: `linear-gradient(135deg, ${PAPER} 50%, transparent 50%), linear-gradient(45deg, ${PAPER} 50%, transparent 50%)`,
        backgroundSize: '8px 8px', backgroundPosition: '0 0, 4px 0', backgroundColor: RULE,
      }}
    />
  )
}

export const ShopInvoiceSlip = forwardRef<HTMLDivElement, Props>(function ShopInvoiceSlip(
  { shopName, shopNameUr, customerName, customerNameUr, invoiceNumber, periodStart, periodEnd, sales, totalAmount, outstandingBalance, isUrdu },
  ref
) {
  // 86mm at 96dpi (~3.78px/mm) ≈ 325px overall, padding included.
  const width = 325
  const pad = 14
  const urduFont = { fontFamily: 'var(--font-urdu), serif' } as const

  return (
    <div ref={ref} dir="ltr" style={{ width, background: PAPER, color: INK, fontFamily: 'var(--font-sans), sans-serif' }}>
      <div style={{ padding: `${pad}px ${pad}px 0` }}>
        {/* ── Letterhead: the shop's own name, not the app's ─────────── */}
        <div style={{ textAlign: 'center', borderBottom: `2px solid ${INK}`, paddingBottom: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.3 }}>{shopName}</div>
          {shopNameUr && <div style={{ ...urduFont, fontSize: 14, lineHeight: 1.9, marginTop: 1 }} dir="rtl">{shopNameUr}</div>}
          <div style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: MUTED, marginTop: 2 }}>
            {isUrdu ? 'ادھار بل' : 'CREDIT BILL'}
          </div>
        </div>

        {/* ── Meta: bill #, customer, period — all up top, as asked ──── */}
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: MUTED }}>{isUrdu ? 'بل نمبر' : 'Bill #'}</span>
            <strong>{invoiceNumber}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 3 }}>
            <span style={{ color: MUTED }}>{isUrdu ? 'مدت' : 'Period'}</span>
            <strong>{fmtDate(periodStart)} – {fmtDate(periodEnd)}</strong>
          </div>
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${RULE}` }}>
            <div style={{ color: MUTED, fontSize: 10 }}>{isUrdu ? 'گاہک' : 'Customer'}</div>
            <div style={{ fontWeight: 700, fontSize: 13, marginTop: 1 }}>{customerName}</div>
            {customerNameUr && <div style={{ ...urduFont, fontSize: 12, color: MUTED, lineHeight: 1.8 }} dir="rtl">{customerNameUr}</div>}
          </div>
        </div>

        {/* ── Line items, grouped by the visit they were sold on ─────── */}
        <div style={{ marginTop: 10 }}>
          {sales.map((sale) => (
            <div key={sale.sale_id} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9.5, color: MUTED, borderBottom: `1px solid ${INK}`, paddingBottom: 3, marginBottom: 3 }}>
                <Ltr>{fmtDate(sale.created_at)}</Ltr>
              </div>
              {sale.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 11, padding: '2px 0' }}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    {it.product_name_snapshot}{it.pack_label_snapshot ? ` (${it.pack_label_snapshot})` : ''}
                    <span style={{ color: MUTED }}> ×{fmt(it.quantity)}</span>
                  </span>
                  <span style={{ flexShrink: 0, fontWeight: 600 }}>{fmt(it.line_total_pkr)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, fontSize: 10, color: MUTED, marginTop: 2 }}>
                <span>{isUrdu ? 'ذیلی جمع' : 'Subtotal'}: <strong style={{ color: INK }}>{fmt(sale.total_amount_pkr)}</strong></span>
              </div>
            </div>
          ))}
        </div>

        {/* ── Total, then the customer's overall running balance ─────── */}
        <div style={{ borderTop: `2px solid ${INK}`, paddingTop: 6, marginTop: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{isUrdu ? 'اس بل کی رقم' : 'Bill Total'}</span>
            <span style={{ fontWeight: 700, fontSize: 17 }}>{fmt(totalAmount)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
            <span style={{ fontSize: 10.5, color: MUTED }}>{isUrdu ? 'مجموعی بقایا' : 'Outstanding Balance'}</span>
            <span style={{ fontWeight: 700, fontSize: 12, color: ACCENT_DARK }}>{fmt(outstandingBalance)}</span>
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: 10, color: MUTED, marginTop: 10, paddingBottom: 10 }}>
          {isUrdu ? 'شکریہ!' : 'Thank you!'}
        </div>
      </div>
      <TearEdge />
    </div>
  )
})

function Ltr({ children }: { children: React.ReactNode }) {
  return <span dir="ltr">{children}</span>
}
