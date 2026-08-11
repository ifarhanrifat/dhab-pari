'use client'

import { useEffect, useState, useCallback, use as usePromise } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, PlusCircle, X, Save, Pause, Play, Trash2, Repeat, Share2, History } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import { donorReceiptTotals } from '@/lib/donorReceiptTotals'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type SystemTab = 'water_supply' | 'donors_projects'
type ScheduleType = 'bill' | 'donation' | 'expense'
type Frequency = 'every_minute' | 'daily' | 'weekly' | 'monthly' | 'semi_annual' | 'yearly'

const systemLabels: Record<SystemTab, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects' }
const frequencyLabels: Record<Frequency, string> = { every_minute: 'Every Minute (Testing)', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', semi_annual: '6 Months', yearly: 'Yearly' }
const scheduleTypeLabels: Record<ScheduleType, string> = { bill: 'Water Bill', donation: 'Donation', expense: 'Expense' }

interface Schedule {
  id: string; schedule_type: ScheduleType; frequency: Frequency; next_run_date: string
  is_active: boolean; amount_pkr: number; consumer_id: string | null; donor_name: string | null
  party_name: string | null; last_run_at: string | null
  from_account_id: string | null; to_account_id: string | null
}
interface Consumer { consumer_id: string; name: string; monthly_rate: number }
interface Account { id: string; name: string; type: string }
interface Project { id: string; title: string }
interface ReadyItem { key: string; type: string; id: string; label: string; amount: number; date: string }
interface HistoryItem { id: string; label: string; amount: number; date: string; status: string }

const today = () => new Date().toISOString().slice(0, 10)
const emptyForm = {
  schedule_type: 'bill' as ScheduleType, frequency: 'monthly' as Frequency, start_date: today(),
  amount_pkr: 0, consumer_id: '', due_date_offset_days: 7,
  donor_name: '', donor_name_ur: '', donor_phone: '', donor_type: 'villager', payment_method: 'cash', project_id: '',
  from_account_id: '', to_account_id: '', party_name: '', particular: '',
}

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function RecurringSchedulesPage({ params }: { params: Promise<{ system: string }> }) {
  const { t } = useLocale()
  const { system: rawSystem } = usePromise(params)
  const system = (rawSystem === 'donors_projects' ? 'donors_projects' : 'water_supply') as SystemTab

  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [consumers, setConsumers] = useState<Consumer[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [readyItems, setReadyItems] = useState<ReadyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [saving, setSaving] = useState(false)
  const [historySchedule, setHistorySchedule] = useState<Schedule | null>(null)
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set())
  const [confirmDeleteHistory, setConfirmDeleteHistory] = useState(false)
  const supabase = createClient()

  const load = useCallback(async () => {
    // Fallback safety net in case pg_cron isn't available on this project — harmless
    // to call repeatedly, it only acts on schedules that are actually due.
    await supabase.rpc('run_due_recurring_schedules')

    const [schedulesRes, consumersRes, accountsRes, projectsRes] = await Promise.all([
      supabase.from('recurring_schedules').select('*').eq('system', system).order('next_run_date'),
      system === 'water_supply' ? supabase.from('consumers').select('consumer_id, name, monthly_rate').eq('status', 'active').order('name') : Promise.resolve({ data: [] }),
      supabase.from('accounts').select('id, name, type').eq('system', system).eq('is_active', true).order('name'),
      system === 'donors_projects' ? supabase.from('projects').select('id, title') : Promise.resolve({ data: [] }),
    ])
    const scheds: Schedule[] = schedulesRes.data ?? []
    setSchedules(scheds)
    setConsumers(consumersRes.data ?? [])
    setAccounts(accountsRes.data ?? [])
    setProjects(projectsRes.data ?? [])

    // Ready-to-send queue is derived per-record (not from a single last-generated
    // pointer on the schedule) so every unsent item shows up, even if a schedule
    // caught up more than one overdue period in a single run.
    const scheduleIds = scheds.map((s) => s.id)
    const items: ReadyItem[] = []
    if (scheduleIds.length > 0) {
      if (system === 'water_supply') {
        const { data: readyBills } = await supabase.from('bills')
          .select('id, amount_pkr, month, year, created_at')
          .in('recurring_schedule_id', scheduleIds).is('whatsapp_sent_at', null)
        for (const b of readyBills ?? []) items.push({ key: `bill-${b.id}`, type: 'bill', id: b.id, label: `Water Bill - ${b.month}/${b.year}`, amount: b.amount_pkr, date: b.created_at })
      } else {
        const { data: readyDonations } = await supabase.from('donors')
          .select('id, amount_pkr, name, date')
          .in('recurring_schedule_id', scheduleIds).is('whatsapp_sent_at', null)
        for (const d of readyDonations ?? []) items.push({ key: `donation-${d.id}`, type: 'donation', id: d.id, label: `Donation - ${d.name}`, amount: d.amount_pkr, date: d.date })
      }
      const recentCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
      const { data: readyExpenses } = await supabase.from('vouchers')
        .select('id, amount_pkr, particular, status, created_at')
        .in('recurring_schedule_id', scheduleIds).gte('created_at', recentCutoff)
      for (const v of readyExpenses ?? []) items.push({ key: `expense-${v.id}`, type: 'expense', id: v.id, label: `${v.particular}${v.status === 'pending' ? ' (awaiting approval)' : ''}`, amount: v.amount_pkr, date: v.created_at })
    }
    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    setReadyItems(items)
    setLoading(false)
  }, [system, supabase])

  useEffect(() => { load() }, [load])

  const accountsByType = (type: string) => accounts.filter((a) => a.type === type)

  const openReceiptFor = async (item: ReadyItem) => {
    if (item.type === 'bill') {
      const { data: bill } = await supabase.from('bills').select('*, consumers(name, name_ur, mobile)').eq('id', item.id).single()
      if (!bill) return
      const consumerRow = Array.isArray(bill.consumers) ? bill.consumers[0] : bill.consumers
      setReceipt({
        kind: 'bill', receiptNo: bill.bill_number ?? '—', date: bill.created_at ?? today(),
        systemLabel: systemLabels[system], accountName: consumerRow?.name ?? '—', accountNameUr: consumerRow?.name_ur ?? null,
        particular: item.label, amount: bill.amount_pkr, balanceAfter: bill.amount_pkr,
      })
      await supabase.from('bills').update({ whatsapp_sent_at: new Date().toISOString() }).eq('id', item.id)
    } else if (item.type === 'donation') {
      const { data: donor } = await supabase.from('donors').select('*').eq('id', item.id).single()
      if (!donor) return
      const donationTotals = await donorReceiptTotals(item.id)
      setReceipt({
        kind: 'donation', receiptNo: donor.voucher_no ?? '—', date: donor.date,
        systemLabel: systemLabels[system], accountName: donor.name, accountNameUr: donor.name_ur,
        particular: item.label, amount: donor.amount_pkr,
        balanceAfter: donationTotals.totalContributed, announcedRemaining: donationTotals.announcedRemaining,
        projectName: donationTotals.projectName,
      isConfirmed: donationTotals.isConfirmed,
      })
      await supabase.from('donors').update({ whatsapp_sent_at: new Date().toISOString() }).eq('id', item.id)
    }
    setReadyItems((prev) => prev.filter((r) => r.key !== item.key))
  }

  const save = async () => {
    if (!form.amount_pkr || form.amount_pkr <= 0) { toast.error('Enter a valid amount'); return }
    if (form.schedule_type === 'bill' && !form.consumer_id) { toast.error('Select a consumer'); return }
    if (form.schedule_type === 'donation' && !form.donor_name.trim()) { toast.error('Enter donor name'); return }
    if (form.schedule_type === 'expense' && (!form.from_account_id || !form.to_account_id)) { toast.error('Select both accounts'); return }
    if (form.schedule_type === 'bill') {
      const { data: existing } = await supabase.from('recurring_schedules').select('id')
        .eq('consumer_id', form.consumer_id).eq('schedule_type', 'bill').eq('is_active', true).maybeSingle()
      if (existing) { toast.error('This consumer already has an active recurring bill — edit or pause that one instead of creating a second'); return }
    }

    setSaving(true)
    // The testing frequency has no meaningful "start date" from a date-only picker —
    // it always starts one minute from creation, so waiting ~60s and reloading this
    // page actually proves the recurring engine fires on its own.
    const nextRunDate = form.frequency === 'every_minute'
      ? new Date(Date.now() + 60_000).toISOString()
      : form.start_date
    const { error } = await supabase.from('recurring_schedules').insert({
      system, schedule_type: form.schedule_type, frequency: form.frequency, next_run_date: nextRunDate,
      amount_pkr: form.amount_pkr,
      consumer_id: form.schedule_type === 'bill' ? form.consumer_id : null,
      due_date_offset_days: form.due_date_offset_days,
      donor_name: form.schedule_type === 'donation' ? form.donor_name : null,
      donor_name_ur: form.schedule_type === 'donation' ? (form.donor_name_ur || null) : null,
      donor_phone: form.schedule_type === 'donation' ? (form.donor_phone || null) : null,
      donor_type: form.schedule_type === 'donation' ? form.donor_type : null,
      project_id: form.schedule_type === 'donation' ? (form.project_id || null) : null,
      payment_method: form.schedule_type !== 'expense' ? form.payment_method : null,
      from_account_id: form.schedule_type === 'expense' ? form.from_account_id : null,
      to_account_id: form.schedule_type === 'expense' ? form.to_account_id : null,
      party_name: form.schedule_type === 'expense' ? (form.party_name || null) : null,
      particular: form.particular || null,
    })
    setSaving(false)
    if (error) { toast.error(error.code === '23505' ? 'This consumer already has an active recurring bill' : error.message); return }

    toast.success(form.frequency === 'every_minute'
      ? 'Recurring schedule created — reload this page in about a minute to see it fire'
      : 'Recurring schedule created — generating the first occurrence now')
    await supabase.rpc('run_due_recurring_schedules')
    setShowForm(false)
    setForm(emptyForm)
    load()
  }

  const toggleActive = async (s: Schedule) => {
    await supabase.from('recurring_schedules').update({ is_active: !s.is_active }).eq('id', s.id)
    toast.success(s.is_active ? 'Paused' : 'Resumed')
    load()
  }

  const deleteSchedule = async () => {
    if (!confirmDelete) return
    const { error } = await supabase.from('recurring_schedules').delete().eq('id', confirmDelete)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Schedule removed')
    setConfirmDelete(null)
    load()
  }

  const scheduleLabel = (s: Schedule) => {
    if (s.schedule_type === 'bill') return consumers.find((c) => c.consumer_id === s.consumer_id)?.name ?? s.consumer_id ?? '—'
    if (s.schedule_type === 'donation') return s.donor_name ?? '—'
    return s.party_name || accounts.find((a) => a.id === s.to_account_id)?.name || '—'
  }

  // Full generation history for one schedule — every bill/donation/expense it ever
  // created (not just the unsent "Ready to Send" queue), so an accountant who
  // accidentally checked the recurring box can find and undo it without hunting
  // through the ledger.
  const openHistory = async (s: Schedule) => {
    setHistorySchedule(s)
    setSelectedHistoryIds(new Set())
    setLoadingHistory(true)
    let items: HistoryItem[] = []
    if (s.schedule_type === 'bill') {
      const { data } = await supabase.from('bills')
        .select('id, bill_number, month, year, amount_pkr, status, created_at')
        .eq('recurring_schedule_id', s.id).order('created_at', { ascending: false })
      items = (data ?? []).map((b) => ({ id: b.id, label: `Bill #${b.bill_number} — ${b.month}/${b.year}`, amount: b.amount_pkr, date: b.created_at, status: b.status }))
    } else if (s.schedule_type === 'donation') {
      const { data } = await supabase.from('donors')
        .select('id, name, amount_pkr, date, created_at')
        .eq('recurring_schedule_id', s.id).order('created_at', { ascending: false })
      items = (data ?? []).map((d) => ({ id: d.id, label: `Donation — ${d.name}`, amount: d.amount_pkr, date: d.date, status: 'recorded' }))
    } else {
      const { data } = await supabase.from('vouchers')
        .select('id, voucher_no, particular, amount_pkr, status, voucher_date')
        .eq('recurring_schedule_id', s.id).order('voucher_date', { ascending: false })
      items = (data ?? []).map((v) => ({ id: v.id, label: `${v.voucher_no ?? '(unposted)'} — ${v.particular}`, amount: v.amount_pkr, date: v.voucher_date, status: v.status }))
    }
    setHistoryItems(items)
    setLoadingHistory(false)
  }

  const toggleHistorySelected = (id: string) => {
    setSelectedHistoryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const deleteSelectedHistory = async () => {
    if (!historySchedule || selectedHistoryIds.size === 0) return
    const table = historySchedule.schedule_type === 'bill' ? 'bills' : historySchedule.schedule_type === 'donation' ? 'donors' : 'vouchers'
    const ids = Array.from(selectedHistoryIds)
    const { error } = await supabase.from(table).delete().in('id', ids)
    setConfirmDeleteHistory(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`${ids.length} record(s) deleted — ledger updated accordingly`)
    openHistory(historySchedule)
    load()
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href={`/admin/finance/${system}`} className="flex items-center gap-2 text-dp-on-surface-variant hover:text-dp-primary font-sans text-[14px] font-semibold mb-3">
            <ArrowLeft size={16} /> Back to Transactions
          </Link>
          <h1 className="font-heading text-[22px] sm:text-[28px] font-bold leading-[28px] sm:leading-[36px] text-dp-primary">{systemLabels[system]} — Recurring</h1>
        </div>
        <button onClick={() => { setForm(emptyForm); setShowForm(true) }} className="shrink-0 flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <PlusCircle size={15} /> New Recurring Schedule
        </button>
      </div>

      {readyItems.length > 0 && (
        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-5">
          <div className="px-4 py-3 bg-amber-50 border-b border-dp-outline-variant flex items-center gap-2">
            <Share2 size={15} className="text-amber-700" />
            <span className="font-sans text-[14px] font-bold text-amber-900">Ready to Send ({readyItems.length})</span>
          </div>
          {readyItems.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-3 px-4 py-3 border-t border-dp-outline-variant first:border-t-0">
              <div className="min-w-0">
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{item.label}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">Rs. {fmtAmount(item.amount)} · {new Date(item.date).toLocaleDateString('en-GB')}</p>
              </div>
              {item.type !== 'expense' && (
                <button onClick={() => openReceiptFor(item)} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                  <Share2 size={13} /> Share Receipt
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start min-w-[650px]">
            <thead>
              <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                <th className="px-4 py-2.5">{t('a.type')}</th>
                <th className="px-4 py-2.5">For</th>
                <th className="px-4 py-2.5">{t('w.frequency')}</th>
                <th className="px-4 py-2.5 text-end">{t('w.amount')}</th>
                <th className="px-4 py-2.5">{t('rc.nextRun')}</th>
                <th className="px-4 py-2.5">{t('w.status')}</th>
                <th className="px-4 py-2.5 text-end">{t('a.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{t('action.loading')}</td></tr>}
              {!loading && schedules.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">No recurring schedules yet.</td></tr>}
              {!loading && schedules.map((s) => (
                <tr key={s.id} className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${!s.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 flex items-center gap-1.5"><Repeat size={13} className="text-dp-secondary" /> {scheduleTypeLabels[s.schedule_type]}</td>
                  <td className="px-4 py-3">{scheduleLabel(s)}</td>
                  <td className="px-4 py-3">{frequencyLabels[s.frequency]}</td>
                  <td className="px-4 py-3 text-end font-semibold">{fmtAmount(s.amount_pkr)}</td>
                  <td className="px-4 py-3">
                    {s.frequency === 'every_minute'
                      ? new Date(s.next_run_date).toLocaleString('en-GB')
                      : new Date(s.next_run_date).toLocaleDateString('en-GB')}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${s.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {s.is_active ? 'Active' : 'Paused'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-end">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => openHistory(s)} title="Recurring History" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><History size={15} /></button>
                      <button onClick={() => toggleActive(s)} title={s.is_active ? 'Pause' : 'Resume'} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer">
                        {s.is_active ? <Pause size={15} /> : <Play size={15} />}
                      </button>
                      <button onClick={() => setConfirmDelete(s.id)} title="Delete" className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Recurring Schedule"
        message="This stops future automatic generation. Anything already generated stays as-is. This cannot be undone."
        onConfirm={deleteSchedule}
        onCancel={() => setConfirmDelete(null)}
      />

      {receipt && <ReceiptModal data={receipt} system={system} onClose={() => setReceipt(null)} />}

      {historySchedule && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setHistorySchedule(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">Recurring History</h2>
              <button onClick={() => setHistorySchedule(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {scheduleTypeLabels[historySchedule.schedule_type]} · {scheduleLabel(historySchedule)} · {frequencyLabels[historySchedule.frequency]}
            </p>

            {loadingHistory && <p className="font-sans text-[13.5px] text-dp-on-surface-variant text-center py-8">{t('action.loading')}</p>}
            {!loadingHistory && historyItems.length === 0 && (
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant text-center py-8">Nothing generated by this schedule yet.</p>
            )}
            {!loadingHistory && historyItems.length > 0 && (
              <>
                <div className="border border-dp-outline-variant rounded-lg overflow-hidden mb-4">
                  {historyItems.map((item) => (
                    <label key={item.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-dp-outline-variant last:border-b-0 cursor-pointer hover:bg-dp-surface-container-low">
                      <input type="checkbox" checked={selectedHistoryIds.has(item.id)} onChange={() => toggleHistorySelected(item.id)} className="shrink-0 w-4 h-4 cursor-pointer" />
                      <div className="min-w-0 flex-1">
                        <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{item.label}</p>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant">Rs. {fmtAmount(item.amount)} · {new Date(item.date).toLocaleDateString('en-GB')} · {item.status}</p>
                      </div>
                    </label>
                  ))}
                </div>
                <button
                  disabled={selectedHistoryIds.size === 0}
                  onClick={() => setConfirmDeleteHistory(true)}
                  className="w-full flex items-center justify-center gap-2 bg-dp-error text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-40"
                >
                  <Trash2 size={16} /> Delete Selected ({selectedHistoryIds.size})
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteHistory}
        title="Delete Generated Records"
        message={`This permanently removes ${selectedHistoryIds.size} selected record(s) and reverses their ledger impact. A bill with payments recorded against it cannot be deleted until those payments are removed first. This can be undone from the Audit Log.`}
        onConfirm={deleteSelectedHistory}
        onCancel={() => setConfirmDeleteHistory(false)}
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">New Recurring Schedule</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.type')}</label>
                <select value={form.schedule_type} onChange={(e) => setForm({ ...form, schedule_type: e.target.value as ScheduleType })} className="input-field">
                  {system === 'water_supply' && <option value="bill">Water Bill</option>}
                  {system === 'donors_projects' && <option value="donation">{t('rc.donation')}</option>}
                  <option value="expense">{t('rc.expense')}</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.frequency')}</label>
                  <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })} className="input-field">
                    <option value="daily">Daily</option>
                    <option value="weekly">{t('w.weekly')}</option>
                    <option value="monthly">{t('w.monthly')}</option>
                    <option value="semi_annual">{t('w.semiAnnual')}</option>
                    <option value="yearly">{t('w.yearly')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Start Date</label>
                  {form.frequency === 'every_minute' ? (
                    <p className="input-field flex items-center text-dp-on-surface-variant !py-3">Fires ~1 minute from now</p>
                  ) : (
                    <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} className="input-field" />
                  )}
                </div>
              </div>

              {form.schedule_type === 'bill' && (
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.consumer')}</label>
                  <select
                    value={form.consumer_id}
                    onChange={(e) => {
                      const c = consumers.find((x) => x.consumer_id === e.target.value)
                      setForm({ ...form, consumer_id: e.target.value, amount_pkr: c?.monthly_rate ?? form.amount_pkr })
                    }}
                    className="input-field"
                  >
                    <option value="">Select consumer...</option>
                    {consumers.map((c) => <option key={c.consumer_id} value={c.consumer_id}>{c.name} ({c.consumer_id})</option>)}
                  </select>
                </div>
              )}

              {form.schedule_type === 'donation' && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Donor Name</label>
                      <input value={form.donor_name} onChange={(e) => setForm({ ...form, donor_name: e.target.value })} className="input-field" />
                    </div>
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.phone')}</label>
                      <input value={form.donor_phone} onChange={(e) => setForm({ ...form, donor_phone: e.target.value })} placeholder="0300-1234567" className="input-field" />
                    </div>
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Project (optional)</label>
                    <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className="input-field">
                      <option value="">{t('a.noProject')}</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                    </select>
                  </div>
                </>
              )}

              {form.schedule_type === 'expense' && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Pay From</label>
                      <select value={form.from_account_id} onChange={(e) => setForm({ ...form, from_account_id: e.target.value })} className="input-field">
                        <option value="">{t('a.select')}</option>
                        {[...accountsByType('cash'), ...accountsByType('bank')].map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Expense Account</label>
                      <select value={form.to_account_id} onChange={(e) => setForm({ ...form, to_account_id: e.target.value })} className="input-field">
                        <option value="">{t('a.select')}</option>
                        {accountsByType('expense').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Paid To (optional)</label>
                    <input value={form.party_name} onChange={(e) => setForm({ ...form, party_name: e.target.value })} className="input-field" />
                  </div>
                </>
              )}

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                <input type="number" value={form.amount_pkr || ''} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.descriptionOptional')}</label>
                <input value={form.particular} onChange={(e) => setForm({ ...form, particular: e.target.value })} className="input-field" />
              </div>

              <button disabled={saving} onClick={save} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {saving ? 'Creating...' : 'Create Recurring Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
