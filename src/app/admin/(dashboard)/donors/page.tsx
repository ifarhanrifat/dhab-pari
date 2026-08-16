'use client'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, CheckCircle, XCircle, ShieldCheck, Image as ImageIcon, Search, Clock, Paperclip } from 'lucide-react'
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
interface Project { id: string; title: string }
type SortKey = 'name' | 'account' | 'amount' | 'date' | 'status'

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
  const { t } = useLocale()
  const access = useSystemAccess()
  const searchParams = useSearchParams()
  const [donorSearch, setDonorSearch] = useState('')
  const [proofLoadingId, setProofLoadingId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
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
  const supabase = createClient()

  const load = async () => {
    const [donorsRes, projectsRes, accountsRes] = await Promise.all([
      supabase.from('donors').select('*').order('date', { ascending: false }),
      supabase.from('projects').select('id, title').order('title'),
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

  const projectTitle = (id: string | null) => projects.find((p) => p.id === id)?.title ?? null

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name required'); return }
    const payload = { ...form, name_ur: form.name_ur || null, project_id: form.project_id || null, notes: form.notes || null, phone: form.phone || null, father_husband_name: form.father_husband_name || null, whatsapp_number: form.whatsapp_number || null }
    const { data, error } = await supabase.from('donors').insert({ ...payload, is_verified: true, submitted_via: 'staff' }).select('id').single()
    if (error) { toast.error(friendlyError(error)); return }
    // Staff-entered donations post to the ledger immediately (is_verified is
    // already true above) but, unlike confirm_donation()'s flow, never got a
    // voucher_no/donor_account_no on their own — assign them now the same way.
    if (data) await supabase.rpc('assign_donor_numbers', { p_donor_id: data.id })
    toast.success('Donor added'); setShowForm(false); setForm(empty); load()
  }

  const unverify = async (id: string) => {
    await supabase.from('donors').update({ is_verified: false }).eq('id', id)
    toast.success('Unverified'); load()
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === donors.length) setSelected(new Set())
    else setSelected(new Set(donors.map((d) => d.id)))
  }

  const bulkVerify = async () => {
    const ids = Array.from(selected)
    for (const id of ids) {
      const { error } = await supabase.rpc('confirm_donation', { p_donor_id: id, p_edits: {} })
      if (error) { toast.error(`${error.message} (stopped at ${ids.indexOf(id) + 1}/${ids.length})`); break }
    }
    toast.success(`${ids.length} donor(s) confirmed`)
    setSelected(new Set())
    load()
  }

  const bulkDelete = async () => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('donors').delete().in('id', ids)
    if (error) { toast.error('Failed to delete donors'); return }
    toast.success(`${ids.length} donor(s) deleted`)
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
    if (error || !data?.signedUrl) { toast.error('Could not open the payment screenshot'); return }
    window.open(data.signedUrl, '_blank', 'noopener')
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
    toast.success('Saved')
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
    toast.success('Donation confirmed')

    const { data: tpl } = await supabase.from('message_templates').select('body').eq('key', 'donor_donation_confirmed').single()
    const projTitle = editForm.project_id ? (projectTitle(editForm.project_id) ?? 'General Fund') : 'General Fund'
    const messageBody = tpl?.body
      ? renderTemplate(tpl.body, { name: data.name, amount: Number(data.amount_pkr).toLocaleString(), account_no: data.account_no, project: projTitle })
      : `Thank you ${data.name}! Your donation of Rs. ${Number(data.amount_pkr).toLocaleString()} (Account: ${data.account_no}) has been verified.`

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
    if (!intl || !thankYouMessage) { toast.error('No usable WhatsApp number for this donor'); return }
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(thankYouMessage)}`, '_blank')
  }

  const donorStatus = (d: Donor): 'received' | 'announced' | 'awaiting' =>
    d.is_verified ? 'received' : d.payment_status === 'pledged' ? 'announced' : 'awaiting'

  const pendingCount = useMemo(() => donors.filter((d) => !d.is_verified).length, [donors])
  const awaitingCount = useMemo(() => donors.filter((d) => donorStatus(d) === 'awaiting').length, [donors])

  // Search covers everything on screen — name, phone, account number, amount —
  // so the box at the top matches what someone is actually looking at.
  const visibleDonors = useMemo(() => {
    const q = donorSearch.trim().toLowerCase()
    const statusRank = { announced: 0, awaiting: 1, received: 2 }
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

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((v) => (v === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'date' || k === 'amount' ? 'desc' : 'asc') }
  }
  const sortArrow = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Donors belongs to the Donors &amp; Projects system — your account doesn&apos;t have access to it.</p>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('dn.title')}</h1>
          {pendingCount > 0 && (
            <p className="font-sans text-[13px] text-amber-700 mt-1">
              {pendingCount} unconfirmed
              {awaitingCount > 0 && ` — ${awaitingCount} already paid and waiting on you to confirm`}
            </p>
          )}
        </div>
        <button onClick={() => { setForm(empty); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('dn.addDonor')}</button>
      </div>
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input
          value={donorSearch}
          onChange={(e) => setDonorSearch(e.target.value)}
          placeholder="Search donors by name, phone, account number or amount..."
          className="input-field !ps-9"
        />
      </div>

      <BulkActionsBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={[
          { label: 'Confirm Selected', onClick: bulkVerify, variant: 'primary' },
          { label: 'Delete Selected', onClick: () => setConfirmDelete(true), variant: 'danger' },
        ]}
      />

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]"><th className="p-4 w-10"><input type="checkbox" checked={donors.length > 0 && selected.size === donors.length} onChange={toggleSelectAll} className="accent-dp-secondary cursor-pointer" /></th><th className="p-4 cursor-pointer select-none hover:text-dp-primary" onClick={() => toggleSort('name')}>Name{sortArrow('name')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary" onClick={() => toggleSort('account')}>Account #{sortArrow('account')}</th><th className="p-4">{t('a.phone')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary" onClick={() => toggleSort('amount')}>Amount{sortArrow('amount')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary" onClick={() => toggleSort('date')}>Date{sortArrow('date')}</th><th className="p-4">{t('dn.source')}</th><th className="p-4 cursor-pointer select-none hover:text-dp-primary" onClick={() => toggleSort('status')}>Status{sortArrow('status')}</th><th className="p-4 text-end">{t('a.actions')}</th></tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={9} className="p-8 text-center text-dp-on-surface-variant">{t('action.loading')}</td></tr>}
              {!loading && visibleDonors.length === 0 && (
                <tr><td colSpan={9} className="p-8 text-center text-dp-on-surface-variant">{donorSearch ? 'No donors match that search.' : 'No donations yet.'}</td></tr>
              )}
              {!loading && visibleDonors.map((d, i) => (
                <tr key={d.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${selected.has(d.id) ? 'bg-dp-secondary-container/20' : ''} ${!d.is_verified ? 'bg-amber-50/40' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant"><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} className="accent-dp-secondary cursor-pointer" /></td>
                  <td className="p-4 border-b border-dp-outline-variant font-semibold">
                    {d.name}
                    {d.is_anonymous && (
                      <span
                        title="Shown as “Anonymous” on the public website — the committee still sees the real name for verification"
                        className="ms-2 align-middle text-[10.5px] font-bold uppercase px-2 py-0.5 rounded-full font-sans bg-dp-surface-container-high text-dp-on-surface-variant"
                      >
                        {t('dn.anonymous')}
                      </span>
                    )}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant text-[13px] font-mono text-dp-on-surface-variant">{accountNoByKey.get(donorKeyFor(d.name, d.phone)) ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant">{d.phone ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant font-bold text-dp-secondary">Rs. {Number(d.amount_pkr).toLocaleString()}</td>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant">{new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className="inline-flex flex-wrap gap-1">
                      {fundBadge(d) && (
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${fundBadge(d)!.className}`}>{fundBadge(d)!.label}</span>
                      )}
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full font-sans ${d.submitted_via === 'public' ? 'bg-blue-100 text-blue-700' : 'bg-dp-surface-container-high'}`}>{d.submitted_via === 'public' ? 'Public' : 'Staff'}</span>
                      {d.donor_type === 'overseas' && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-violet-100 text-violet-700">{t('g.overseas')}</span>}
                      {d.recurring_schedule_id && (
                        <span title="Generated by a recurring schedule, not entered by hand" className="text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-indigo-100 text-indigo-700">{t('a.recurring')}</span>
                      )}
                      {d.payment_batch_id && batchSummary[d.payment_batch_id]?.count > 1 && (
                        <span title="Sent as one payment along with other pledges — some may be on the Kafalat/Wazifa/Sadqa Collections tabs instead of here"
                          className="text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-amber-100 text-amber-800">
                          Part of Rs {batchSummary[d.payment_batch_id].total.toLocaleString()} · {batchSummary[d.payment_batch_id].count} items
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    {donorStatus(d) === 'received' && <span className="inline-flex items-center gap-1 text-dp-secondary text-[12px] font-bold"><CheckCircle size={14} /> {t('dn.received')}</span>}
                    {donorStatus(d) === 'announced' && <span className="inline-flex items-center gap-1 text-amber-700 text-[12px] font-bold" title="Donor has promised this — no money sent yet"><XCircle size={14} /> {t('dn.announced')}</span>}
                    {donorStatus(d) === 'awaiting' && <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[12px] font-bold" title="Donor has paid — waiting on the committee to confirm"><Clock size={14} /> {t('dn.awaiting')}</span>}
                  </td>
                  <td className="p-4 border-b border-dp-outline-variant text-end whitespace-nowrap">
                    {d.payment_proof_url && (
                      <button
                        onClick={() => openProof(d)}
                        disabled={proofLoadingId === d.id}
                        title="View the payment screenshot the donor sent"
                        className="inline-flex items-center gap-1 px-2 py-1 me-2 rounded text-[13px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container disabled:opacity-50"
                      >
                        <Paperclip size={13} /> {proofLoadingId === d.id ? '...' : 'Proof'}
                      </button>
                    )}
                    <button onClick={() => openEdit(d)} className="px-3 py-1 rounded text-[14px] font-sans font-semibold cursor-pointer transition-all border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container me-2">
                      {d.is_verified ? 'Edit' : 'Review'}
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

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Donors"
        message={`Are you sure you want to delete ${selected.size} donor(s)? This cannot be undone.`}
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
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Any additional notes..." className="input-field resize-none" />
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
              <h2 className="font-heading text-[24px] font-bold text-dp-primary">{editTarget.is_verified ? 'Edit Donor' : 'Review & Confirm'}</h2>
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
                  <ShieldCheck size={16} /> {confirming ? 'Confirming...' : 'Confirm Donation'}
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
        <div className="fixed bottom-6 right-6 z-[130]">
          <button onClick={sendThankYou} className="px-4 py-3 bg-emerald-600 text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-emerald-700 transition-all shadow-lg">
            {t('dn.sendThanks')}
          </button>
        </div>
      )}
    </>
  )
}
