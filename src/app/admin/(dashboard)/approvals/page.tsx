'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ShieldCheck, Check, X, Clock, ShoppingCart, Wallet, UserCog, Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface ApprovalRequest {
  id: string; reference_id: string; system: string; kind: string; particular: string; amount_pkr: number
  created_at: string; deadline_at: string; status: string
}
interface MyConfirmation { id: string; approval_request_id: string; request: ApprovalRequest }
interface RosterEntry { confirmation_id: string; approver_id: string; full_name: string; confirmed: boolean | null }
interface PurchaseLine { description: string; quantity: number; unit_cost: number }
interface VoucherDetail { voucher_type: string; from_account_id: string; to_account_id: string; party_name: string | null; attachment_url: string | null }
interface VoucherLine { account_id: string; amount: number; description: string | null }

const systemLabels: Record<string, string> = { water_supply: 'Water Supply', donors_projects: 'Donors & Projects' }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function hoursLeft(deadline: string) {
  const hrs = Math.round((new Date(deadline).getTime() - Date.now()) / 3600000)
  if (hrs <= 0) return 'due now'
  if (hrs < 24) return `${hrs}h left`
  return `${Math.round(hrs / 24)}d left`
}

export default function ApprovalsPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const [adminUserId, setAdminUserId] = useState<string | null>(null)
  const [mine, setMine] = useState<MyConfirmation[]>([])
  const [allPending, setAllPending] = useState<ApprovalRequest[]>([])
  const [rosterByRequest, setRosterByRequest] = useState<Record<string, RosterEntry[]>>({})
  const [accountNames, setAccountNames] = useState<Record<string, string>>({})
  const [voucherDetails, setVoucherDetails] = useState<Record<string, VoucherDetail>>({})
  const [purchaseLines, setPurchaseLines] = useState<Record<string, PurchaseLine[]>>({})
  const [purchaseAttachments, setPurchaseAttachments] = useState<Record<string, string | null>>({})
  const [voucherLines, setVoucherLines] = useState<Record<string, VoucherLine[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmReject, setConfirmReject] = useState<MyConfirmation | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [currentRole, setCurrentRole] = useState<string | null>(null)
  const [confirmOverride, setConfirmOverride] = useState<{ confirmationId: string; name: string } | null>(null)
  const [overrideBusyId, setOverrideBusyId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }
    const { data: me } = await supabase.from('admin_users').select('id, role').eq('auth_user_id', user.id).single()
    if (!me) { setLoading(false); return }
    setAdminUserId(me.id)
    setCurrentRole(me.role)

    const [{ data: myConfirmations }, { data: pendingRequests }, { data: accounts }] = await Promise.all([
      supabase.from('approval_confirmations').select('id, approval_request_id, approval_requests(*)').eq('approver_id', me.id).is('confirmed', null),
      supabase.from('approval_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false }),
      supabase.from('accounts').select('id, name'),
    ])

    const acctMap = Object.fromEntries((accounts ?? []).map((a) => [a.id, a.name]))
    setAccountNames(acctMap)

    const myList: MyConfirmation[] = (myConfirmations ?? [])
      .filter((c) => c.approval_requests)
      .map((c) => ({ id: c.id, approval_request_id: c.approval_request_id, request: c.approval_requests as unknown as ApprovalRequest }))
    setMine(myList)
    setAllPending(pendingRequests ?? [])

    // approval_requests.reference_id points at the real voucher/purchase row --
    // NOT the same as the request's own id (that's just this gate's own PK).
    // Looking these queries up by r.id instead meant vouchers/purchases here
    // never matched anything real, so the breakdown (and the from/to accounts,
    // and the attached bill) silently never showed for any approval, ever.
    const allRequests = [...myList.map((m) => m.request), ...(pendingRequests ?? [])]
    const voucherRequestIds = allRequests.filter((r) => r.kind === 'voucher').map((r) => r.reference_id)
    const purchaseRequestIds = allRequests.filter((r) => r.kind === 'purchase').map((r) => r.reference_id)

    if (voucherRequestIds.length > 0) {
      const { data } = await supabase.from('vouchers').select('id, voucher_type, from_account_id, to_account_id, party_name, attachment_url').in('id', voucherRequestIds)
      setVoucherDetails(Object.fromEntries((data ?? []).map((v) => [v.id, v])))

      // Multi-line vouchers (Advance Settlement, Multi-line Expense, Payslip
      // Recognition) post via voucher_line_items instead of a single
      // to_account_id — without this, a multi-line voucher here just showed
      // a bare total with no breakdown of what it's actually made of.
      const { data: lines } = await supabase.from('voucher_line_items').select('voucher_id, account_id, amount, description').in('voucher_id', voucherRequestIds)
      const vMap: Record<string, VoucherLine[]> = {}
      for (const l of lines ?? []) {
        (vMap[l.voucher_id] ??= []).push({ account_id: l.account_id, amount: l.amount, description: l.description })
      }
      setVoucherLines(vMap)
    } else {
      setVoucherDetails({})
      setVoucherLines({})
    }
    if (purchaseRequestIds.length > 0) {
      const [{ data: lines }, { data: purchases }] = await Promise.all([
        supabase.from('purchase_line_items').select('purchase_id, description, quantity, unit_cost').in('purchase_id', purchaseRequestIds),
        supabase.from('purchases').select('id, attachment_url').in('id', purchaseRequestIds),
      ])
      const pMap: Record<string, PurchaseLine[]> = {}
      for (const l of lines ?? []) {
        (pMap[l.purchase_id] ??= []).push({ description: l.description, quantity: l.quantity, unit_cost: l.unit_cost })
      }
      setPurchaseLines(pMap)
      setPurchaseAttachments(Object.fromEntries((purchases ?? []).map((p) => [p.id, p.attachment_url])))
    } else {
      setPurchaseLines({})
      setPurchaseAttachments({})
    }

    if ((pendingRequests ?? []).length > 0) {
      const { data: confirmations } = await supabase.from('approval_confirmations').select('id, approval_request_id, approver_id, confirmed').in('approval_request_id', (pendingRequests ?? []).map((r) => r.id))
      const systemsPresent = Array.from(new Set((pendingRequests ?? []).map((r) => r.system)))
      const nameMap: Record<string, string> = {}
      for (const sys of systemsPresent) {
        const { data: roster } = await supabase.rpc('get_approvers_roster', { p_system: sys })
        for (const person of roster ?? []) nameMap[person.id] = person.full_name
      }
      const grouped: Record<string, RosterEntry[]> = {}
      for (const c of confirmations ?? []) {
        (grouped[c.approval_request_id] ??= []).push({ confirmation_id: c.id, approver_id: c.approver_id, full_name: nameMap[c.approver_id] ?? 'Approver', confirmed: c.confirmed })
      }
      setRosterByRequest(grouped)
    } else {
      setRosterByRequest({})
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const decide = async (c: MyConfirmation, confirmed: boolean) => {
    setBusyId(c.id)
    const { error } = await supabase.from('approval_confirmations').update({ confirmed, decided_at: new Date().toISOString() }).eq('id', c.id)
    setBusyId(null)
    setConfirmReject(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(confirmed ? 'Confirmed' : 'Rejected — this transaction will not post')
    load()
  }

  const overrideApprove = async (confirmationId: string) => {
    setOverrideBusyId(confirmationId)
    const { error } = await supabase.rpc('override_approve_confirmation', { p_confirmation_id: confirmationId })
    setOverrideBusyId(null)
    setConfirmOverride(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Approved on their behalf')
    load()
  }

  const otherPending = useMemo(() => allPending.filter((r) => !mine.some((m) => m.approval_request_id === r.id)), [allPending, mine])

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <ShieldCheck size={26} /> {t('ap.title')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">
          Every configured approver must confirm before a transaction posts — or it auto-posts 24 hours after it was created.
        </p>
      </div>

      <div className="mb-8">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-3">Needs Your Confirmation ({mine.length})</h2>
        {mine.length === 0 ? (
          <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">
            {t('ap.nothingWaiting')}
          </div>
        ) : (
          <div className="space-y-3">
            {mine.map((c) => {
              const r = c.request
              const v = voucherDetails[r.reference_id]
              const lines = purchaseLines[r.reference_id]
              const vLines = voucherLines[r.reference_id]
              const attachmentUrl = r.kind === 'purchase' ? purchaseAttachments[r.reference_id] : v?.attachment_url
              return (
                <div key={c.id} className="bg-white rounded-lg border border-amber-300 overflow-hidden">
                  <div className="px-5 py-3.5 flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        {r.kind === 'purchase' ? <ShoppingCart size={14} className="text-amber-600" /> : <Wallet size={14} className="text-amber-600" />}
                        <span className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-wide">{systemLabels[r.system]} · {r.kind}</span>
                        <span className="flex items-center gap-1 font-sans text-[11px] font-semibold text-amber-700"><Clock size={11} /> {hoursLeft(r.deadline_at)}</span>
                      </div>
                      <p className="font-sans text-[14.5px] font-semibold text-dp-on-surface">{r.particular}</p>
                      {v && (
                        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          {accountNames[v.from_account_id] ?? '—'} → {accountNames[v.to_account_id] ?? '—'}
                          {v.party_name ? ` · ${v.party_name}` : ''}
                        </p>
                      )}
                      {lines && lines.length > 0 && (
                        <ul className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1 list-disc list-inside">
                          {lines.map((l, i) => <li key={i}>{l.description} × {l.quantity} @ Rs. {fmt(l.unit_cost)}</li>)}
                        </ul>
                      )}
                      {vLines && vLines.length > 0 && (
                        <ul className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1 list-disc list-inside">
                          {vLines.map((l, i) => <li key={i}>{l.description ?? accountNames[l.account_id] ?? 'Line'}: Rs. {fmt(l.amount)}</li>)}
                        </ul>
                      )}
                      <p className="font-sans text-[16px] font-bold text-dp-primary mt-1">Rs. {fmt(r.amount_pkr)}</p>
                      {attachmentUrl && (
                        <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[12.5px] font-semibold hover:underline mt-1">
                          <Paperclip size={13} /> {t('ap.viewAttachedBill')}
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        disabled={busyId === c.id}
                        onClick={() => decide(c, true)}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer disabled:opacity-50"
                      >
                        <Check size={14} /> {t('ap.confirm')}
                      </button>
                      <button
                        disabled={busyId === c.id}
                        onClick={() => setConfirmReject(c)}
                        className="flex items-center gap-1.5 px-3.5 py-2 border border-dp-error text-dp-error rounded-lg font-sans text-[13px] font-semibold hover:bg-red-50 transition-all cursor-pointer disabled:opacity-50"
                      >
                        <X size={14} /> {t('ap.reject')}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div>
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-3">All Pending Approvals ({otherPending.length})</h2>
        {otherPending.length === 0 ? (
          <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">
            {t('ap.nothingElse')}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start min-w-[600px]">
                <thead>
                  <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                    <th className="px-5 py-2.5">{t('w.particular')}</th>
                    <th className="px-5 py-2.5 text-end">{t('w.amount')}</th>
                    <th className="px-5 py-2.5">{t('ap.waitingOn')}</th>
                    <th className="px-5 py-2.5">{t('ap.deadline')}</th>
                  </tr>
                </thead>
                <tbody>
                  {otherPending.map((r) => {
                    const roster = rosterByRequest[r.id] ?? []
                    const waiting = roster.filter((a) => a.confirmed === null)
                    const v = voucherDetails[r.reference_id]
                    const lines = purchaseLines[r.reference_id]
                    const vLines = voucherLines[r.reference_id]
                    const hasDetail = !!v || !!(lines && lines.length > 0)
                    const expanded = expandedId === r.id
                    return (
                      <Fragment key={r.id}>
                        <tr
                          className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${hasDetail ? 'cursor-pointer hover:bg-dp-surface-container-low/40' : ''}`}
                          onClick={() => hasDetail && setExpandedId(expanded ? null : r.id)}
                        >
                          <td className="px-5 py-3">
                            <span className="font-semibold">{r.particular}</span>
                            <p className="text-[11.5px] text-dp-on-surface-variant">
                              {systemLabels[r.system]} · {r.kind}{hasDetail ? (expanded ? ' · hide detail' : ' · click to view detail') : ''}
                            </p>
                          </td>
                          <td className="px-5 py-3 text-end font-bold">Rs. {fmt(r.amount_pkr)}</td>
                          <td className="px-5 py-3 text-dp-on-surface-variant">
                            {waiting.length === 0 ? 'All confirmed' : (
                              <div className="flex flex-col gap-1">
                                {waiting.map((a) => (
                                  <span key={a.confirmation_id} className="flex items-center gap-2">
                                    {a.full_name}
                                    {currentRole === 'super_admin' && (
                                      <button
                                        disabled={overrideBusyId === a.confirmation_id}
                                        onClick={(e) => { e.stopPropagation(); setConfirmOverride({ confirmationId: a.confirmation_id, name: a.full_name }) }}
                                        title="Approve on their behalf"
                                        className="flex items-center gap-1 px-1.5 py-0.5 border border-dp-outline-variant rounded font-sans text-[10.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-40"
                                      >
                                        <UserCog size={10} /> {t('ap.approveForThem')}
                                      </button>
                                    )}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3 text-dp-on-surface-variant">{hoursLeft(r.deadline_at)}</td>
                        </tr>
                        {expanded && hasDetail && (
                          <tr className="bg-dp-surface-container-low/30 border-b border-dp-outline-variant last:border-b-0">
                            <td colSpan={4} className="px-5 py-3">
                              {v && (
                                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-1.5">
                                  {accountNames[v.from_account_id] ?? '—'} → {accountNames[v.to_account_id] ?? '—'}
                                  {v.party_name ? ` · ${v.party_name}` : ''}
                                </p>
                              )}
                              {lines && lines.length > 0 && (
                                <ul className="font-sans text-[12.5px] text-dp-on-surface-variant list-disc list-inside">
                                  {lines.map((l, i) => <li key={i}>{l.description} × {l.quantity} @ Rs. {fmt(l.unit_cost)}</li>)}
                                </ul>
                              )}
                              {vLines && vLines.length > 0 && (
                                <ul className="font-sans text-[12.5px] text-dp-on-surface-variant list-disc list-inside">
                                  {vLines.map((l, i) => <li key={i}>{l.description ?? accountNames[l.account_id] ?? 'Line'}: Rs. {fmt(l.amount)}</li>)}
                                </ul>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmReject}
        title="Reject Transaction"
        message="This transaction will never post. This cannot be undone."
        onConfirm={() => confirmReject && decide(confirmReject, false)}
        onCancel={() => setConfirmReject(null)}
      />

      <ConfirmDialog
        open={!!confirmOverride}
        title="Approve On Their Behalf"
        message={confirmOverride ? `You are about to confirm this transaction for ${confirmOverride.name}, not yourself. This is recorded as a super-admin override, not as ${confirmOverride.name}'s own decision. Use this only when they're genuinely unavailable.` : ''}
        onConfirm={() => confirmOverride && overrideApprove(confirmOverride.confirmationId)}
        onCancel={() => setConfirmOverride(null)}
      />
    </>
  )
}
