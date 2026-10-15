'use client'

// Driver Home — the design file's own `driver:home` screen: profile card
// with the online switch, a city-presence row (this app's own real
// addition — the file has no multi-city driver concept), today's stats,
// a "new requests" banner straight to Jobs when anything needs a
// response, and quick links out to the operational screens the file
// shows inline on Home (adda queue, shared rides) but which our app
// already has as their own real pages — kept as link-outs here rather
// than re-embedded, since each already has its own live polling/actions.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MapPin, Bus, Route as RouteIcon, Users2, CalendarClock, ChevronRight, AlertCircle, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { useDriverJobsBadge } from '@/components/mobility/DriverJobsBadgeContext'

interface Vehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string; is_online: boolean }
interface Summary {
  today_earnings_pkr: number; today_jobs_count: number; pending_bookings_count: number
  avg_rating: number | null; balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null; commission_pct: number
}
interface City { id: string; name: string; name_ur: string | null }
interface Presence { city_id: string }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() }

export default function MyVehicleHomePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const { count: jobsBadge, refresh: refreshBadge } = useDriverJobsBadge()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [cities, setCities] = useState<City[]>([])
  const [presence, setPresence] = useState<Presence | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const reloadPresence = async (vehicleId: string) => {
    const { data: p } = await supabase.from('vehicle_city_presence').select('city_id').eq('vehicle_id', vehicleId).eq('is_active', true).maybeSingle()
    setPresence(p ?? null)
  }

  useEffect(() => {
    if (!user) return
    Promise.all([
      supabase.from('vehicles').select('id, owner_name, vehicle_type, vehicle_number, is_online').eq('portal_user_id', user.id).maybeSingle(),
      supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order'),
    ]).then(async ([{ data: v }, { data: c }]) => {
      setCities(c ?? [])
      if (v) {
        setVehicle(v)
        await Promise.all([supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: v.id }).then(({ data: s }) => setSummary(s as unknown as Summary)), reloadPresence(v.id)])
      }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOnline = async () => {
    if (!vehicle) return
    setSaving(true)
    const { error } = await supabase.rpc('set_vehicle_online_status', { p_vehicle_id: vehicle.id, p_is_online: !vehicle.is_online })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, is_online: !vehicle.is_online })
    toast.success(vehicle.is_online ? t('vp.wentOfflineToast') : t('vp.wentOnlineToast'))
  }

  const pickCity = async (cityId: string) => {
    if (!vehicle) return
    setSaving(true)
    const { error } = presence?.city_id === cityId
      ? await supabase.rpc('vehicle_check_out_city', { p_vehicle_id: vehicle.id })
      : await supabase.rpc('vehicle_check_in_city', { p_vehicle_id: vehicle.id, p_city_id: cityId })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reloadPresence(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return null // layout's own guard already handled the no-vehicle case

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
        <div className="flex items-center gap-3">
          <span className="shrink-0 w-11 h-11 rounded-full bg-[#005A36] text-white flex items-center justify-center font-bold text-[15px]">{initials(vehicle.owner_name)}</span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[14px] font-bold text-[#1e293b] truncate">{vehicle.owner_name}</p>
            <p className="font-sans text-[12px] text-[#64748b] truncate">{vehicle.vehicle_type} · {vehicle.vehicle_number}</p>
          </div>
          <button onClick={toggleOnline} disabled={saving} className="relative shrink-0 w-14 h-8 rounded-full border-0 cursor-pointer disabled:opacity-50" style={{ background: vehicle.is_online ? '#166534' : '#e5e2d0' }}>
            <span className="absolute top-1 w-6 h-6 rounded-full bg-white shadow transition-all" style={{ insetInlineStart: vehicle.is_online ? '28px' : '4px' }} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 mt-2.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: vehicle.is_online ? '#22c55e' : '#94a3b8' }} />
          <span className="font-sans text-[12px] font-semibold" style={{ color: vehicle.is_online ? '#166534' : '#64748b' }}>{vehicle.is_online ? t('vp.onlineLabel') : t('vp.offlineLabel')}</span>
        </div>
        {!vehicle.is_online && <p className="font-sans text-[11.5px] text-amber-700 mt-1">{t('vp.offlineHint')}</p>}

        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mt-3 mb-1.5">{t('vp.cityPresenceLabel')}</p>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5">
          {cities.map((c) => {
            const active = presence?.city_id === c.id
            return (
              <button key={c.id} onClick={() => pickCity(c.id)} disabled={saving} className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer disabled:opacity-50"
                style={{ background: active ? '#166534' : '#fff', color: active ? '#fff' : '#64748b', border: `1px solid ${active ? '#166534' : '#e5e2d0'}` }}>
                {active && <MapPin size={11} className="inline me-1 -mt-0.5" />}
                {isUrdu && c.name_ur ? c.name_ur : c.name}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white border border-[#e5e2d0] rounded-xl p-2.5 text-center">
          <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#64748b]">{t('mv.todayLabel')}</p>
          <p className="font-bold text-[15px] text-[#1e293b] mt-0.5 ltr-num">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-[#e5e2d0] rounded-xl p-2.5 text-center">
          <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#64748b]">{t('mv.jobsSuffix')}</p>
          <p className="font-bold text-[15px] text-[#1e293b] mt-0.5 ltr-num">{summary?.today_jobs_count ?? 0}</p>
        </div>
        <div className="bg-white border border-[#e5e2d0] rounded-xl p-2.5 text-center">
          <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] text-[#64748b]">{t('vp.ratingLabel')}</p>
          <p className="font-bold text-[15px] text-[#1e293b] mt-0.5">{summary?.avg_rating != null ? `⭐ ${summary.avg_rating}` : '—'}</p>
        </div>
      </div>

      <Link href="/portal/my-vehicle/earnings" className="flex items-center gap-2.5 bg-white border border-[#e5e2d0] rounded-2xl p-3">
        <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center shrink-0"><Wallet size={16} className="text-[#166534]" /></span>
        <span className="flex-1 min-w-0">
          <span className="block font-sans text-[12.5px] font-bold text-[#1e293b]">{t('vp.walletSummaryLabel')}</span>
          <span className="block font-sans text-[11px] text-[#64748b] ltr-num">
            {summary?.commission_mode === 'monthly_lumpsum'
              ? `${t('mv.lumpsumModeLabel')} · ${fmt(summary?.lumpsum_fee_pkr ?? 0)}`
              : `${t('mv.perOrderModeLabel')} · ${summary?.commission_pct ?? 0}%`}
          </span>
        </span>
        <ChevronRight size={16} className={`text-[#94a3b8] shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
      </Link>

      {jobsBadge > 0 && (
        <Link href="/portal/my-vehicle/jobs" onClick={() => refreshBadge()} className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-2xl p-3">
          <AlertCircle size={18} className="text-amber-700 shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block font-sans text-[13px] font-bold text-amber-900">{t('vp.newJobsBannerTitle').replace('{n}', String(jobsBadge))}</span>
            <span className="block font-sans text-[11.5px] text-amber-700">{t('vp.newJobsBannerBody')}</span>
          </span>
          <ChevronRight size={16} className={`text-amber-700 shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      )}

      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mt-1">{t('vp.moreServicesHeading')}</p>
      <div className="grid grid-cols-2 gap-2.5">
        <Link href="/portal/my-vehicle/adda" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Bus size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.adda')}</span>
        </Link>
        <Link href="/portal/my-vehicle/routes" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><RouteIcon size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.routes')}</span>
        </Link>
        <Link href="/portal/my-vehicle/trips" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Users2 size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.trips')}</span>
        </Link>
        <Link href="/portal/my-vehicle/weekend" className="flex flex-col gap-2 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><CalendarClock size={16} className="text-[#166534]" /></span>
          <span className="font-sans text-[12.5px] font-bold text-[#1e293b]">{t('mv.tab.weekend')}</span>
        </Link>
      </div>
    </div>
  )
}
