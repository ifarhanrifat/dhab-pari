'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HeartHandshake, X, CheckSquare, Square } from 'lucide-react'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { PaymentAccountDetails } from '@/components/public/PaymentAccountDetails'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'

interface LedgerRow { id: string; entry_date: string; particular: string; debit: number; credit: number }
interface AccountInfo { donor_account_no: string | null; opening_balance: number }
interface DonationRow { id: string; amount_pkr: number; date: string; payment_status: string; is_verified: boolean; project_id: string | null; announced_amount_pkr: number }
// A confirmed Kafalat/Wazifa/Sadqa payment — announced_amount_pkr is what
// was pledged, frozen the moment it was announced; amount_pkr is what the
// committee actually confirmed, which can be less.
interface PoolReceipt { id: string; pool: string; pool_ur: string | null; particular: string; amount_pkr: number; announced_amount_pkr: number; confirmed_at: string }
// A Kafalat/Wazifa/Sadqa announcement, read the same way a project pledge
// is — one "Pay Now" flow for every fund, with its own label attached.
interface PoolPending { id: string; source: 'pool'; amount_pkr: number; date: string; has_proof: boolean; particular: string }

// Every still-unpaid pledge, whichever table it actually lives in, in one
// shape — so a donor with a Kafalat share for two children and a Wazifa
// share can select all three and send one bank transfer for the lot,
// rather than three separate transfers because our own screens never
// let them see it as one number.
interface PendingItem { key: string; kind: 'donor' | 'pool'; id: string; amount: number; label: string; date: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function PortalStatementPage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">…</div>}>
      <PortalStatementInner />
    </Suspense>
  )
}

function PortalStatementInner() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const searchParams = useSearchParams()
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [donations, setDonations] = useState<DonationRow[]>([])
  const [poolPending, setPoolPending] = useState<PoolPending[]>([])
  const [poolReceipts, setPoolReceipts] = useState<PoolReceipt[]>([])
  const [loading, setLoading] = useState(true)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showPay, setShowPay] = useState(false)
  const [payProof, setPayProof] = useState('')
  const [payMethod, setPayMethod] = useState('bank')
  const [international, setInternational] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Arrived here from a "Confirm your payment" button on a Kafalat/Wazifa/
  // Sadqa card — select just that one item and open straight to it, rather
  // than making them find and tick it themselves.
  const [autoOpened, setAutoOpened] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const [donationsRes, acctRes, ledgerRes, poolRes, poolReceiptsRes] = await Promise.all([
      supabase.from('donors').select('id, amount_pkr, date, payment_status, is_verified, project_id, announced_amount_pkr').eq('portal_user_id', user.id).order('date', { ascending: false }),
      user.donor_account_id ? supabase.from('accounts').select('donor_account_no, opening_balance').eq('id', user.donor_account_id).single() : Promise.resolve({ data: null }),
      user.donor_account_id ? supabase.from('ledger_entries').select('id, entry_date, particular, debit, credit').eq('account_id', user.donor_account_id)
        .order('entry_date', { ascending: true }).order('created_at', { ascending: true }) : Promise.resolve({ data: [] }),
      supabase.rpc('my_pool_pending_payments'),
      supabase.rpc('my_recent_pool_receipts'),
    ])
    setDonations(donationsRes.data ?? [])
    setAccount(acctRes.data ?? null)
    setRows((ledgerRes.data as LedgerRow[]) ?? [])
    setPoolPending((poolRes.data ?? []) as PoolPending[])
    setPoolReceipts((poolReceiptsRes.data ?? []) as PoolReceipt[])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const pledges = donations.filter((d) => d.payment_status === 'pledged')
  // Paid but not yet verified by the committee. Until now this showed nowhere:
  // the donor paid, uploaded proof, and the money vanished from their view —
  // not in the pledges box (it is no longer a pledge) and not in the statement
  // (nothing posts to the ledger until an admin confirms). Silence at exactly
  // the moment a donor most wants reassurance.
  const awaiting = donations.filter((d) => d.payment_status !== 'pledged' && !d.is_verified)
  const poolNeedsPay = poolPending.filter((p) => !p.has_proof)
  const poolAwaiting = poolPending.filter((p) => p.has_proof)

  // Confirmed, but for less than what was pledged — announced_amount_pkr is
  // frozen at announce/pledge time, so a shortfall stays visible here
  // instead of a single ambiguous "confirmed" number quietly covering it up.
  const partialDonations = donations.filter((d) => d.is_verified && d.amount_pkr < d.announced_amount_pkr)
  const partialPoolReceipts = poolReceipts.filter((p) => p.amount_pkr < p.announced_amount_pkr)

  const pendingItems: PendingItem[] = [
    ...pledges.map((p): PendingItem => ({ key: `donor:${p.id}`, kind: 'donor', id: p.id, amount: p.amount_pkr, label: t('p.generalGiving'), date: p.date })),
    ...poolNeedsPay.map((p): PendingItem => ({ key: `pool:${p.id}`, kind: 'pool', id: p.id, amount: p.amount_pkr, label: p.particular, date: p.date })),
  ]

  // Every still-unpaid item is selected by default — most donors sending one
  // transfer want it to cover everything they owe. Unticking one is one tap,
  // for the donor who deliberately wants to send them separately.
  useEffect(() => {
    if (!loading) setSelected(new Set(pendingItems.map((i) => i.key)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, donations.length, poolPending.length])

  useEffect(() => {
    if (autoOpened || loading) return
    const payId = searchParams.get('pay')
    if (!payId) { setAutoOpened(true); return }
    const match = pendingItems.find((i) => i.kind === 'pool' && i.id === payId)
    if (match) {
      setSelected(new Set([match.key]))
      setPayProof('')
      setPayMethod('bank')
      setShowPay(true)
    }
    setAutoOpened(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpened, loading, searchParams])

  const toggleSelect = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key); else next.add(key)
    setSelected(next)
  }

  const selectedItems = pendingItems.filter((i) => selected.has(i.key))
  const selectedTotal = selectedItems.reduce((s, i) => s + i.amount, 0)

  const payPledge = async () => {
    if (selectedItems.length === 0) { toast.error(t('p.selectItemToPay')); return }
    if (!payProof) { toast.error(t('p.uploadPaymentSlip')); return }
    setSubmitting(true)
    const supabase = createClient()
    const donorIds = selectedItems.filter((i) => i.kind === 'donor').map((i) => i.id)
    const poolIds = selectedItems.filter((i) => i.kind === 'pool').map((i) => i.id)
    const { error } = await supabase.rpc('submit_combined_pledge_payment', {
      p_donor_ids: donorIds, p_pool_payment_ids: poolIds, p_proof_url: payProof, p_method: payMethod,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.paymentSubmittedAwaiting'))
    setShowPay(false)
    setPayProof('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  let running = account?.opening_balance ?? 0
  const withBalance = rows.map((r) => { running += Number(r.credit) - Number(r.debit); return { ...r, balance: running } })
  const total = withBalance.length > 0 ? withBalance[withBalance.length - 1].balance : 0

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2">{t('p.givingStatement')} <PortalHelp pageKey="statement" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{account?.donor_account_no ? `${t('p.donorAccountLabel')}: ${account.donor_account_no}` : t('p.noConfirmedDonationsYet')}</p>
      </div>

      {pendingItems.length > 0 && (
        <div className="bg-white rounded-lg border border-amber-200 overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-amber-200 bg-amber-50 flex items-center justify-between flex-wrap gap-2">
            <span className="font-sans text-[14px] font-bold text-amber-800">{t('p.announcedPledges')}</span>
            {pendingItems.length > 1 && (
              <span className="font-sans text-[12px] text-amber-800">{t('p.sendingOneForSeveral')}</span>
            )}
          </div>
          {pendingItems.map((item) => (
            <button key={item.key} onClick={() => toggleSelect(item.key)}
              className="w-full flex items-center justify-between gap-3 px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0 text-start cursor-pointer hover:bg-dp-surface-container-low/60 transition-all">
              <div className="flex items-center gap-3 min-w-0">
                {selected.has(item.key) ? <CheckSquare size={18} className="text-dp-secondary shrink-0" /> : <Square size={18} className="text-dp-on-surface-variant shrink-0" />}
                <div className="min-w-0">
                  <p className="font-sans text-[15px] font-bold">Rs. {fmt(item.amount)}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant truncate">{item.label} · {t('p.pledgedOn')} {new Date(item.date).toLocaleDateString('en-GB')}</p>
                </div>
              </div>
            </button>
          ))}
          <div className="px-5 py-3.5 bg-dp-surface-container-low flex items-center justify-between gap-3">
            <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
              {selectedItems.length} {t('p.selectedTotalLabel')} <span className="text-dp-secondary">Rs. {fmt(selectedTotal)}</span>
            </p>
            <button disabled={selectedItems.length === 0} onClick={() => { setPayProof(''); setPayMethod('bank'); setShowPay(true) }}
              className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              {t('p.payNow')}
            </button>
          </div>
        </div>
      )}

      {(partialDonations.length > 0 || partialPoolReceipts.length > 0) && (
        <div className="bg-white rounded-lg border border-orange-200 overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-orange-200 bg-orange-50">
            <span className="font-sans text-[14px] font-bold text-orange-800">{t('p.partialReceived')}</span>
            <p className="font-sans text-[12px] text-orange-800 mt-0.5">{t('p.partialReceivedBlurb')}</p>
          </div>
          {partialDonations.map((d) => (
            <div key={`d-${d.id}`} className="px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <p className="font-sans text-[13.5px] text-dp-on-surface">
                <span className="font-bold text-dp-secondary">Rs. {fmt(d.amount_pkr)}</span> {t('p.receivedOf')} <span className="font-bold">Rs. {fmt(d.announced_amount_pkr)}</span> {t('p.pledgedWord')}
              </p>
              <p className="font-sans text-[12px] text-orange-700 mt-0.5">{t('p.stillOwed').replace('{amt}', fmt(d.announced_amount_pkr - d.amount_pkr))}</p>
            </div>
          ))}
          {partialPoolReceipts.map((p) => (
            <div key={`p-${p.id}`} className="px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <p className="font-sans text-[13.5px] text-dp-on-surface">
                <span className="font-bold text-dp-secondary">Rs. {fmt(p.amount_pkr)}</span> {t('p.receivedOf')} <span className="font-bold">Rs. {fmt(p.announced_amount_pkr)}</span> {t('p.pledgedWord')} — {p.particular}
              </p>
              <p className="font-sans text-[12px] text-orange-700 mt-0.5">{t('p.stillOwed').replace('{amt}', fmt(p.announced_amount_pkr - p.amount_pkr))}</p>
            </div>
          ))}
        </div>
      )}

      {(awaiting.length > 0 || poolAwaiting.length > 0) && (
        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low">
            <span className="font-sans text-[14px] font-bold text-dp-on-surface">{t('p.paidAwaiting')}</span>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
              {t('p.paymentOnRecordNote')}
            </p>
          </div>
          {awaiting.map((d) => (
            <div key={d.id} className="flex items-center justify-between px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold">Rs. {fmt(d.amount_pkr)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('p.paidOn')} {new Date(d.date).toLocaleDateString('en-GB')}</p>
              </div>
              <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-sans text-[11.5px] font-bold">{t('p.awaitingConfirmation')}</span>
            </div>
          ))}
          {poolAwaiting.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold">Rs. {fmt(p.amount_pkr)}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{p.particular} · {t('p.paidOn')} {new Date(p.date).toLocaleDateString('en-GB')}</p>
              </div>
              <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-sans text-[11.5px] font-bold">{t('p.awaitingConfirmation')}</span>
            </div>
          ))}
        </div>
      )}

      {!account?.donor_account_no ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <HeartHandshake size={32} className="mx-auto text-dp-on-surface-variant mb-3" />
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('p.statementAppearsHere')}</p>
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

      {showPay && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowPay(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('p.payYourPledge')}</h2>
              <button onClick={() => setShowPay(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <p className="font-heading text-[22px] font-bold text-dp-primary">Rs. {fmt(selectedTotal)}</p>
              {selectedItems.length > 1 ? (
                <div className="mt-1.5 space-y-0.5">
                  {selectedItems.map((i) => (
                    <p key={i.key} className="font-sans text-[11.5px] text-dp-on-surface-variant flex justify-between gap-2">
                      <span className="truncate">{i.label}</span><span className="shrink-0">Rs. {fmt(i.amount)}</span>
                    </p>
                  ))}
                </div>
              ) : selectedItems[0] && (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{selectedItems[0].label}</p>
              )}
            </div>
            <div className="space-y-4">
              <label className="flex items-start gap-2 cursor-pointer font-sans text-[12.5px]">
                <input type="checkbox" checked={international} onChange={(e) => { setInternational(e.target.checked); if (e.target.checked) setPayMethod('bank') }} className="accent-dp-secondary mt-0.5" />
                <span>{t('p.sendingFromAbroad')}</span>
              </label>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.bankTransfer')}</label>
                <PaymentAccountDetails system="donors_projects" method={payMethod} international={international} />
              </div>
              <DonationReceiptUpload onUpload={setPayProof} />
              <button onClick={payPledge} disabled={submitting} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {submitting ? t('p.submitting') : t('p.submitPayment')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
