'use client'

// 873: admin trip-history — real spec given live: click a bus's travel
// route and see the full map of where it actually went (planned path
// vs its real recorded GPS trail), fuel cost and where it was bought,
// who's driving and how many times they shuffled (surfaces the
// EXISTING route_run_substitutions data only — the shuffle mechanism
// itself stays exactly as it is, per direct instruction), how many
// passengers and how much luggage boarded along the way, and earnings
// vs cost for that specific run.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { History, Users2, Package, Fuel, TrendingUp, ArrowLeft, UserCog } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface RunRow { id: string; route_id: string; direction: string; started_at: string; ended_at: string | null; origin: string; destination: string; owner_name: string; vehicle_type: string }
interface Passenger { id: string; source: 'manual' | 'app'; passenger_name: string; seats: number; amount: number; boarded_at: string | null; dropped_off_at: string | null }
interface Luggage { id: string; sender_name: string; receiver_name: string; fare_pkr: number; status: string; loaded_at: string | null; delivered_at: string | null }
interface DriverEntry { owner_name: string; reason: string; created_at: string | null }
interface ExpenseEntry { id: string; category: string; amount_pkr: number; note: string | null; station_name: string | null; lat: number | null; lng: number | null; expense_date: string }
interface RunDetail {
  route_run_id: string; route_id: string; origin: string; destination: string; owner_name: string; vehicle_type: string
  direction: string; started_at: string; ended_at: string | null; travel_date: string
  planned_path: { lat: number; lng: number }[] | null; actual_path: { lat: number; lng: number; recorded_at: string }[]
  passengers: Passenger[]; luggage: Luggage[]; driver_timeline: DriverEntry[]; expenses: ExpenseEntry[]
  total_passengers: number; total_luggage_count: number; earnings_pkr: number; expenses_pkr: number
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function fmtDateTime(iso: string | null) { return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—' }
function today() { return new Date().toISOString().slice(0, 10) }

export default function AdminTripHistoryPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 13); return d.toISOString().slice(0, 10) })
  const [to, setTo] = useState(today())
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const loadRuns = async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_recent_route_runs', { p_from: from, p_to: to })
    setLoading(false)
    if (error) { toast.error(friendlyError(error)); return }
    setRuns((data ?? []) as RunRow[])
  }

  useEffect(() => { if (access.canDonorsProjects) loadRuns() }, [access.canDonorsProjects, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  const openRun = async (id: string) => {
    setSelectedRunId(id)
    setLoadingDetail(true)
    const { data, error } = await supabase.rpc('route_run_detail', { p_route_run_id: id })
    setLoadingDetail(false)
    if (error) { toast.error(friendlyError(error)); return }
    setDetail(data as RunDetail)
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('fm.noAccessMessage')}</p></div>
  }

  if (selectedRunId) {
    const mapPins: MapPin[] = []
    if (detail?.actual_path && detail.actual_path.length > 0) {
      mapPins.push({ lat: detail.actual_path[0].lat, lng: detail.actual_path[0].lng, emoji: '🟢', label: t('th.startPinLabel') })
      const last = detail.actual_path[detail.actual_path.length - 1]
      mapPins.push({ lat: last.lat, lng: last.lng, emoji: '🔴', label: t('th.latestPinLabel') })
    }
    const profit = (detail?.earnings_pkr ?? 0) - (detail?.expenses_pkr ?? 0)
    return (
      <div className="shop-ink-theme">
        <button onClick={() => { setSelectedRunId(null); setDetail(null) }} className="flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary cursor-pointer mb-3">
          <ArrowLeft size={15} /> {t('th.backToListBtn')}
        </button>
        {loadingDetail || !detail ? (
          <div className="text-center py-12"><LoadingDots /></div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <h1 className="font-heading text-[24px] font-bold text-dp-primary">{detail.owner_name} · {detail.vehicle_type}</h1>
              <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">{detail.origin} → {detail.destination} · {detail.travel_date}</p>
            </div>

            <LeafletMap
              pins={mapPins}
              route={detail.planned_path ?? undefined}
              extraRoutes={detail.actual_path.length > 1 ? [{ path: detail.actual_path, color: '#1d4ed8', weight: 4 }] : undefined}
              height={320} className="rounded-lg border border-dp-outline-variant"
            />
            <p className="font-sans text-[11px] text-dp-on-surface-variant flex items-center gap-3">
              <span className="flex items-center gap-1"><span className="w-3 h-1 rounded-full bg-[#166534] inline-block" /> {t('th.plannedPathLabel')}</span>
              <span className="flex items-center gap-1"><span className="w-3 h-1 rounded-full bg-[#1d4ed8] inline-block" /> {t('th.actualPathLabel')}</span>
            </p>

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-3">
                <div className="flex items-center gap-1.5 text-[#166534]"><TrendingUp size={13} /><span className="font-sans text-[10px] font-bold uppercase">{t('th.earningsLabel')}</span></div>
                <p className="font-sans text-[17px] font-extrabold text-[#166534] ltr-num mt-0.5">₨{fmt(detail.earnings_pkr)}</p>
              </div>
              <div className={`border rounded-lg p-3 ${profit >= 0 ? 'bg-[#F0FDF4] border-[#bbf7d0]' : 'bg-red-50 border-red-200'}`}>
                <div className={`flex items-center gap-1.5 ${profit >= 0 ? 'text-[#166534]' : 'text-[#b91c1c]'}`}><TrendingUp size={13} /><span className="font-sans text-[10px] font-bold uppercase">{t('th.profitLabel')}</span></div>
                <p className={`font-sans text-[17px] font-extrabold ltr-num mt-0.5 ${profit >= 0 ? 'text-[#166534]' : 'text-[#b91c1c]'}`}>₨{fmt(profit)}</p>
              </div>
            </div>

            <div>
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-1.5 flex items-center gap-1"><UserCog size={12} /> {t('th.driverTimelineHeading')}</p>
              <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant/60">
                {detail.driver_timeline.map((d, i) => (
                  <div key={i} className="p-2.5 flex items-center justify-between">
                    <span className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{d.owner_name}</span>
                    <span className="font-sans text-[10.5px] text-dp-on-surface-variant">{d.reason === 'regular' ? t('th.regularDriverLabel') : fmtDateTime(d.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-1.5 flex items-center gap-1"><Fuel size={12} /> {t('th.expensesHeading')} <span className="ltr-num">₨{fmt(detail.expenses_pkr)}</span></p>
              {detail.expenses.length === 0 ? (
                <p className="font-sans text-[12px] text-dp-on-surface-variant text-center py-3 bg-white border border-dp-outline-variant rounded-lg">{t('th.noExpensesForTripHint')}</p>
              ) : (
                <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant/60">
                  {detail.expenses.map((e) => (
                    <div key={e.id} className="p-2.5 flex items-center justify-between">
                      <div>
                        <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{e.category}{e.station_name ? ` · ${e.station_name}` : ''}</p>
                        {e.note && <p className="font-sans text-[10.5px] text-dp-on-surface-variant">{e.note}</p>}
                      </div>
                      <span className="font-sans text-[12.5px] font-bold text-[#b91c1c] ltr-num">₨{fmt(e.amount_pkr)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-1.5 flex items-center gap-1"><Users2 size={12} /> {t('th.passengersHeading')} ({detail.total_passengers})</p>
              <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant/60">
                {detail.passengers.length === 0 && <p className="font-sans text-[12px] text-dp-on-surface-variant text-center py-3">{t('th.noPassengersHint')}</p>}
                {detail.passengers.map((p) => (
                  <div key={`${p.source}-${p.id}`} className="p-2.5 flex items-center justify-between">
                    <div>
                      <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{p.passenger_name} <span className="font-normal text-dp-on-surface-variant">· {p.seats} {t('mv.seatsSuffix')}</span></p>
                      <p className="font-sans text-[10.5px] text-dp-on-surface-variant">{p.boarded_at ? `${t('th.boardedLabel')} ${fmtDateTime(p.boarded_at)}` : t('th.notBoardedLabel')}{p.dropped_off_at ? ` · ${t('th.droppedOffLabel')} ${fmtDateTime(p.dropped_off_at)}` : ''}</p>
                    </div>
                    <span className="font-sans text-[12.5px] font-bold text-[#166534] ltr-num">₨{fmt(p.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-1.5 flex items-center gap-1"><Package size={12} /> {t('th.luggageHeading')} ({detail.total_luggage_count})</p>
              <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant/60">
                {detail.luggage.length === 0 && <p className="font-sans text-[12px] text-dp-on-surface-variant text-center py-3">{t('th.noLuggageHint')}</p>}
                {detail.luggage.map((l) => (
                  <div key={l.id} className="p-2.5 flex items-center justify-between">
                    <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{l.sender_name} → {l.receiver_name} <span className="font-normal text-dp-on-surface-variant">· {l.status}</span></p>
                    <span className="font-sans text-[12.5px] font-bold text-[#166534] ltr-num">₨{fmt(l.fare_pkr)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="shop-ink-theme">
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><History size={26} /> {t('nav.tripHistory')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('th.pageSubtitle')}</p>
      </div>

      <div className="flex gap-2 mb-4">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field max-w-[180px] ltr-num" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field max-w-[180px] ltr-num" />
      </div>

      {loading ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>
      ) : runs.length === 0 ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('th.noRunsHint')}</p>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => (
            <button key={r.id} onClick={() => openRun(r.id)} className="w-full text-start bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3 cursor-pointer hover:border-dp-secondary">
              <div className="min-w-0">
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{r.owner_name} <span className="font-normal text-dp-on-surface-variant">· {r.vehicle_type}</span></p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant truncate">{r.origin} → {r.destination} · {r.direction}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{fmtDateTime(r.started_at)}{r.ended_at ? ` – ${fmtDateTime(r.ended_at)}` : ` · ${t('th.inProgressLabel')}`}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
