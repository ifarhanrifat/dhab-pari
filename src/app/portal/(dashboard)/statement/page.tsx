'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HeartHandshake, X } from 'lucide-react'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface LedgerRow { id: string; entry_date: string; particular: string; debit: number; credit: number }
interface AccountInfo { donor_account_no: string | null; opening_balance: number }
interface DonationRow { id: string; amount_pkr: number; date: string; payment_status: string; is_verified: boolean; project_id: string | null }
// A Kafalat/Wazifa/Sadqa announcement, read the same way a project pledge
// is — one "Pay Now" flow for every fund, with its own label attached.
interface PoolPending { id: string; source: 'pool'; amount_pkr: number; date: string; has_proof: boolean; particular: string }
type PayTarget = { kind: 'donor'; id: string } | { kind: 'pool'; id: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function PortalStatementPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [donations, setDonations] = useState<DonationRow[]>([])
  const [poolPending, setPoolPending] = useState<PoolPending[]>([])
  const [loading, setLoading] = useState(true)
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null)
  const [payProof, setPayProof] = useState('')
  const [payMethod, setPayMethod] = useState('jazzcash')
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const [donationsRes, acctRes, ledgerRes, poolRes] = await Promise.all([
      supabase.from('donors').select('id, amount_pkr, date, payment_status, is_verified, project_id').eq('portal_user_id', user.id).order('date', { ascending: false }),
      user.donor_account_id ? supabase.from('accounts').select('donor_account_no, opening_balance').eq('id', user.donor_account_id).single() : Promise.resolve({ data: null }),
      user.donor_account_id ? supabase.from('ledger_entries').select('id, entry_date, particular, debit, credit').eq('account_id', user.donor_account_id)
        .order('entry_date', { ascending: true }).order('created_at', { ascending: true }) : Promise.resolve({ data: [] }),
      supabase.rpc('my_pool_pending_payments'),
    ])
    setDonations(donationsRes.data ?? [])
    setAccount(acctRes.data ?? null)
    setRows((ledgerRes.data as LedgerRow[]) ?? [])
    setPoolPending((poolRes.data ?? []) as PoolPending[])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const payPledge = async () => {
    if (!payTarget || !payProof) { toast.error('Upload your payment slip'); return }
    setSubmitting(true)
    const supabase = createClient()
    const { error } = payTarget.kind === 'donor'
      ? await supabase.rpc('submit_pledge_payment', { p_donor_id: payTarget.id, p_payment_proof_url: payProof, p_payment_method: payMethod })
      : await supabase.rpc('pool_submit_pledge_payment', { p_payment_id: payTarget.id, p_proof_url: payProof, p_method: payMethod })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Payment submitted — awaiting verification')
    setPayTarget(null)
    setPayProof('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  const pledges = donations.filter((d) => d.payment_status === 'pledged')
  // Paid but not yet verified by the committee. Until now this showed nowhere:
  // the donor paid, uploaded proof, and the money vanished from their view —
  // not in the pledges box (it is no longer a pledge) and not in the statement
  // (nothing posts to the ledger until an admin confirms). Silence at exactly
  // the moment a donor most wants reassurance.
  const awaiting = donations.filter((d) => d.payment_status !== 'pledged' && !d.is_verified)
  // Kafalat/Wazifa/Sadqa announcements slot into the same two boxes as a
  // general pledge: still needs sending (no proof yet) joins "Announced
  // Pledges", already sent (proof attached) joins "Paid, awaiting
  // confirmation" — one payment flow, every fund, with its own label.
  const poolNeedsPay = poolPending.filter((p) => !p.has_proof)
  const poolAwaiting = poolPending.filter((p) => p.has_proof)
  let running = account?.opening_balance ?? 0
  const withBalance = rows.map((r) => { running += Number(r.credit) - Number(r.debit); return { ...r, balance: running } })
  const total = withBalance.length > 0 ? withBalance[withBalance.length - 1].balance : 0

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('p.givingStatement')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{account?.donor_account_no ? `Donor Account: ${account.donor_account_no}` : 'No confirmed donations yet'}</p>
      </div>

      {(pledges.length > 0 || poolNeedsPay.length > 0) && (
        <div className="bg-white rounded-lg border border-amber-200 overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-amber-200 bg-amber-50"><span className="font-sans text-[14px] font-bold text-amber-800">{t('p.announcedPledges')}</span></div>
          {pledges.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold">Rs. {fmt(p.amount_pkr)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">Pledged {new Date(p.date).toLocaleDateString('en-GB')}</p>
              </div>
              <button onClick={() => { setPayTarget({ kind: 'donor', id: p.id }); setPayProof(''); setPayMethod('jazzcash') }} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                {t('p.payNow')}
              </button>
            </div>
          ))}
          {poolNeedsPay.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold">Rs. {fmt(p.amount_pkr)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{p.particular} · Pledged {new Date(p.date).toLocaleDateString('en-GB')}</p>
              </div>
              <button onClick={() => { setPayTarget({ kind: 'pool', id: p.id }); setPayProof(''); setPayMethod('jazzcash') }} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
                {t('p.payNow')}
              </button>
            </div>
          ))}
        </div>
      )}

      {(awaiting.length > 0 || poolAwaiting.length > 0) && (
        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low">
            <span className="font-sans text-[14px] font-bold text-dp-on-surface">{t('p.paidAwaiting')}</span>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
              We have your payment on record. It will appear in your statement below once the committee confirms it.
            </p>
          </div>
          {awaiting.map((d) => (
            <div key={d.id} className="flex items-center justify-between px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold">Rs. {fmt(d.amount_pkr)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">Paid {new Date(d.date).toLocaleDateString('en-GB')}</p>
              </div>
              <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-sans text-[11.5px] font-bold">{t('p.awaitingConfirmation')}</span>
            </div>
          ))}
          {poolAwaiting.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold">Rs. {fmt(p.amount_pkr)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{p.particular} · Paid {new Date(p.date).toLocaleDateString('en-GB')}</p>
              </div>
              <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-sans text-[11.5px] font-bold">{t('p.awaitingConfirmation')}</span>
            </div>
          ))}
        </div>
      )}

      {!account?.donor_account_no ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <HeartHandshake size={32} className="mx-auto text-dp-on-surface-variant mb-3" />
          <p className="font-sans text-[14px] text-dp-on-surface-variant">Your giving statement will appear here once your first donation is verified.</p>
          <a href="/donate/submit" className="inline-block mt-4 bg-dp-secondary text-white px-5 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">{t('p.makeDonation')}</a>
        </div>
      ) : (
        <>
          <div className="bg-white border border-dp-outline-variant rounded-lg px-5 py-4 mb-6 inline-block">
            <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{t('p.totalContributed')}</p>
            <p className="font-heading text-[24px] font-bold text-dp-secondary">Rs. {fmt(total)}</p>
          </div>

          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="bg-dp-surface-container-low text-dp-outline text-[12px] font-sans font-bold tracking-[0.05em]">
                    <th className="p-3">{t('w.date')}</th><th className="p-3">{t('w.particular')}</th><th className="p-3 text-end">{t('w.amount')}</th><th className="p-3 text-end">{t('p.runningTotal')}</th>
                  </tr>
                </thead>
                <tbody className="font-sans text-[14px]">
                  {withBalance.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-dp-on-surface-variant">{t('p.noDonations')}</td></tr>}
                  {withBalance.map((r) => (
                    <tr key={r.id} className="border-b border-dp-outline-variant last:border-b-0">
                      <td className="p-3 whitespace-nowrap">{new Date(r.entry_date).toLocaleDateString('en-GB')}</td>
                      <td className="p-3">{r.particular}</td>
                      <td className="p-3 text-end font-semibold">{Number(r.credit) > 0 ? `Rs. ${fmt(r.credit)}` : '—'}</td>
                      <td className="p-3 text-end font-bold text-dp-secondary">Rs. {fmt(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {payTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('p.payYourPledge')}</h2>
              <button onClick={() => setPayTarget(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
                <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="input-field">
                  <option value="jazzcash">{t('w.jazzcash')}</option>
                  <option value="easypaisa">{t('w.easypaisa')}</option>
                  <option value="bank">{t('w.bankTransfer')}</option>
                </select>
              </div>
              <DonationReceiptUpload onUpload={setPayProof} />
              <button onClick={payPledge} disabled={submitting} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {submitting ? 'Submitting...' : 'Submit Payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
