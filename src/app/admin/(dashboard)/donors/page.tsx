'use client'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, CheckCircle, XCircle, ShieldCheck, Image as ImageIcon, Search, Clock, Paperclip, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { BulkActionsBar } from '@/components/admin/BulkActionsBar'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { normalizePakPhone } from '@/lib/receiptExport'
import { renderTemplate } from '@/lib/messageTemplates'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { donorReceiptTotals } from '@/lib/donorReceiptTotals'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Donor {
  id: string; name: string; name_ur: string | null; phone: string | null; father_husband_name: string | null
  whatsapp_number: string | null; donor_type: string | null; donor_location: string | null; amount_pkr: number; date: string
  is_anonymous: boolean; is_verified: boolean; payment_method: string | null; notes: string | null
  project_id: string | null; payment_proof_url: string | null; submitted_via: string; voucher_no: string | null
  payment_status: string | null
  recurring_schedule_id: string | null
  announced_amount_pkr: number
  confirmed_at: string | null
  fund_type: string | null
  payment_batch_id: string | null
}

// "Staff"/"Public" in the Source column says how the donation was entered —
// it has nothing to do with what the money is for, but read on its own it
// looks exactly like a category ("filed under Staff"). Kafalat/Wazifa/Sadqa
// giving confirmed through the pool system carries its purpose right in
// notes (set by pool_post_confirmed_payment); fall back to fund_type for
// anything fund-tagged that didn't come through a pool.
function fundBadge(d: Donor): { label: string; className: string } | null {
  const notes = d.notes ?? ''
  if (notes.includes('Mushtarka Kafalat')) return { label: 'Kafalat', className: 'bg-rose-100 text-rose-700' }
  if (notes.includes('Mushtarka Taleemi Wazifa')) return { label: 'Wazifa', className: 'bg-amber-100 text-amber-800' }
  if (notes.includes('Mushtarka Sadqa')) return { label: 'Sadqa Upkeep', className: 'bg-emerald-100 text-emerald-700' }
  if (d.fund_type === 'kafalat') return { label: 'Kafalat', className: 'bg-rose-100 text-rose-700' }
  if (d.fund_type === 'zakat') return { label: 'Zakat', className: 'bg-teal-100 text-teal-700' }
  if (d.fund_type === 'sadqa') return { label: 'Sadqa', className: 'bg-emerald-100 text-emerald-700' }
  return null
}
interface Project { id: string; title: string; display_name: string | null }
// One real-world bank transfer covering several pledges (migration 254) —
// the review unit this panel works in, rather than the individual rows
// each pledge still is everywhere else in the app.
interface PendingBatch {
  batch_id: string; donor_name: string | null; proof_url: string | null
  method: string | null; total: number; count: number; earliest: string
}
interface BatchItem { kind: 'donor' | 'pool'; id: string; amount: number; label: string }
type SortKey = 'name' | 'account' | 'amount' | 'date' | 'status'

// The full donor list still loads in one query (accurate search/sort needs
// the whole dataset, not just one page of it) — but with a live donor count
// in the thousands, mounting every row as a DOM card/row at once is what
// actually made this page unusable on a phone (measured: page height past
// 140,000px). Pagination here only caps what gets rendered, never what gets
// searched — search and sort still run over every donor, same as before.
const PAGE_SIZE = 50

const empty = {
  name: '', name_ur: '', phone: '', father_husband_name: '', whatsapp_number: '', donor_type: 'villager', donor_location: '',
  amount_pkr: 0, date: new Date().toISOString().split('T')[0], is_anonymous: false, payment_method: 'cash',
  notes: '', project_id: '',
}

// donor_key_for(name, phone) mirrored client-side (migration 007: phone if
// present else lowercased/trimmed name) — the only way to map a donation row
// to its ledger account's donor_account_no without a server-side join, since
// accounts.donor_key isn't exposed on the donors table itself.
function donorKeyFor(name: string, phone: string | null) {
  const p = (phone ?? '').trim()
  return (p !== '' ? p : name.trim()).toLowerCase()
}

export default function AdminDonorsPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <AdminDonorsPageInner />
    </Suspense>
  )
}

function AdminDonorsPageInner() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const searchParams = useSearchParams()
  const [donorSearch, setDonorSearch] = useState('')
  const [proofLoadingId, setProofLoadingId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [donors, setDonors] = useState<Donor[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [accountNoByKey, setAccountNoByKey] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editTarget, setEditTarget] = useState<Donor | null>(null)
  const [editForm, setEditForm] = useState(empty)
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [viewReceipt, setViewReceipt] = useState<ReceiptData | null>(null)
  const [confirmedWhatsapp, setConfirmedWhatsapp] = useState<string | null>(null)
  const [thankYouMessage, setThankYouMessage] = useState<string | null>(null)
  const [batchSummary, setBatchSummary] = useState<Record<string, { count: number; total: number }>>({})
  const [pendingBatches, setPendingBatches] = useState<PendingBatch[]>([])
  const [reviewBatch, setReviewBatch] = useState<PendingBatch | null>(null)
  const [batchItems, setBatchItems] = useState<BatchItem[] | null>(null)
  const [batchProofUrl, setBatchProofUrl] = useState<string | null>(null)
  const [confirmingBatch, setConfirmingBatch] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const [donorsRes, projectsRes, accountsRes] = await Promise.all([
      supabase.from('donors').select('*').order('date', { ascending: false }),
      supabase.from('projects').select('id, title, display_name').order('title'),
      supabase.from('accounts').select('donor_key, donor_account_no').eq('system', 'donors_projects').eq('type', 'donor').not('donor_account_no', 'is', null),
    ])
    setDonors(donorsRes.data ?? [])
    setProjects(projectsRes.data ?? [])
    setAccountNoByKey(new Map((accountsRes.data ?? []).map((a) => [a.donor_key as string, a.donor_account_no as string])))
    // A batch can span both this table and pool_payments (Kafalat/Wazifa/
    // Sadqa) at once — payment_batch_summary() aggregates both, so the
    // count/total shown here is the real one even when part of the same
    // payment lives on a different admin page entirely.
    const batchIds = Array.from(new Set((donorsRes.data ?? []).filter((d) => d.payment_batch_id && !d.is_verified).map((d) => d.payment_batch_id as string)))
    if (batchIds.length > 0) {
      const { data: bs } = await supabase.rpc('payment_batch_summary', { p_batch_ids: batchIds })
      setBatchSummary((bs ?? {}) as Record<string, { count: number; total: number }>)
    } else {
      setBatchSummary({})
    }
    const { data: pb } = await supabase.rpc('pending_payment_batches')
    setPendingBatches((pb ?? []) as PendingBatch[])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // Deep-linked from the finance page's Recent Transactions "Edit" button
  // (/admin/donors?edit=<id>) — same open-a-modal-via-query-param pattern
  // already used for editing bills from that page.
  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId || donors.length === 0) return
    const d = donors.find((x) => x.id === editId)
    if (d) openEdit(d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [donors.length, searchParams])

  // Only feeds the outbound WhatsApp thank-you text and the printed
  // receipt (both handed to the donor) — prefers the public display_name
  // (364) over the real title for the same reason a receipt does.
  const projectTitle = (id: string | null) => {
    const p = projects.find((p) => p.id === id)
    return p ? (p.display_name || p.title) : null
  }

  const save = async () => {
    if (!form.name.trim()) { toast.error(t('dn.nameRequired')); return }
    const payload = { ...form, name_ur: form.name_ur || null, project_id: form.project_id || null, notes: form.notes || null, phone: form.phone || null, father_husband_name: form.father_husband_name || null, whatsapp_number: form.whatsapp_number || null }
    const { data, error } = await supabase.from('donors').insert({ ...payload, is_verified: true, submitted_via: 'staff' }).select('id').single()
    if (error) { toast.error(friendlyError(error)); return }
    // Staff-entered donations post to the ledger immediately (is_verified is
    // already true above) but, unlike confirm_donation()'s flow, never got a
    // voucher_no/donor_account_no on their own — assign them now the same way.
    if (data) await supabase.rpc('assign_donor_numbers', { p_donor_id: data.id })
    toast.success(t('dn.donorAdded')); setShowForm(false); setForm(empty); load()
  }

  const unverify = async (id: string) => {
    await supabase.from('donors').update({ is_verified: false }).eq('id', id)
    toast.success(t('dn.unverified')); load()
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Selects/clears every donor the search box currently matches — not the
  // full unfiltered table, which is what this compared against before and
  // meant "select all" while searching silently grabbed rows you couldn't
  // even see.
  const toggleSelectAll = () => {
    if (selected.size === visibleDonors.length) setSelected(new Set())
    else setSelected(new Set(visibleDonors.map((d) => d.id)))
  }

  const bulkVerify = async () => {
    const ids = Array.from(selected)
    for (const id of ids) {
      const { error } = await supabase.rpc('confirm_donation', { p_donor_id: id, p_edits: {} })
      if (error) { toast.error(`${error.message} (${t('dn.stoppedAt')} ${ids.indexOf(id) + 1}/${ids.length})`); break }
    }
    toast.success(`${ids.length} ${t('dn.donorsConfirmed')}`)
    setSelected(new Set())
    load()
  }

  const bulkDelete = async () => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('donors').delete().in('id', ids)
    if (error) { toast.error(t('dn.failedToDelete')); return }
    toast.success(`${ids.length} ${t('dn.donorsDeleted')}`)
    setSelected(new Set())
    setConfirmDelete(false)
    load()
  }

  const openEdit = async (d: Donor) => {
    setEditTarget(d)
    setEditForm({
      name: d.name, name_ur: d.name_ur ?? '', phone: d.phone ?? '', father_husband_name: d.father_husband_name ?? '',
      whatsapp_number: d.whatsapp_number ?? '', donor_type: d.donor_type ?? 'villager', donor_location: d.donor_location ?? '', amount_pkr: d.amount_pkr,
      date: d.date, is_anonymous: d.is_anonymous, payment_method: d.payment_method ?? 'cash', notes: d.notes ?? '',
      project_id: d.project_id ?? '',
    })
    setReceiptUrl(null)
    if (d.payment_proof_url) {
      const { data } = await supabase.storage.from('donation_receipts').createSignedUrl(d.payment_proof_url, 300)
      setReceiptUrl(data?.signedUrl ?? null)
    }
  }

  // The bucket is private (migration 116), so a screenshot is never a plain URL —
  // it needs a short-lived signed link minted per view. Five minutes is enough
  // to look at it and long enough to survive a slow connection.
  const openProof = async (d: Donor) => {
    if (!d.payment_proof_url) return
    setProofLoadingId(d.id)
    const { data, error } = await supabase.storage.from('donation_receipts').createSignedUrl(d.payment_proof_url, 300)
    setProofLoadingId(null)
    if (error || !data?.signedUrl) { toast.error(t('dn.couldNotOpenProof')); return }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  // ── Combined payments — one real slip, several pledges ──────────────────
  const openBatchReview = async (b: PendingBatch) => {
    setReviewBatch(b)
    setBatchItems(null)
    setBatchProofUrl(null)
    const [{ data: items }, signed] = await Promise.all([
      supabase.rpc('payment_batch_items', { p_batch_id: b.batch_id }),
      b.proof_url ? supabase.storage.from('donation_receipts').createSignedUrl(b.proof_url, 300) : Promise.resolve({ data: null }),
    ])
    setBatchItems((items ?? []) as BatchItem[])
    setBatchProofUrl(signed?.data?.signedUrl ?? null)
  }

  const confirmWholeBatch = async () => {
    if (!batchItems || batchItems.length === 0) return
    setConfirmingBatch(true)
    let failed = 0
    for (const item of batchItems) {
      const { error } = item.kind === 'donor'
        ? await supabase.rpc('confirm_donation', { p_donor_id: item.id, p_edits: {} })
        : await supabase.rpc('pool_confirm_payment', { p_payment_id: item.id })
      if (error) failed += 1
    }
    setConfirmingBatch(false)
    if (failed > 0) toast.error(`${failed} / ${batchItems.length} — ${t('dn.couldntBeConfirmed')}`)
    else toast.success(`${t('dn.allItemsConfirmed')} ${batchItems.length} ${t('dn.allItemsConfirmedSuffix')}`)
    setReviewBatch(null)
    load()
  }

  const saveEdits = async () => {
    if (!editTarget) return
    const { error } = await supabase.from('donors').update({
      name: editForm.name, name_ur: editForm.name_ur || null, phone: editForm.phone || null,
      father_husband_name: editForm.father_husband_name || null, whatsapp_number: editForm.whatsapp_number || null,
      donor_type: editForm.donor_type, donor_location: editForm.donor_location || null, amount_pkr: editForm.amount_pkr, date: editForm.date,
      payment_method: editForm.payment_method, project_id: editForm.project_id || null,
      is_anonymous: editForm.is_anonymous, notes: editForm.notes || null,
    }).eq('id', editTarget.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dn.saved'))
    setEditTarget(null)
    load()
  }

  const confirmDonation = async () => {
    if (!editTarget) return
    setConfirming(true)
    const { data, error } = await supabase.rpc('confirm_donation', {
      p_donor_id: editTarget.id,
      p_edits: {
        name: editForm.name, name_ur: editForm.name_ur || null, phone: editForm.phone || null,
        father_husband_name: editForm.father_husband_name || null, whatsapp_number: editForm.whatsapp_number || null,
        donor_type: editForm.donor_type, donor_location: editForm.donor_location || null, amount_pkr: editForm.amount_pkr, date: editForm.date,
        payment_method: editForm.payment_method, project_id: editForm.project_id || '',
        is_anonymous: editForm.is_anonymous, notes: editForm.notes || null,
      },
    })
    setConfirming(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('dn.donationConfirmed'))

    const { data: tpl } = await supabase.from('message_templates').select('body').eq('key', 'donor_donation_confirmed').single()
    const projTitle = editForm.project_id ? (projectTitle(editForm.project_id) ?? 'General Fund') : 'General Fund'
    const messageBody = tpl?.body
      ? renderTemplate(tpl.body, { name: data.name, amount: Number(data.amount_pkr).toLocaleString(), account_no: data.account_no, project: projTitle })
      : `Thank you ${data.name}! Your donation of ${Number(data.amount_pkr).toLocaleString()} (Account: ${data.account_no}) has been verified.`

    // Totals are read after confirm_donation() has committed, so this receipt's
    // own amount is already inside totalContributed — which is what the donor
    // should see: their lifetime total including the donation in their hand.
    const totals = await donorReceiptTotals(editTarget.id)
    setViewReceipt({
      kind: 'donation', receiptNo: data.voucher_no, date: editForm.date,
      systemLabel: 'Donors & Projects', accountName: editForm.is_anonymous ? 'Anonymous Donor' : data.name,
      accountNameUr: editForm.name_ur || undefined,
      particular: `Donation${projTitle !== 'General Fund' ? ` - ${projTitle}` : ''} (Account ${data.account_no})`,
      amount: data.amount_pkr,
      balanceAfter: totals.totalContributed, announcedRemaining: totals.announcedRemaining,
      projectName: projTitle,
      isConfirmed: true,
    })
    setConfirmedWhatsapp(editForm.whatsapp_number || editForm.phone || null)
    setThankYouMessage(messageBody)
    setEditTarget(null)
    load()
  }

  const sendThankYou = () => {
    const intl = confirmedWhatsapp ? normalizePakPhone(confirmedWhatsapp) : null
    if (!intl || !thankYouMessage) { toast.error(t('dn.noUsableWhatsapp')); return }
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(thankYouMessage)}`, '_blank')
  }

  // A donor who pledges 10,000 and sends 9,000 is neither an unrelated new
  // number nor a full 'received' — announced_amount_pkr is the pledge,
  // frozen at announce time; amount_pkr is what was actually confirmed.
  const donorStatus = (d: Donor): 'received' | 'partial' | 'announced' | 'awaiting' =>
    d.is_verified ? (d.amount_pkr < d.announced_amount_pkr ? 'partial' : 'received')
    : d.payment_status === 'pledged' ? 'announced' : 'awaiting'

  const pendingCount = useMemo(() => donors.filter((d) => !d.is_verified).length, [donors])
  const awaitingCount = useMemo(() => donors.filter((d) => donorStatus(d) === 'awaiting').length, [donors])

  // Search covers everything on screen — name, phone, account number, amount —
  // so the box at the top matches what someone is actually looking at.
  const visibleDonors = useMemo(() => {
    const q = donorSearch.trim().toLowerCase()
    const statusRank = { announced: 0, awaiting: 1, partial: 2, received: 3 }
    const filtered = q
      ? donors.filter((d) => [
          d.name, d.is_anonymous ? 'anonymous' : '', d.recurring_schedule_id ? 'recurring' : '', d.phone ?? '', d.name_ur ?? '',
          accountNoByKey.get(donorKeyFor(d.name, d.phone)) ?? '', String(d.amount_pkr),
        ].join(' ').toLowerCase().includes(q))
      : donors
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'name': return dir * a.name.localeCompare(b.name)
        case 'amount': return dir * (Number(a.amount_pkr) - Number(b.amount_pkr))
        case 'status': return dir * (statusRank[donorStatus(a)] - statusRank[donorStatus(b)])
        case 'account': return dir * (accountNoByKey.get(donorKeyFor(a.name, a.phone)) ?? '').localeCompare(accountNoByKey.get(donorKeyFor(b.name, b.phone)) ?? '')
        default: return dir * (new Date(a.date).getTime() - new Date(b.date).getTime())
      }
    })
  }, [donors, donorSearch, sortKey, sortDir, accountNoByKey])

  const totalPages = Math.max(1, Math.ceil(visibleDonors.length / PAGE_SIZE))
  // A stale page (e.g. page 5 of a 50-row search that just narrowed to 2
  // rows) would otherwise render nothing and look like the list broke.
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [totalPages, page])
  useEffect(() => { setPage(1) }, [donorSearch, sortKey, sortDir])
  const pagedDonors = useMemo(() => visibleDonors.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [visibleDonors, page])

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((v) => (v === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'date' || k === 'amount' ? 'desc' : 'asc') }
  }
  const sortArrow = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('dn.noAccessMessage')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('dn.title')}</h1>
          {pendingCount > 0 && (
            <p className="font-sans text-[13px] text-amber-700 mt-1">
              {pendingCount} {t('dn.unconfirmedCount')}
              {awaitingCount > 0 && ` — ${awaitingCount} ${t('dn.awaitingYourConfirm')}`}
            </p>
          )}
        </div>
        <button onClick={() => { setForm(empty); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('dn.addDonor')}</button>
      </div>

      {/* ── Combined payments ─────────────────────────────────────────────
          One real bank transfer covering several pledges at once — a batch
          of exactly one is just an ordinary payment and never shows up
          here (pending_payment_batches() already filters those out). This
          is specifically the "how do I know these 3 rows are really the
          same Rs 8,700 slip" answer: one screen, the real proof, every
          item it covers, one Confirm All. */}
      {pendingBatches.length > 0 && (
        <div className="bg-white rounded-lg border border-sky-200 overflow-hidden mb-4">
          <div className="px-5 py-3 border-b border-sky-200 bg-sky-50">
            <span className="font-sans text-[14px] font-bold text-sky-800">{t('dn.combinedPaymentsToReview')} {pendingBatches.length} {t('dn.combinedPaymentsToReviewSuffix')}</span>
            <p className="font-sans text-[12px] text-sky-800 mt-0.5">{t('dn.combinedPaymentsBlurb')}</p>
          </div>
          {pendingBatches.map((b) => (
            <button key={b.batch_id} onClick={() => openBatchReview(b)}
              className="w-full flex items-center justify-between gap-3 px-5 py-3.5 border-b border-dp-outline-variant last:border-b-0 text-start cursor-pointer hover:bg-dp-surface-container-low/60 transition-all">
              <div className="min-w-0">
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{b.donor_name ?? '—'}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{b.count} items · {new Date(b.earliest).toLocaleDateString('en-GB')} · {b.method}</p>
              </div>
              <p className="font-heading text-[18px] font-bold text-dp-secondary shrink-0">{b.total.toLocaleString()}</p>
            </button>
          ))}
        </div>
      )}

      <div className="relative mb-4">
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input
          value={donorSearch}
          onChange={(e) => setDonorSearch(e.target.value)}
          placeholder={t('dn.searchPlaceholder')}
          className="input-field !ps-9"
        />
      </div>

      <BulkActionsBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={[
          { label: t('dn.confirmSelected'), onClick: bulkVerify, variant: 'primary' },
          { label: t('dn.deleteSelected'), onClick: () => setConfirmDelete(true), variant: 'danger' },
        ]}
      />

      {/* Mobile card list — the 9-column table below is desktop-only; a table
          that wide either crushes every column or forces sideways scrolling
          on a phone, neither of which lets an accountant scan rows at a
          glance. Same fields, laid out the way the billing consumer list
          already does it. */}
      <div className="md:hidden bg-white rounded-lg border border-dp-outline-variant overflow-hidden divide-y divide-dp-outline-variant">
        {loading && <div className="p-8 text-center text-dp-on-surface-variant font-sans text-[14px]">{t('action.loading')}</div>}
        {!loading && visibleDonors.length === 0 && (
          <div className="p-8 text-center text-dp-on-surface-variant font-sans text-[14px]">{donorSearch ? t('dn.noSearchMatch') : t('dn.noDonationsYet')}</div>
        )}
        {!loading && pagedDonors.map((d) => (
          <div key={d.id} className={`p-4 ${selected.has(d.id) ? 'bg-dp-secondary-container/20' : !d.is_verified ? 'bg-amber-50/40' : ''}`}>
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} className="accent-dp-secondary cursor-pointer mt-1 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-sans text-[15px] font-semibold text-dp-on-surface truncate">
                    {d.name}
                    {d.is_anonymous && (
                      <span className="ms-1.5 align-middle text-[9.5px] font-bold uppercase px-1.5 py-0.5 rounded-full font-sans bg-dp-surface-container-high text-dp-on-surface-variant">
                        {t('dn.anonymous')}
                      </span>
                    )}
                  </p>
                  <p className="font-sans text-[15px] font-bold text-dp-secondary shrink-0 whitespace-nowrap">{Number(d.amount_pkr).toLocaleString()}</p>
                </div>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 truncate">
                  {/* font-mono on a bare <p> forces display:inline-block under
                      Urdu (globals.css, so LTR numbers embed correctly inside
                      RTL text) — which can pull this row onto the same line
                      as an inline sibling above it. Scoped to a nested span
                      instead, so the <p> itself stays a normal block. The
                      phone number gets its own dir="ltr" span rather than
                      sharing font-mono's embed with the account number — a
                      "+92..." number's leading + is direction-weak enough
                      that Urdu's RTL context could still pull it to the end
                      ("923..." + trailing +) without an explicit direction. */}
                  <span className="font-mono">{accountNoByKey.get(donorKeyFor(d.name, d.phone)) ?? '—'}</span>
                  {d.phone && <> · <span dir="ltr" className="font-mono tabular-nums">{d.phone}</span></>}
                </p>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">
                  {new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>

                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  {fundBadge(d) && (
                    <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full font-sans ${fundBadge(d)!.className}`}>{fundBadge(d)!.label}</span>
                  )}
                  <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full font-sans ${d.submitted_via === 'public' ? 'bg-blue-100 text-blue-700' : 'bg-dp-surface-container-high'}`}>{d.submitted_via === 'public' ? t('dn.public') : t('dn.staff')}</span>
                  {d.donor_type === 'overseas' && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full font-sans bg-violet-100 text-violet-700">{t('g.overseas')}</span>}
                  {d.recurring_schedule_id && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full font-sans bg-indigo-100 text-indigo-700">{t('a.recurring')}</span>}
                  {donorStatus(d) === 'received' && <span className="inline-flex items-center gap-1 text-dp-secondary text-[10.5px] font-bold"><CheckCircle size={11} /> {t('dn.received')}</span>}
                  {donorStatus(d) === 'partial' && <span className="inline-flex items-center gap-1 text-orange-700 text-[10.5px] font-bold"><AlertTriangle size={11} /> {t('dn.partial')}</span>}
                  {donorStatus(d) === 'announced' && <span className="inline-flex items-center gap-1 text-amber-700 text-[10.5px] font-bold"><XCircle size={11} /> {t('dn.announced')}</span>}
                  {donorStatus(d) === 'awaiting' && <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[10.5px] font-bold"><Clock size={11} /> {t('dn.awaiting')}</span>}
                </div>

                <div className="flex items-center gap-2 mt-3">
                  {d.payment_proof_url && (
                    <button
                      onClick={() => openProof(d)}
                      disabled={proofLoadingId === d.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container disabled:opacity-50"
                    >
                      <Paperclip size={12} /> {proofLoadingId === d.id ? '...' : t('dn.proof')}
                    </button>
                  )}
                  <button onClick={() => openEdit(d)} className="px-2.5 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">
                    {d.is_verified ? t('action.edit') : t('dn.review')}
                  </button>
                  {d.is_verified && (
                    <button onClick={() => unverify(d.id)} className="px-2.5 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">{t('dn.unverify')}</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]"><th className="p-4 w-10"><input type="checkbox" checked={visibleDonors.length > 0 && selected.size === visibleDonors.length} onChange={toggleSelectAll} className="accent-dp-secondary cursor-pointer" /></th><th className="p-4 cursor-pointer select-none hover:text-dp-primary" onClick={() => toggleSort('name')}>{t('a.name')}{sortArrow('name')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary whitespace-nowrap" onClick={() => toggleSort('account')}>{t('dn.accountNo', 'Account #')}{sortArrow('account')}</th><th className="p-4 whitespace-nowrap">{t('a.phone')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary whitespace-nowrap" onClick={() => toggleSort('amount')}>{t('w.amount')}{sortArrow('amount')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary whitespace-nowrap" onClick={() => toggleSort('date')}>{t('w.date')}{sortArrow('date')}</th><th className="p-4 whitespace-nowrap">{t('dn.source')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary whitespace-nowrap" onClick={() => toggleSort('status')}>{t('w.status')}{sortArrow('status')}</th><th className="p-4 text-end">{t('a.actions')}</th></tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={9} className="p-8 text-center text-dp-on-surface-variant">{t('action.loading')}</td></tr>}
              {!loading && visibleDonors.length === 0 && (
                <tr><td colSpan={9} className="p-8 text-center text-dp-on-surface-variant">{donorSearch ? t('dn.noSearchMatch') : t('dn.noDonationsYet')}</td></tr>
              )}
              {!loading && pagedDonors.map((d, i) => (
                <tr key={d.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${selected.has(d.id) ? 'bg-dp-secondary-container/20' : ''} ${!d.is_verified ? 'bg-amber-50/40' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant"><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} className="accent-dp-secondary cursor-pointer" /></td>
                  <td className="p-4 border-b border-dp-outline-variant font-semibold">
                    {d.name}
                    {d.is_anonymous && (
                      <span
                        title={t('dn.anonymousTooltip')}
                        className="ms-2 align-middle text-[10.5px] font-bold uppercase px-2 py-0.5 rounded-full font-sans bg-dp-surface-container-high text-dp-on-surface-variant"
                      >
                        {t('dn.anonymous')}
                      </span>
                    )}
                  </td>
                  {/* font-mono directly on a <td> forces display:inline-block under
                      Urdu (globals.css, so LTR numbers embed correctly inside RTL
                      text), which breaks the table's native column alignment.
                      Scoped to a nested span instead — same fix already applied
                      to the mobile card view above. */}
                  <td className="p-4 border-b border-dp-outline-variant text-[13px] text-dp-on-surface-variant whitespace-nowrap"><span className="font-mono">{accountNoByKey.get(donorKeyFor(d.name, d.phone)) ?? '—'}</span></td>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant whitespace-nowrap">{d.phone ? <span dir="ltr" className="font-mono tabular-nums">{d.phone}</span> : '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant font-bold text-dp-secondary whitespace-nowrap">{Number(d.amount_pkr).toLocaleString()}</td>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant whitespace-nowrap">{new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className="inline-flex flex-wrap gap-1">
                      {fundBadge(d) && (
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${fundBadge(d)!.className}`}>{fundBadge(d)!.label}</span>
                      )}
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${d.submitted_via === 'public' ? 'bg-blue-100 text-blue-700' : 'bg-dp-surface-container-high'}`}>{d.submitted_via === 'public' ? t('dn.public') : t('dn.staff')}</span>
                      {d.donor_type === 'overseas' && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-violet-100 text-violet-700">{t('g.overseas')}</span>}
                      {d.recurring_schedule_id && (
                        <span title={t('dn.recurringTooltip')} className="text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-indigo-100 text-indigo-700">{t('a.recurring')}</span>
                      )}
                      {d.payment_batch_id && batchSummary[d.payment_batch_id]?.count > 1 && (
                        <span title={t('dn.batchTooltip')}
                          className="text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-amber-100 text-amber-800">
                          {t('dn.partOfBatch')} {batchSummary[d.payment_batch_id].total.toLocaleString()} · {batchSummary[d.payment_batch_id].count} {t('dn.batchItems')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant whitespace-nowrap">
                    {donorStatus(d) === 'received' && <span className="inline-flex items-center gap-1 text-dp-secondary text-[12px] font-bold"><CheckCircle size={14} /> {t('dn.received')}</span>}
                    {donorStatus(d) === 'partial' && <span className="inline-flex items-center gap-1 text-orange-700 text-[12px] font-bold" title={t('dn.partialTooltip').replace('{amt}', `${(d.announced_amount_pkr - d.amount_pkr).toLocaleString()}`)}><AlertTriangle size={14} /> {t('dn.partial')}</span>}
                    {donorStatus(d) === 'announced' && <span className="inline-flex items-center gap-1 text-amber-700 text-[12px] font-bold" title={t('dn.announcedTooltip')}><XCircle size={14} /> {t('dn.announced')}</span>}
                    {donorStatus(d) === 'awaiting' && <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[12px] font-bold" title={t('dn.awaitingTooltip')}><Clock size={14} /> {t('dn.awaiting')}</span>}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant text-end whitespace-nowrap">
                    {d.payment_proof_url && (
                      <button
                        onClick={() => openProof(d)}
                        disabled={proofLoadingId === d.id}
                        title={t('dn.viewProofTooltip')}
                        className="inline-flex items-center gap-1 px-2 py-1 me-2 rounded text-[13px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container disabled:opacity-50"
                      >
                        <Paperclip size={13} /> {proofLoadingId === d.id ? '...' : t('dn.proof')}
                      </button>
                    )}
                    <button onClick={() => openEdit(d)} className="px-3 py-1 rounded text-[14px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container me-2">
                      {d.is_verified ? t('action.edit') : t('dn.review')}
                    </button>
                    {d.is_verified && (
                      <button onClick={() => unverify(d.id)} className="px-3 py-1 rounded text-[14px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">{t('dn.unverify')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && visibleDonors.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 px-1">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant order-2 sm:order-1">
            {t('dn.showingRange').replace('{from}', String((page - 1) * PAGE_SIZE + 1)).replace('{to}', String(Math.min(page * PAGE_SIZE, visibleDonors.length))).replace('{total}', visibleDonors.length.toLocaleString())}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2 order-1 sm:order-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container disabled:opacity-40 disabled:cursor-not-allowed">
                {t('dn.prevPage')}
              </button>
              <span className="font-sans text-[13px] text-dp-on-surface-variant px-1">{page} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container disabled:opacity-40 disabled:cursor-not-allowed">
                {t('dn.nextPage')}
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={t('dn.deleteDonorsTitle')}
        message={t('dn.deleteDonorsMessage').replace('{n}', String(selected.size))}
        onConfirm={bulkDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{t('dn.addDonor')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.name')}</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('g.nameUrdu')}</label><input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder="اردو میں نام" className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.phone')}</label><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0300-1234567" className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('f.donorType')}</label><select value={form.donor_type} onChange={(e) => setForm({ ...form, donor_type: e.target.value, donor_location: e.target.value === 'villager' ? '' : form.donor_location })} className="input-field"><option value="villager">{t('f.villager')}</option><option value="city">{t('dn.cityInPakistan')}</option><option value="overseas">{t('g.overseas')}</option></select></div>
                {/* Where they are, in their own words. It is what the public
                    thank-you says — "from Lahore", "from Dubai" — and most of
                    the people who give left the village years ago, so calling
                    them either local or foreign was wrong either way. */}
                {form.donor_type !== 'villager' && (
                  <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{form.donor_type === 'overseas' ? t('dn.country') : t('dn.city')}</label><input type="text" value={form.donor_location} onChange={(e) => setForm({ ...form, donor_location: e.target.value })} placeholder={form.donor_type === 'overseas' ? t('dn.countryPlaceholder') : t('dn.cityPlaceholder')} className="input-field" /></div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.amountPkr')}</label><input type="number" value={form.amount_pkr || ''} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.date')}</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.paymentMethod')}</label><select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className="input-field"><option value="cash">{t('w.cash')}</option><option value="jazzcash">{t('w.jazzcash')}</option><option value="easypaisa">{t('w.easypaisa')}</option><option value="bank">{t('a.bank')}</option></select></div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dn.selectProject')}</label>
                <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className="input-field">
                  <option value="">{t('a.noProject')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.notesOptional')}</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} placeholder={t('dn.notesPlaceholder')} className="input-field resize-none" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_anonymous} onChange={(e) => setForm({ ...form, is_anonymous: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('f.anonymousDonor')}</span></label>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{t('dn.addDonor')}</button>
            </div>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEditTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[24px] font-bold text-dp-primary">{editTarget.is_verified ? t('dn.editDonorTitle') : t('dn.reviewConfirmTitle')}</h2>
              <button onClick={() => setEditTarget(null)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              {receiptUrl && (
                <div>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2 flex items-center gap-1.5"><ImageIcon size={14} /> {t('dn.paymentReceipt')}</label>
                  <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
                    {/* object-contain against an unknown receipt aspect ratio (could
                        be portrait or landscape) — no fixed dimensions to give
                        next/image, kept as a plain <img> deliberately. */}
                    <img src={receiptUrl} alt="Payment receipt" className="w-full max-h-56 object-contain rounded-lg border border-dp-outline-variant bg-dp-surface-container" />
                  </a>
                </div>
              )}
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.name')}</label><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="input-field" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.fatherHusband')}</label><input value={editForm.father_husband_name} onChange={(e) => setEditForm({ ...editForm, father_husband_name: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('f.donorType')}</label><select value={editForm.donor_type} onChange={(e) => setEditForm({ ...editForm, donor_type: e.target.value, donor_location: e.target.value === 'villager' ? '' : editForm.donor_location })} className="input-field"><option value="villager">{t('f.villager')}</option><option value="city">{t('dn.cityInPakistan')}</option><option value="overseas">{t('g.overseas')}</option></select></div>
                {/* Where they are, in their own words. It is what the public
                    thank-you says — "from Lahore", "from Dubai" — and most of
                    the people who give left the village years ago, so calling
                    them either local or foreign was wrong either way. */}
                {editForm.donor_type !== 'villager' && (
                  <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{editForm.donor_type === 'overseas' ? t('dn.country') : t('dn.city')}</label><input type="text" value={editForm.donor_location} onChange={(e) => setEditForm({ ...editForm, donor_location: e.target.value })} placeholder={editForm.donor_type === 'overseas' ? t('dn.countryPlaceholder') : t('dn.cityPlaceholder')} className="input-field" /></div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.phone')}</label><input type="tel" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.whatsapp')}</label><input type="tel" value={editForm.whatsapp_number} onChange={(e) => setEditForm({ ...editForm, whatsapp_number: e.target.value })} className="input-field" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.amountPkr')}</label><input type="number" value={editForm.amount_pkr || ''} onChange={(e) => setEditForm({ ...editForm, amount_pkr: +e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.date')}</label><input type="date" value={editForm.date} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.paymentMethod')}</label><select value={editForm.payment_method} onChange={(e) => setEditForm({ ...editForm, payment_method: e.target.value })} className="input-field"><option value="cash">{t('w.cash')}</option><option value="jazzcash">{t('w.jazzcash')}</option><option value="easypaisa">{t('w.easypaisa')}</option><option value="bank">{t('a.bank')}</option></select></div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.project')}</label>
                <select value={editForm.project_id} onChange={(e) => setEditForm({ ...editForm, project_id: e.target.value })} className="input-field">
                  <option value="">{t('a.noProject')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('dn.notes')}</label>
                <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={2} className="input-field resize-none" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={editForm.is_anonymous} onChange={(e) => setEditForm({ ...editForm, is_anonymous: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('f.anonymousDonor')}</span></label>

              {editTarget.is_verified ? (
                <button onClick={saveEdits} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{t('g.saveChanges')}</button>
              ) : (
                <button onClick={confirmDonation} disabled={confirming} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                  <ShieldCheck size={16} /> {confirming ? t('dn.confirming') : t('dn.confirmDonationBtn')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {viewReceipt && (
        <ReceiptModal data={viewReceipt} system="donors_projects" onClose={() => { setViewReceipt(null); setConfirmedWhatsapp(null); setThankYouMessage(null) }} />
      )}
      {viewReceipt && confirmedWhatsapp && (
        <div className="fixed bottom-6 end-6 z-[130]">
          <button onClick={sendThankYou} className="px-4 py-3 bg-emerald-600 text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-emerald-700 transition-all shadow-lg">
            {t('dn.sendThanks')}
          </button>
        </div>
      )}

      {/* ── Review one combined payment ────────────────────────────────── */}
      {reviewBatch && (
        <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center p-4" onClick={() => setReviewBatch(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-heading text-[19px] font-bold text-dp-primary">{reviewBatch.donor_name ?? '—'}</h2>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                  {new Date(reviewBatch.earliest).toLocaleDateString('en-GB')} · {reviewBatch.method}
                </p>
              </div>
              <button onClick={() => setReviewBatch(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
              <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{t('dn.onePaymentTotal')}</p>
              <p className="font-heading text-[22px] font-bold text-dp-secondary">{reviewBatch.total.toLocaleString()}</p>
            </div>

            {reviewBatch.proof_url && (
              batchProofUrl ? (
                <a href={batchProofUrl} target="_blank" rel="noreferrer" className="block mb-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={batchProofUrl} alt="Payment slip" className="w-full max-h-64 object-contain rounded-lg border border-dp-outline-variant bg-dp-surface-container" />
                </a>
              ) : (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('dn.loadingSlip')}</p>
              )
            )}

            <p className="font-sans text-[12px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2">{t('dn.onePaymentCovers')}</p>
            {!batchItems ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant py-4 text-center">{t('dn.loadingEllipsis')}</p>
            ) : (
              <div className="border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant overflow-hidden mb-5">
                {batchItems.map((item) => (
                  <div key={`${item.kind}-${item.id}`} className="flex items-center justify-between px-3.5 py-2.5">
                    <p className="font-sans text-[13px] text-dp-on-surface">{item.label}</p>
                    <p className="font-sans text-[13px] font-bold text-dp-on-surface shrink-0 ms-3">{item.amount.toLocaleString()}</p>
                  </div>
                ))}
              </div>
            )}

            <button disabled={confirmingBatch || !batchItems} onClick={confirmWholeBatch}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              <CheckCircle size={16} /> {confirmingBatch ? t('dn.confirmingEllipsis') : `${t('dn.confirmAll')} ${batchItems?.length ?? ''} ${t('dn.confirmAllItems')}`}
            </button>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-2.5 text-center">
              {t('dn.eachItemPostsNote')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
