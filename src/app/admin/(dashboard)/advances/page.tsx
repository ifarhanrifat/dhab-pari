'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HandCoins, PlusCircle, X, Trash2, CheckCircle2, Plus, Paperclip, Eye, Pencil } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { FileAttachment } from '@/components/admin/FileAttachment'
import { QuickAddAccountModal, type NewAccount } from '@/components/admin/QuickAddAccountModal'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface AdvanceVoucher {
  id: string; voucher_no: string | null; voucher_date: string; particular: string
  amount_pkr: number; party_name: string | null; status: string; settled_at: string | null
  from_account_id: string; attachment_url: string | null
}
interface Account { id: string; code: string; name: string; type: string }
interface SettleLine { account_id: string; amount: number; description: string }

const emptyAdvanceForm = { party_name: '', amount: 0, from_account_id: '', particular: '', voucher_date: new Date().toISOString().slice(0, 10) }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function AdvancesPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [advances, setAdvances] = useState<AdvanceVoucher[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)

  const [settleTarget, setSettleTarget] = useState<AdvanceVoucher | null>(null)
  const [settleLines, setSettleLines] = useState<SettleLine[]>([{ account_id: '', amount: 0, description: '' }])
  const [settleFromAccount, setSettleFromAccount] = useState('')
  const [settleAttachment, setSettleAttachment] = useState('')
  const [settling, setSettling] = useState(false)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [canManage, setCanManage] = useState(false)

  const [viewTarget, setViewTarget] = useState<AdvanceVoucher | null>(null)
  const [viewSettlement, setViewSettlement] = useState<{ particular: string; amount_pkr: number; attachment_url: string | null; voucher_date: string } | null>(null)

  const [editTarget, setEditTarget] = useState<AdvanceVoucher | null>(null)
  const [editForm, setEditForm] = useState(emptyAdvanceForm)
  const [editing, setEditing] = useState(false)

  const [quickAddFor, setQuickAddFor] = useState<{ types: string[]; onPick: (a: NewAccount) => void } | null>(null)
  const handleAccountCreated = (a: NewAccount, onPick: (a: NewAccount) => void) => {
    setAccounts((prev) => [...prev, { id: a.id, code: a.code, name: a.name, type: a.type }])
    onPick(a)
  }

  const load = async () => {
    setLoading(true)
    const [advRes, acctRes] = await Promise.all([
      supabase.from('vouchers').select('id, voucher_no, voucher_date, particular, amount_pkr, party_name, status, settled_at, from_account_id, attachment_url')
        .eq('system', 'water_supply').eq('voucher_type', 'advance').order('voucher_date', { ascending: false }),
      supabase.from('accounts').select('id, code, name, type').eq('system', 'water_supply').eq('is_active', true),
    ])
    setAdvances(advRes.data ?? [])
    setAccounts(acctRes.data ?? [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data: me } = await supabase.from('admin_users').select('role, can_post_transactions').eq('auth_user_id', user.id).single()
      setCanManage(!!me && me.role !== 'viewer' && (me.role === 'super_admin' || me.can_post_transactions))
    })
  }, [] ) // eslint-disable-line react-hooks/exhaustive-deps

  const openView = async (a: AdvanceVoucher) => {
    setViewTarget(a)
    setViewSettlement(null)
    if (a.settled_at) {
      const { data } = await supabase.from('vouchers').select('particular, amount_pkr, attachment_url, voucher_date')
        .eq('settles_voucher_id', a.id).eq('voucher_type', 'advance_settlement').maybeSingle()
      if (data) setViewSettlement(data)
    }
  }

  const openEdit = (a: AdvanceVoucher) => {
    setEditTarget(a)
    setEditForm({ party_name: a.party_name || '', amount: a.amount_pkr, from_account_id: a.from_account_id, particular: a.particular, voucher_date: a.voucher_date })
  }

  const saveEdit = async () => {
    if (!editTarget) return
    if (!editForm.party_name.trim()) { toast.error('Enter who this advance is for'); return }
    if (!editForm.from_account_id) { toast.error('Select which account the cash is coming from'); return }
    if (!editForm.amount || editForm.amount <= 0) { toast.error('Enter a valid amount'); return }
    setEditing(true)
    const { error } = await supabase.rpc('edit_advance', {
      p_voucher_id: editTarget.id, p_amount: editForm.amount, p_from_account_id: editForm.from_account_id,
      p_particular: editForm.particular || `Advance to ${editForm.party_name}`, p_voucher_date: editForm.voucher_date, p_party_name: editForm.party_name,
    })
    setEditing(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Advance updated')
    setEditTarget(null)
    load()
  }

  const cashBankAccounts = accounts.filter((a) => a.type === 'cash' || a.type === 'bank')
  const expenseAccounts = accounts.filter((a) => a.type === 'expense')

  const openSettle = (a: AdvanceVoucher) => {
    setSettleTarget(a)
    setSettleLines([{ account_id: '', amount: 0, description: '' }])
    setSettleFromAccount(a.from_account_id)
    setSettleAttachment('')
  }

  const addSettleLine = () => setSettleLines([...settleLines, { account_id: '', amount: 0, description: '' }])
  const removeSettleLine = (i: number) => setSettleLines(settleLines.filter((_, idx) => idx !== i))
  const updateSettleLine = (i: number, patch: Partial<SettleLine>) => setSettleLines(settleLines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))

  const settleBillTotal = settleLines.reduce((s, l) => s + (l.amount || 0), 0)
  const settleDiff = settleTarget ? settleTarget.amount_pkr - settleBillTotal : 0

  const saveSettlement = async () => {
    if (!settleTarget) return
    const validLines = settleLines.filter((l) => l.account_id && l.amount > 0)
    if (validLines.length === 0) { toast.error('Add at least one bill line'); return }
    if (!settleFromAccount) { toast.error('Select the cash/bank account for any refund or top-up'); return }
    setSettling(true)

    const { data: draft, error: draftErr } = await supabase.from('vouchers').insert({
      system: 'water_supply', voucher_type: 'advance_settlement', voucher_date: new Date().toISOString().slice(0, 10),
      particular: `Settlement — ${settleTarget.party_name || settleTarget.particular}`,
      amount_pkr: 0, from_account_id: settleFromAccount, settles_voucher_id: settleTarget.id,
      party_name: settleTarget.party_name, attachment_url: settleAttachment || null, status: 'draft',
    }).select('id').single()
    if (draftErr) { toast.error(friendlyError(draftErr)); setSettling(false); return }

    const { error: linesErr } = await supabase.from('voucher_line_items').insert(
      validLines.map((l) => ({ voucher_id: draft.id, account_id: l.account_id, amount: l.amount, description: l.description || null }))
    )
    if (linesErr) { toast.error(friendlyError(linesErr)); setSettling(false); return }

    const { data: result, error: finalizeErr } = await supabase.rpc('finalize_voucher', { p_voucher_id: draft.id })
    setSettling(false)
    if (finalizeErr) { toast.error(friendlyError(finalizeErr)); return }

    if (result.status === 'pending') {
      toast.success('Settlement sent for approval')
    } else {
      const diff = settleTarget.amount_pkr - settleBillTotal
      if (diff > 0) toast.success(`Settled — Rs. ${fmt(diff)} received back`)
      else if (diff < 0) toast.success(`Settled — Rs. ${fmt(-diff)} paid extra`)
      else toast.success('Settled exactly against the advance')
    }
    setSettleTarget(null)
    load()
  }

  const deleteAdvance = async () => {
    if (!confirmDeleteId) return
    const { error } = await supabase.from('vouchers').delete().eq('id', confirmDeleteId)
    if (error) toast.error(error.message.includes('foreign key') ? 'This advance has already been settled and cannot be deleted.' : error.message)
    else { toast.success('Advance deleted'); load() }
    setConfirmDeleteId(null)
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="font-heading text-[26px] sm:text-[32px] font-bold text-dp-primary flex items-center gap-2.5">
          <HandCoins size={28} /> {t('tx.advancePayments')}
        </h1>
        {canManage && (
          <Link href="/admin/finance/water_supply" className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
            <PlusCircle size={16} /> {t('z.newAdvance')}
          </Link>
        )}
      </div>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-6">
        Cash advanced to a repair worker/contractor before their bill arrives, recorded as an "Advance Payment" transaction from Transactions. Settle it here once the real itemized bill comes in — the difference is received back or topped up automatically in the same step.
      </p>

      {loading ? (
        <p className="font-sans text-dp-on-surface-variant py-8 text-center">{t('action.loading')}</p>
      ) : advances.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('z.noAdvances')}</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden divide-y divide-dp-outline-variant">
          {advances.map((a) => (
            <div key={a.id} className="p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{a.party_name || 'Unnamed'}</p>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${a.settled_at ? 'bg-emerald-100 text-emerald-800' : a.status === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'}`}>
                    {a.settled_at ? 'Settled' : a.status === 'pending' ? 'Pending Approval' : 'Outstanding'}
                  </span>
                  {a.attachment_url && <Paperclip size={12} className="text-dp-on-surface-variant" />}
                </div>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                  {a.voucher_no || 'Pending'} · {new Date(a.voucher_date).toLocaleDateString('en-GB')} · {a.particular}
                </p>
              </div>
              <p className="font-sans text-[15px] font-bold text-dp-on-surface shrink-0">Rs. {fmt(a.amount_pkr)}</p>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => openView(a)} title="View" className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Eye size={15} /></button>
                {canManage && !a.settled_at && a.status === 'posted' && (
                  <button onClick={() => openSettle(a)} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    <CheckCircle2 size={13} /> {t('a.settle')}
                  </button>
                )}
                {canManage && !a.settled_at && (
                  <button onClick={() => openEdit(a)} title="Edit" className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={15} /></button>
                )}
                {canManage && !a.settled_at && (
                  <button onClick={() => setConfirmDeleteId(a.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title="Delete">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Settle */}
      {settleTarget && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setSettleTarget(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant shrink-0">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('z.settleAdvance')}</h2>
              <button onClick={() => setSettleTarget(null)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 flex items-center justify-between">
                <div>
                  <p className="font-sans text-[14px] font-bold text-dp-on-surface">{settleTarget.party_name}</p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{settleTarget.voucher_no}</p>
                </div>
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">Advance: Rs. {fmt(settleTarget.amount_pkr)}</p>
              </div>

              <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('z.realBillItemized')}</p>
              {settleLines.map((line, i) => (
                <div key={i} className="flex items-end gap-2 border border-dp-outline-variant rounded-lg p-3">
                  <div className="flex-1 space-y-2">
                    <select value={line.account_id} onChange={(e) => updateSettleLine(i, { account_id: e.target.value })} className="input-field">
                      <option value="">{t('rp.selectAccount')}</option>
                      {expenseAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <button type="button" onClick={() => setQuickAddFor({ types: ['expense'], onPick: (a) => handleAccountCreated(a, (acc) => updateSettleLine(i, { account_id: acc.id })) })} className="text-[12px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer">+ New Account</button>
                    <div className="grid grid-cols-2 gap-2">
                      <input type="number" min={0} value={line.amount || ''} onChange={(e) => updateSettleLine(i, { amount: +e.target.value })} placeholder="Amount" className="input-field" />
                      <input value={line.description} onChange={(e) => updateSettleLine(i, { description: e.target.value })} placeholder="Note (optional)" className="input-field" />
                    </div>
                  </div>
                  {settleLines.length > 1 && (
                    <button onClick={() => removeSettleLine(i)} className="p-2 text-dp-on-surface-variant hover:text-dp-error cursor-pointer shrink-0"><Trash2 size={15} /></button>
                  )}
                </div>
              ))}
              <button onClick={addSettleLine} className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dp-secondary text-dp-secondary rounded-full font-sans text-[13.5px] font-bold hover:bg-dp-secondary/5 transition-all cursor-pointer">
                <Plus size={15} /> {t('f.addLine')}
              </button>

              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">{t('z.cashBankAccount')}</label>
                <select value={settleFromAccount} onChange={(e) => setSettleFromAccount(e.target.value)} className="input-field">
                  <option value="">{t('rp.selectAccount')}</option>
                  {cashBankAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button type="button" onClick={() => setQuickAddFor({ types: ['cash', 'bank'], onPick: (a) => handleAccountCreated(a, (acc) => setSettleFromAccount(acc.id)) })} className="text-[12px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer mt-1">+ New Account</button>
              </div>

              <FileAttachment label="Attach Bill (optional)" currentUrl={settleAttachment} onUpload={setSettleAttachment} />

              <div className="bg-dp-surface-container-low rounded-lg p-4 space-y-1.5">
                <div className="flex justify-between font-sans text-[13.5px]"><span className="text-dp-on-surface-variant">{t('z.billTotal')}</span><span className="font-semibold">Rs. {fmt(settleBillTotal)}</span></div>
                <div className="flex justify-between font-sans text-[13.5px]"><span className="text-dp-on-surface-variant">{t('z.advanceGiven')}</span><span className="font-semibold">Rs. {fmt(settleTarget.amount_pkr)}</span></div>
                <div className="flex justify-between font-bold text-[14.5px] border-t border-dp-outline-variant pt-1.5 mt-1.5">
                  <span>{settleDiff > 0 ? 'Refund Due Back' : settleDiff < 0 ? 'Extra To Pay' : 'Fully Settled'}</span>
                  <span className={settleDiff > 0 ? 'text-emerald-700' : settleDiff < 0 ? 'text-dp-error' : 'text-dp-on-surface'}>Rs. {fmt(Math.abs(settleDiff))}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant shrink-0">
              <button onClick={() => setSettleTarget(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">{t('action.cancel')}</button>
              <button disabled={settling} onClick={saveSettlement} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {settling ? 'Settling...' : 'Confirm Settlement'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View */}
      {viewTarget && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setViewTarget(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('z.advanceDetails')}</h2>
              <button onClick={() => setViewTarget(null)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-3 font-sans text-[13.5px]">
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('z.paidTo')}</span><span className="font-semibold">{viewTarget.party_name || 'Unnamed'}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('z.voucherNo')}</span><span className="font-semibold">{viewTarget.voucher_no || 'Pending'}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('w.date')}</span><span className="font-semibold">{new Date(viewTarget.voucher_date).toLocaleDateString('en-GB')}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('w.amount')}</span><span className="font-bold">Rs. {fmt(viewTarget.amount_pkr)}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('a.note')}</span><span className="text-end">{viewTarget.particular}</span></div>
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('w.status')}</span><span className="font-semibold">{viewTarget.settled_at ? 'Settled' : viewTarget.status === 'pending' ? 'Pending Approval' : 'Outstanding'}</span></div>
              {viewSettlement && (
                <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-2 mt-2">
                  <p className="font-bold text-dp-on-surface-variant uppercase text-[11px] tracking-[0.05em]">{t('z.settlement')}</p>
                  <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('w.date')}</span><span>{new Date(viewSettlement.voucher_date).toLocaleDateString('en-GB')}</span></div>
                  <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('z.realBillTotal')}</span><span className="font-semibold">Rs. {fmt(viewSettlement.amount_pkr)}</span></div>
                  {viewSettlement.attachment_url && (
                    <a href={viewSettlement.attachment_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-dp-secondary font-semibold hover:underline">
                      <Paperclip size={13} /> {t('ap.viewAttachedBill')}
                    </a>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setViewTarget(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">{t('g.close')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setEditTarget(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('z.editAdvance')}</h2>
              <button onClick={() => setEditTarget(null)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">{t('z.paidTo')}</label>
                <input value={editForm.party_name} onChange={(e) => setEditForm({ ...editForm, party_name: e.target.value })} placeholder="Worker / contractor name" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">{t('w.amount')}</label>
                <input type="number" min={0} value={editForm.amount || ''} onChange={(e) => setEditForm({ ...editForm, amount: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">{t('em.paidFrom')}</label>
                <select value={editForm.from_account_id} onChange={(e) => setEditForm({ ...editForm, from_account_id: e.target.value })} className="input-field">
                  <option value="">{t('rp.selectAccount')}</option>
                  {cashBankAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button type="button" onClick={() => setQuickAddFor({ types: ['cash', 'bank'], onPick: (a) => handleAccountCreated(a, (acc) => setEditForm({ ...editForm, from_account_id: acc.id })) })} className="text-[12px] font-sans font-semibold text-dp-secondary hover:underline cursor-pointer mt-1">+ New Account</button>
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">{t('w.date')}</label>
                <input type="date" value={editForm.voucher_date} onChange={(e) => setEditForm({ ...editForm, voucher_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">{t('a.noteOptional')}</label>
                <input value={editForm.particular} onChange={(e) => setEditForm({ ...editForm, particular: e.target.value })} placeholder="e.g. pipe repair, sector 4" className="input-field" />
              </div>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setEditTarget(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">{t('action.cancel')}</button>
              <button disabled={editing} onClick={saveEdit} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {editing ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Delete Advance"
        message="This permanently removes the advance and reverses its ledger entry. This cannot be undone."
        onConfirm={deleteAdvance}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {quickAddFor && (
        <QuickAddAccountModal
          system="water_supply" allowedTypes={quickAddFor.types}
          onClose={() => setQuickAddFor(null)}
          onCreated={(a) => quickAddFor.onPick(a)}
        />
      )}
    </div>
  )
}
