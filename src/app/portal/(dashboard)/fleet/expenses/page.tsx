'use client'

// 860: Expenses tab — the existing log-an-expense form (854's record_
// vehicle_expense), moved off the single long fleet page, plus a history
// list (new UI; the data already existed in vehicle_expenses, just
// wasn't shown anywhere before).

import { useEffect, useState } from 'react'
import { Fuel } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string }
interface Expense { id: string; vehicle_id: string; category: string; amount_pkr: number; note: string | null; expense_date: string }
interface RecentRun { id: string; started_at: string; vehicle_routes: { origin: string; destination: string } | null }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function FleetExpensesPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [category, setCategory] = useState('fuel')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [stationName, setStationName] = useState('')
  const [routeRunId, setRouteRunId] = useState('')
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([])
  const [logging, setLogging] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string } | null
    setFleetId(f?.fleet_id ?? null)
    if (f) {
      const { data: v } = await supabase.rpc('my_fleet_vehicles')
      const vs = (v ?? []) as FleetVehicle[]
      setVehicles(vs)
      if (vs.length > 0) setVehicleId((prev) => prev || vs[0].id)
      const { data: exp } = await supabase.from('vehicle_expenses')
        .select('id, vehicle_id, category, amount_pkr, note, expense_date')
        .in('vehicle_id', vs.map((x) => x.id)).order('expense_date', { ascending: false }).limit(50)
      setExpenses((exp ?? []) as Expense[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (!vehicleId) { setRecentRuns([]); return }
    supabase.from('route_runs').select('id, started_at, vehicle_routes!inner(origin, destination, vehicle_id)').eq('vehicle_routes.vehicle_id', vehicleId)
      .order('started_at', { ascending: false }).limit(10).then(({ data }) => setRecentRuns((data ?? []) as unknown as RecentRun[]))
  }, [vehicleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const logExpense = async () => {
    if (!vehicleId || !amount) { toast.error(t('mv.enterExpenseAmountError')); return }
    setLogging(true)
    const { error } = await supabase.rpc('record_vehicle_expense', {
      p_vehicle_id: vehicleId, p_category: category, p_amount_pkr: Number(amount), p_note: note || null,
      p_route_run_id: routeRunId || null, p_station_name: category === 'fuel' ? (stationName || null) : null,
    })
    setLogging(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.expenseLoggedToast'))
    setAmount(''); setNote(''); setStationName(''); setRouteRunId('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Fuel size={19} /> {t('mv.fleetExpensesHeading')}</h1>

      {vehicles.length > 0 && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2">
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</option>)}
          </select>
          <div className="flex gap-2 mb-2">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
              <option value="fuel">{t('mv.expenseCategoryFuel')}</option>
              <option value="maintenance">{t('mv.expenseCategoryMaintenance')}</option>
              <option value="toll">{t('mv.expenseCategoryToll')}</option>
              <option value="other">{t('mv.expenseCategoryOther')}</option>
            </select>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('mv.expenseAmountPlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('mv.expenseNotePlaceholder')}
            className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5" />
          {category === 'fuel' && (
            <input value={stationName} onChange={(e) => setStationName(e.target.value)} placeholder={t('mv.stationNamePlaceholder')}
              className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5" />
          )}
          {recentRuns.length > 0 && (
            <>
              <label className="block font-sans text-[11px] font-bold text-[#64748b] mb-1">{t('mv.attributeToTripLabel')}</label>
              <select value={routeRunId} onChange={(e) => setRouteRunId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5">
                <option value="">—</option>
                {recentRuns.map((r) => <option key={r.id} value={r.id}>{r.vehicle_routes?.origin} → {r.vehicle_routes?.destination} · {new Date(r.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</option>)}
              </select>
            </>
          )}
          <button onClick={logExpense} disabled={logging} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {logging ? t('action.loading') : t('mv.logExpenseBtn')}
          </button>
        </div>
      )}

      <div>
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('mv.expenseHistoryHeading')}</p>
        {expenses.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noExpensesYetHint')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {expenses.map((e) => {
              const v = vehicles.find((x) => x.id === e.vehicle_id)
              return (
                <div key={e.id} className="bg-white border border-[#e5e2d0] rounded-lg px-3 py-2 flex items-center justify-between">
                  <div>
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{v?.owner_name ?? ''} · {t(`mv.expenseCategory${e.category.charAt(0).toUpperCase()}${e.category.slice(1)}`)}</p>
                    <p className="font-sans text-[10.5px] text-[#94a3b8]">{fmtDate(e.expense_date)}{e.note ? ` · ${e.note}` : ''}</p>
                  </div>
                  <span className="font-sans text-[13px] font-bold text-[#b91c1c] ltr-num">₨{fmt(e.amount_pkr)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
