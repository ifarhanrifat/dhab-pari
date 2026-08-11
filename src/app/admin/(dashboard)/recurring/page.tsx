'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { RotateCcw, Trash2, Repeat, ListChecks } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type SystemTab = 'water_supply' | 'donors_projects'
type Frequency = 'every_minute' | 'daily' | 'weekly' | 'monthly' | 'semi_annual' | 'yearly'
type ScheduleType = 'bill' | 'donation' | 'expense'

const frequencyLabels: Record<Frequency, string> = {
  every_minute: 'Every Minute (Testing)', daily: 'Daily', weekly: 'Weekly',
  monthly: 'Monthly', semi_annual: 'Every 6 Months', yearly: 'Yearly',
}

interface Schedule {
  id: string; schedule_type: ScheduleType; frequency: Frequency; next_run_date: string
  is_active: boolean; last_run_at: string | null; amount_pkr: number
  consumer_id: string | null; donor_name: string | null; party_name: string | null; particular: string | null
}

interface TxnRow { id: string; date: string; label: string; particular: string; amount: number }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function RecurringPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const [system, setSystem] = useState<SystemTab>('water_supply')
  const [systemOverride] = useState<SystemTab | null>(() => {
    if (typeof window === 'undefined') return null
    const p = new URLSearchParams(window.location.search).get('system')
    return p === 'water_supply' || p === 'donors_projects' ? p : null
  })
  useEffect(() => {
    if (access.loading) return
    if (systemOverride === 'water_supply' && access.canWaterSupply) { setSystem('water_supply'); return }
    if (systemOverride === 'donors_projects' && access.canDonorsProjects) { setSystem('donors_projects'); return }
    setSystem(access.defaultSystem)
  }, [access.loading, access.defaultSystem, access.canWaterSupply, access.canDonorsProjects, systemOverride])
  const [tab, setTab] = useState<'schedules' | 'transactions'>('schedules')
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [consumerNames, setConsumerNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)

  const [typeFilter, setTypeFilter] = useState<ScheduleType>('bill')
  const [dateFilter, setDateFilter] = useState('')
  const [txnRows, setTxnRows] = useState<TxnRow[]>([])
  const [txnLoading, setTxnLoading] = useState(true)

  const supabase = createClient()

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: schedulesData }, { data: consumersData }] = await Promise.all([
      supabase.from('recurring_schedules').select('id, schedule_type, frequency, next_run_date, is_active, last_run_at, amount_pkr, consumer_id, donor_name, party_name, particular')
        .eq('system', system).order('next_run_date'),
      system === 'water_supply' ? supabase.from('consumers').select('consumer_id, name') : Promise.resolve({ data: [] }),
    ])
    setSchedules(schedulesData ?? [])
    setConsumerNames(Object.fromEntries((consumersData ?? []).map((c) => [c.consumer_id, c.name])))
    setLoading(false)
  }, [system, supabase])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    // A donors_projects committee has no "bill" schedules to speak of — default to
    // whatever type actually applies when switching systems.
    setTypeFilter(system === 'water_supply' ? 'bill' : 'donation')
  }, [system])

  const loadTransactions = useCallback(async () => {
    setTxnLoading(true)
    let rows: TxnRow[] = []
    if (typeFilter === 'bill') {
      let q = supabase.from('bills').select('id, bill_number, amount_pkr, discount_amount, consumer_id, created_at').not('recurring_schedule_id', 'is', null).order('created_at', { ascending: false })
      if (dateFilter) q = q.gte('created_at', dateFilter).lte('created_at', `${dateFilter}T23:59:59`)
      const { data } = await q
      rows = (data ?? []).map((b) => ({
        id: b.id, date: b.created_at.slice(0, 10),
        label: `Bill ${b.bill_number ?? ''} — ${consumerNames[b.consumer_id] ?? b.consumer_id}`,
        particular: b.consumer_id, amount: Math.max(b.amount_pkr - (b.discount_amount ?? 0), 0),
      }))
    } else if (typeFilter === 'donation') {
      let q = supabase.from('donors').select('id, name, amount_pkr, date').not('recurring_schedule_id', 'is', null).order('date', { ascending: false })
      if (dateFilter) q = q.eq('date', dateFilter)
      const { data } = await q
      rows = (data ?? []).map((d) => ({ id: d.id, date: d.date, label: `Donation — ${d.name}`, particular: d.name, amount: d.amount_pkr }))
    } else {
      let q = supabase.from('vouchers').select('id, voucher_no, particular, amount_pkr, voucher_date').eq('system', system).not('recurring_schedule_id', 'is', null).order('voucher_date', { ascending: false })
      if (dateFilter) q = q.eq('voucher_date', dateFilter)
      const { data } = await q
      rows = (data ?? []).map((v) => ({ id: v.id, date: v.voucher_date, label: `Voucher ${v.voucher_no ?? '(pending)'}`, particular: v.particular, amount: v.amount_pkr }))
    }
    setTxnRows(rows)
    setTxnLoading(false)
  }, [typeFilter, dateFilter, system, supabase, consumerNames])

  useEffect(() => { if (tab === 'transactions') loadTransactions() }, [tab, loadTransactions])

  const removeSchedule = async () => {
    if (!confirmRemoveId) return
    const { error } = await supabase.from('recurring_schedules').delete().eq('id', confirmRemoveId)
    if (error) { toast.error(friendlyError(error)); setConfirmRemoveId(null); return }
    toast.success('Recurring schedule removed — it will never fire again')
    setConfirmRemoveId(null)
    load()
  }

  const resetSchedule = async (id: string) => {
    setResettingId(id)
    const { error } = await supabase.rpc('reset_recurring_schedule', { p_schedule_id: id })
    setResettingId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Schedule reset — next occurrence recalculated from today')
    load()
  }

  const scheduleLabel = (s: Schedule) => {
    if (s.schedule_type === 'bill') return consumerNames[s.consumer_id ?? ''] ?? s.consumer_id ?? '—'
    if (s.schedule_type === 'donation') return s.donor_name ?? '—'
    return s.party_name || s.particular || 'Expense'
  }

  const totals = useMemo(() => ({
    amount: txnRows.reduce((s, r) => s + r.amount, 0),
    count: txnRows.length,
  }), [txnRows])

  return (
    <>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <Repeat size={26} /> {t('a.recurring')}
        </h1>
        {!access.loading && (access.canWaterSupply || access.canDonorsProjects) && (
          <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
            {access.canWaterSupply && (
              <button onClick={() => setSystem('water_supply')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'water_supply' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>{t('a.waterSupply')}</button>
            )}
            {access.canDonorsProjects && (
              <button onClick={() => setSystem('donors_projects')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'donors_projects' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>{t('a.donorsProjects')}</button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mb-5 border-b border-dp-outline-variant overflow-x-auto admin-scrollbar">
        {(['schedules', 'transactions'] as const).map((t) => (
          <button
            key={t} onClick={() => setTab(t)}
            className={`px-4 py-2.5 font-sans text-[14px] font-semibold border-b-2 -mb-px transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${tab === t ? 'border-dp-secondary text-dp-primary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}
          >
            {t === 'schedules' ? <Repeat size={15} /> : <ListChecks size={15} />}
            {t === 'schedules' ? 'Schedules' : 'Recurring Transactions'}
          </button>
        ))}
      </div>

      {tab === 'schedules' && (
        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-start min-w-[750px]">
              <thead>
                <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                  <th className="px-4 py-2.5">For</th>
                  <th className="px-4 py-2.5">{t('a.type')}</th>
                  <th className="px-4 py-2.5">{t('w.frequency')}</th>
                  <th className="px-4 py-2.5 text-end">{t('w.amount')}</th>
                  <th className="px-4 py-2.5">{t('rc.nextRun')}</th>
                  <th className="px-4 py-2.5">{t('rc.lastRun')}</th>
                  <th className="px-4 py-2.5">{t('w.status')}</th>
                  <th className="px-4 py-2.5 text-end">{t('a.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{t('action.loading')}</td></tr>}
                {!loading && schedules.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{t('rc.noSchedules')}</td></tr>}
                {!loading && schedules.map((s) => (
                  <tr key={s.id} className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${!s.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 font-semibold">{scheduleLabel(s)}</td>
                    <td className="px-4 py-3 text-dp-on-surface-variant capitalize">{s.schedule_type}</td>
                    <td className="px-4 py-3 text-dp-on-surface-variant">{frequencyLabels[s.frequency]}</td>
                    <td className="px-4 py-3 text-end font-bold">{fmtAmount(s.amount_pkr)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{new Date(s.next_run_date).toLocaleString('en-GB')}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-dp-on-surface-variant">{s.last_run_at ? new Date(s.last_run_at).toLocaleString('en-GB') : '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${s.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{s.is_active ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-1.5">
                        <button disabled={resettingId === s.id} onClick={() => resetSchedule(s.id)} title="Reset — recalculate next occurrence from today" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer disabled:opacity-40"><RotateCcw size={15} /></button>
                        <button onClick={() => setConfirmRemoveId(s.id)} title="Remove schedule" className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'transactions' && (
        <>
          <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('a.type')}</label>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ScheduleType)} className="input-field !py-2 text-[14px]">
                {system === 'water_supply' && <option value="bill">{t('rc.bill')}</option>}
                {system === 'donors_projects' && <option value="donation">{t('rc.donation')}</option>}
                <option value="expense">{t('rc.expense')}</option>
              </select>
            </div>
            <div>
              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('w.date')}</label>
              <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="input-field !py-2 text-[14px]" />
            </div>
            {dateFilter && (
              <button onClick={() => setDateFilter('')} className="px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
                {t('rc.clearDate')}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{dateFilter ? `Total Recurred — ${new Date(dateFilter).toLocaleDateString('en-GB')}` : 'Total Recurred'}</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">Rs. {fmtAmount(totals.amount)}</p>
            </div>
            <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{dateFilter ? 'Transactions on this date' : 'Total Transactions'}</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary">{totals.count}</p>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start min-w-[500px]">
                <thead>
                  <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                    <th className="px-4 py-2.5">{t('w.date')}</th>
                    <th className="px-4 py-2.5">{t('rc.transaction')}</th>
                    <th className="px-4 py-2.5 text-end">{t('w.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {txnLoading && <tr><td colSpan={3} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{t('action.loading')}</td></tr>}
                  {!txnLoading && txnRows.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{t('rc.noneOfType')}</td></tr>}
                  {!txnLoading && txnRows.map((r) => (
                    <tr key={r.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                      <td className="px-4 py-3 whitespace-nowrap">{new Date(r.date).toLocaleDateString('en-GB')}</td>
                      <td className="px-4 py-3 font-semibold">{r.label}</td>
                      <td className="px-4 py-3 text-end font-bold">{fmtAmount(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!confirmRemoveId}
        title="Remove Recurring Schedule"
        message="This stops it from ever firing again. Bills/vouchers/donations it already generated stay exactly as they are — this only removes the schedule itself."
        onConfirm={removeSchedule}
        onCancel={() => setConfirmRemoveId(null)}
      />
    </>
  )
}
