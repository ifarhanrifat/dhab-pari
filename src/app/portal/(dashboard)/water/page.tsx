'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { X, UploadCloud } from 'lucide-react'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { PaymentAccountDetails } from '@/components/public/PaymentAccountDetails'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import Link from 'next/link'

interface Bill {
  id: string; month: number; year: number; amount_pkr: number; paid_amount: number
  discount_amount: number; status: string; due_date: string | null; bill_number: string | null
}
interface Payment { id: string; amount_pkr: number; method: string; paid_date: string; receipt_no: string | null }
interface Claim { id: string; bill_id: string; amount_pkr: number; status: string; created_at: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
const monthName = (m: number) => new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'long' })

export default function PortalWaterPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [bills, setBills] = useState<Bill[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [claimFor, setClaimFor] = useState<Bill | null>(null)
  const [claimAmount, setClaimAmount] = useState(0)
  const [claimMethod, setClaimMethod] = useState('jazzcash')
  const [claimProof, setClaimProof] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user?.consumer_id) { setLoading(false); return }
    const supabase = createClient()
    const [billsRes, paymentsRes, claimsRes] = await Promise.all([
      supabase.from('bills').select('id, month, year, amount_pkr, paid_amount, discount_amount, status, due_date, bill_number')
        .eq('consumer_id', user.consumer_id).order('year', { ascending: false }).order('month', { ascending: false }),
      supabase.from('payments').select('id, amount_pkr, method, paid_date, receipt_no')
        .eq('consumer_id', user.consumer_id).order('paid_date', { ascending: false }).limit(20),
      supabase.from('bill_payment_claims').select('id, bill_id, amount_pkr, status, created_at').eq('portal_user_id', user.id),
    ])
    setBills(billsRes.data ?? [])
    setPayments(paymentsRes.data ?? [])
    setClaims(claimsRes.data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const openClaim = (b: Bill) => {
    setClaimFor(b)
    setClaimAmount(Number(b.amount_pkr) - Number(b.paid_amount ?? 0) - Number(b.discount_amount ?? 0))
    setClaimMethod('jazzcash')
    setClaimProof('')
  }

  const submitClaim = async () => {
    if (!user || !claimFor || !claimAmount || claimAmount <= 0 || !claimProof) { toast.error('Enter a valid amount and upload your payment slip'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('bill_payment_claims').insert({
      bill_id: claimFor.id, portal_user_id: user.id, amount_pkr: claimAmount,
      payment_method: claimMethod, payment_proof_url: claimProof,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Payment submitted — awaiting verification by the accountant')
    setClaimFor(null)
    load()
  }

  const claimStatusFor = (billId: string) => claims.find((c) => c.bill_id === billId && c.status !== 'rejected')

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  if (!user?.consumer_id) {
    return (
      <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant mb-3">{t('p.noWaterConnection')}</p>
        <Link href="/portal/profile" className="inline-block bg-dp-secondary text-white px-5 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">
          {t('p.waterConnection')}
        </Link>
      </div>
    )
  }

  const outstanding = bills.filter((b) => b.status !== 'paid').reduce((s, b) => s + (Number(b.amount_pkr) - Number(b.paid_amount ?? 0) - Number(b.discount_amount ?? 0)), 0)

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('p.waterBillsPayments')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Consumer #{user.consumer_id}</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg px-5 py-4 mb-6 inline-block">
        <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{t('p.totalOutstanding')}</p>
        <p className={`font-heading text-[24px] font-bold ${outstanding > 0 ? 'text-dp-error' : 'text-dp-secondary'}`}>Rs. {fmt(outstanding)}</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-6">
        <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low/60"><span className="font-sans text-[14px] font-bold">{t('p.bills')}</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[12px] font-sans font-bold tracking-[0.05em]">
              <th className="p-3">{t('w.period')}</th><th className="p-3">{t('p.billNo')}</th><th className="p-3 text-end">{t('w.amount')}</th><th className="p-3 text-end">{t('w.paid')}</th><th className="p-3">{t('w.status')}</th><th className="p-3">Due</th><th className="p-3 text-end">{t('w.action')}</th>
            </tr></thead>
            <tbody className="font-sans text-[14px]">
              {bills.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-dp-on-surface-variant">{t('p.noBills')}</td></tr>}
              {bills.map((b) => {
                const claim = claimStatusFor(b.id)
                return (
                  <tr key={b.id} className="border-b border-dp-outline-variant last:border-b-0">
                    <td className="p-3">{monthName(b.month)} {b.year}</td>
                    <td className="p-3 font-mono text-[13px] text-dp-on-surface-variant">{b.bill_number ?? '—'}</td>
                    <td className="p-3 text-end">Rs. {fmt(b.amount_pkr)}</td>
                    <td className="p-3 text-end">Rs. {fmt(b.paid_amount ?? 0)}</td>
                    <td className="p-3"><span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${b.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{b.status}</span></td>
                    <td className="p-3 text-dp-on-surface-variant">{b.due_date ? new Date(b.due_date).toLocaleDateString('en-GB') : '—'}</td>
                    <td className="p-3 text-end">
                      {b.status === 'paid' ? '—' : claim ? (
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${claim.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                          {claim.status === 'approved' ? 'Verified' : 'Pending Verification'}
                        </span>
                      ) : (
                        <button onClick={() => openClaim(b)} className="flex items-center gap-1.5 ms-auto px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                          <UploadCloud size={13} /> I&apos;ve Paid
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low/60"><span className="font-sans text-[14px] font-bold">{t('p.recentPayments')}</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[12px] font-sans font-bold tracking-[0.05em]">
              <th className="p-3">{t('w.date')}</th><th className="p-3">{t('p.receiptNo')}</th><th className="p-3">{t('w.method')}</th><th className="p-3 text-end">{t('w.amount')}</th>
            </tr></thead>
            <tbody className="font-sans text-[14px]">
              {payments.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-dp-on-surface-variant">{t('p.noPayments')}</td></tr>}
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-dp-outline-variant last:border-b-0">
                  <td className="p-3">{new Date(p.paid_date).toLocaleDateString('en-GB')}</td>
                  <td className="p-3 font-mono text-[13px] text-dp-on-surface-variant">{p.receipt_no ?? '—'}</td>
                  <td className="p-3 capitalize text-dp-on-surface-variant">{p.method}</td>
                  <td className="p-3 text-end font-semibold">Rs. {fmt(p.amount_pkr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {claimFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setClaimFor(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">Submit Payment — {monthName(claimFor.month)} {claimFor.year}</h2>
              <button onClick={() => setClaimFor(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.amountPaid')}</label>
                <input type="number" min={1} value={claimAmount || ''} onChange={(e) => setClaimAmount(+e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
                <select value={claimMethod} onChange={(e) => setClaimMethod(e.target.value)} className="input-field">
                  <option value="jazzcash">{t('w.jazzcash')}</option>
                  <option value="easypaisa">{t('w.easypaisa')}</option>
                  <option value="bank">{t('w.bankTransfer')}</option>
                  <option value="cash">{t('w.cash')}</option>
                </select>
                <PaymentAccountDetails system="water_supply" method={claimMethod} />
              </div>
              <DonationReceiptUpload bucket="bill_payment_proofs" label="Upload Payment Slip" onUpload={setClaimProof} />
              <button onClick={submitClaim} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? 'Submitting...' : 'Submit for Verification'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
