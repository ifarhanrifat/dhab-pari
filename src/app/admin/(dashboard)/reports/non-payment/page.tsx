'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, Printer, Phone } from 'lucide-react'
import { billBadge } from '@/lib/billStatus'
import { printNodeInPopup } from '@/lib/receiptExport'
import { DocumentHeader } from '@/components/admin/DocumentHeader'
import { useRef } from 'react'
import { dt, type Lang } from '@/lib/docTranslations'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface ConsumerRow { consumer_id: string; name: string; mobile: string | null; sector: string | null; status: string }
interface BillRow {
  id: string; consumer_id: string; bill_number: string | null; month: number; year: number
  amount_pkr: number; discount_amount: number | null; paid_amount: number | null; due_date: string | null
}
interface FlaggedBill { billId: string; billNumber: string | null; month: number; year: number; net: number; paid: number; outstanding: number }
interface FlaggedConsumer { consumer: ConsumerRow; bills: FlaggedBill[]; totalOutstanding: number }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function outstanding(bill: BillRow) {
  const net = Math.max(bill.amount_pkr - (bill.discount_amount ?? 0), 0)
  return Math.max(net - (bill.paid_amount ?? 0), 0)
}
const monthName = (m: number) => new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'long' })

export default function NonPaymentReportPage() {
  const { t, isUrdu } = useLocale()
  const [consumers, setConsumers] = useState<ConsumerRow[]>([])
  const [bills, setBills] = useState<BillRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sectorFilter, setSectorFilter] = useState('')
  // An internal report -- follows the admin's own chosen language rather
  // than the site's public-document branding default.
  const lang: Lang = isUrdu ? 'ur' : 'en'
  const printRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  useEffect(() => {
    setLoading(true)
    Promise.all([
      supabase.from('consumers').select('consumer_id, name, mobile, sector, status').eq('status', 'active'),
      supabase.from('bills').select('id, consumer_id, bill_number, month, year, amount_pkr, discount_amount, paid_amount, due_date'),
    ]).then(([consumersRes, billsRes]) => {
      setConsumers(consumersRes.data ?? [])
      setBills(billsRes.data ?? [])
      setLoading(false)
    })
  }, [supabase])

  const flagged = useMemo<FlaggedConsumer[]>(() => {
    const consumerById = Object.fromEntries(consumers.map((c) => [c.consumer_id, c]))
    const billsByConsumer: Record<string, BillRow[]> = {}
    for (const b of bills) {
      if (!consumerById[b.consumer_id]) continue
      ;(billsByConsumer[b.consumer_id] ??= []).push(b)
    }
    const result: FlaggedConsumer[] = []
    for (const [consumerId, cBills] of Object.entries(billsByConsumer)) {
      const sorted = [...cBills].sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month))
      const latestTwo = sorted.slice(0, 2)
      if (latestTwo.length < 2) continue
      const [a, b] = latestTwo
      const consecutive = (a.year * 12 + a.month) - (b.year * 12 + b.month) === 1
      if (!consecutive) continue
      const bothUnpaid = latestTwo.every((bill) => billBadge(bill).tone !== 'green')
      if (!bothUnpaid) continue
      // The 2-consecutive-months check above only decides WHETHER to flag this
      // consumer — once flagged, show every bill they still owe on, not just
      // the two that triggered the flag. A consumer who fully paid months 1-2,
      // partially paid month 3, then missed months 4-5 outright would
      // otherwise have month 3's partial balance silently dropped from the
      // total, understating what's actually owed.
      const allOutstanding = sorted.filter((bill) => outstanding(bill) > 0).sort((x, y) => (x.year * 12 + x.month) - (y.year * 12 + y.month))
      const flaggedBills: FlaggedBill[] = allOutstanding.map((bill) => {
        const net = Math.max(bill.amount_pkr - (bill.discount_amount ?? 0), 0)
        const paid = bill.paid_amount ?? 0
        return { billId: bill.id, billNumber: bill.bill_number, month: bill.month, year: bill.year, net, paid, outstanding: Math.max(net - paid, 0) }
      })
      result.push({
        consumer: consumerById[consumerId],
        bills: flaggedBills,
        totalOutstanding: flaggedBills.reduce((s, fb) => s + fb.outstanding, 0),
      })
    }
    return result.sort((x, y) => y.totalOutstanding - x.totalOutstanding)
  }, [consumers, bills])

  const sectors = useMemo(() => {
    const s = new Set(flagged.map((f) => f.consumer.sector).filter(Boolean) as string[])
    return Array.from(s).sort()
  }, [flagged])

  const filtered = useMemo(
    () => flagged.filter((f) => !sectorFilter || f.consumer.sector === sectorFilter),
    [flagged, sectorFilter]
  )

  const bySector = useMemo(() => {
    const groups: Record<string, FlaggedConsumer[]> = {}
    for (const f of filtered) {
      const key = f.consumer.sector || dt(lang, 'unassignedSector')
      ;(groups[key] ??= []).push(f)
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
  }, [filtered, lang])

  const totalPending = filtered.reduce((s, f) => s + f.totalOutstanding, 0)

  const handlePrint = () => {
    if (printRef.current) printNodeInPopup(printRef.current, `${dt(lang, 'reportNonPayment')} — ${dt(lang, 'waterSupplySystem')}`)
  }

  return (
    <div ref={printRef} dir={lang === 'ur' ? 'rtl' : 'ltr'} style={lang === 'ur' ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
      <DocumentHeader title={`${dt(lang, 'reportNonPayment')} — ${dt(lang, 'waterSupplySystem')}`} className="hidden print:block" />
      <div className="flex items-center justify-between mb-6 print:hidden gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2">
            <AlertTriangle size={24} className="text-amber-600" /> {dt(lang, 'reportNonPayment')}
          </h1>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">
            {dt(lang, 'nonPaymentSubtitle')}
          </p>
        </div>
        <button
          onClick={handlePrint}
          className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer"
        >
          <Printer size={15} /> {t('a.print')}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6 print:hidden">
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-1">{dt(lang, 'consumersFlagged')}</p>
          <p className="font-sans text-[20px] font-bold text-dp-primary">{filtered.length}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-1">{dt(lang, 'sectorsAffected')}</p>
          <p className="font-sans text-[20px] font-bold text-dp-primary">{bySector.length}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant mb-1">{dt(lang, 'totalPending')}</p>
          <p className="font-sans text-[20px] font-bold text-dp-error">{fmtAmount(totalPending)}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4 print:hidden">
        <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)} className="input-field max-w-xs">
          <option value="">{t('rp.allSectors')}</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {loading && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[13.5px]"><LoadingDots /></p>}
      {!loading && filtered.length === 0 && (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[13.5px]">
          {dt(lang, 'noConsumersFailedToPay')}
        </p>
      )}

      {!loading && bySector.map(([sector, list]) => (
        <div key={sector} className="mb-6">
          <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-2 flex items-center gap-2">
            {sector}
            <span className="font-sans text-[12px] font-semibold text-dp-on-surface-variant bg-dp-surface-container-low px-2 py-0.5 rounded-full">
              {list.length} consumer{list.length === 1 ? '' : 's'}
            </span>
          </h2>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden overflow-x-auto">
            <table className="w-full text-start">
              <thead>
                <tr className="bg-dp-surface-container-low/60 border-b border-dp-outline-variant">
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant">{dt(lang, 'consumer')}</th>
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant">{dt(lang, 'contact')}</th>
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant">{dt(lang, 'pendingBills')}</th>
                  <th className="px-4 py-2.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.04em] text-dp-on-surface-variant text-end">{dt(lang, 'totalOutstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.consumer.consumer_id} className="border-b border-dp-outline-variant last:border-0">
                    <td className="px-4 py-3">
                      <Link href={`/admin/accounts/${f.consumer.consumer_id}`} className="font-sans text-[13.5px] font-semibold text-dp-primary hover:underline">
                        {f.consumer.name}
                      </Link>
                      <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{f.consumer.consumer_id}</p>
                    </td>
                    <td className="px-4 py-3 font-sans text-[13px] text-dp-on-surface-variant">
                      {f.consumer.mobile ? (
                        <span className="flex items-center gap-1"><Phone size={12} /> {f.consumer.mobile}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {f.bills.map((b) => (
                        <div key={b.billId} className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          {monthName(b.month)} {b.year}{b.billNumber ? ` (${b.billNumber})` : ''} — {fmtAmount(b.outstanding)}{dt(lang, 'dueSuffix')}
                        </div>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-end font-sans text-[14px] font-bold text-dp-error">{fmtAmount(f.totalOutstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
