'use client'

// Driver Vehicle — the design file's own `driver:vehicle` screen: a
// vehicle hero, capacity/registration date, the approved-services tags,
// a lock note ("services are approved at registration, visit the office
// to change them" — true here too, admin-only), and contact details.
// Below that, links out to this app's own real per-vehicle settings the
// file has no equivalent for (delivery preferences, weekend share
// offers, shop catalog sourcing prefs) — each stays its own page.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Truck, Phone, Lock, ChevronRight, Package, CalendarClock, ShoppingBag, CheckCircle2, Route as RouteIcon, Megaphone } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Vehicle {
  id: string; owner_name: string; owner_mobile: string; owner_whatsapp: string | null
  vehicle_type: string; vehicle_number: string; total_seats: number | null; color: string | null; model: string | null
  commission_mode: string; created_at: string; delivers: boolean
  offers_hourly: boolean; offers_shadi: boolean; offers_rental: boolean; offers_machinery: boolean; offers_tractor: boolean; offers_loader: boolean
  hourly_rate_pkr: number | null; shadi_full_day_rate_pkr: number | null
  machinery_hourly_rate_pkr: number | null; machinery_mobilization_fee_pkr: number | null
  machinery_hourly_rate_min_pkr: number | null; machinery_hourly_rate_max_pkr: number | null
  loader_trip_rate_pkr: number | null; rental_base_pkr: number | null; rental_per_km_pkr: number | null
}
interface RegRequest { owner_id_card_url: string | null; license_url: string | null; vehicle_doc_url: string | null; driver_photo_url: string | null }
interface TractorService { service_key: string; name_en: string; name_ur: string; rate_pkr: number; unit: string }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

const SERVICE_KEYS: { flag: keyof Vehicle; label: string }[] = [
  { flag: 'offers_hourly', label: 'mv.tab.hourly' },
  { flag: 'offers_rental', label: 'vp.rentalPageTitle' },
  { flag: 'offers_shadi', label: 'mv.tab.shadi' },
  { flag: 'delivers', label: 'mv.tab.delivery' },
]

export default function MyVehicleVehiclePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [regRequest, setRegRequest] = useState<RegRequest | null>(null)
  const [tractorServices, setTractorServices] = useState<TractorService[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, owner_mobile, owner_whatsapp, vehicle_type, vehicle_number, total_seats, color, model, commission_mode, created_at, delivers, offers_hourly, offers_shadi, offers_rental, offers_machinery, offers_tractor, offers_loader, hourly_rate_pkr, shadi_full_day_rate_pkr, machinery_hourly_rate_pkr, machinery_mobilization_fee_pkr, machinery_hourly_rate_min_pkr, machinery_hourly_rate_max_pkr, loader_trip_rate_pkr, rental_base_pkr, rental_per_km_pkr')
      .eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
        setVehicle(data)
        if (data) {
          const [{ data: reg }, { data: tractor }] = await Promise.all([
            supabase.from('vehicle_registration_requests').select('owner_id_card_url, license_url, vehicle_doc_url, driver_photo_url')
              .eq('portal_user_id', user.id).eq('status', 'approved').order('created_at', { ascending: false }).limit(1).maybeSingle(),
            data.offers_tractor
              ? supabase.from('tractor_services').select('service_key, name_en, name_ur, rate_pkr, unit').eq('vehicle_id', data.id)
              : Promise.resolve({ data: [] }),
          ])
          setRegRequest(reg ?? null)
          setTractorServices((tractor ?? []) as TractorService[])
        }
        setLoading(false)
      })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const [savingMachineryRate, setSavingMachineryRate] = useState(false)
  const adjustMachineryRate = async (delta: number) => {
    if (!vehicle?.machinery_hourly_rate_min_pkr || !vehicle.machinery_hourly_rate_max_pkr) return
    const current = vehicle.machinery_hourly_rate_pkr ?? vehicle.machinery_hourly_rate_min_pkr
    const next = Math.min(vehicle.machinery_hourly_rate_max_pkr, Math.max(vehicle.machinery_hourly_rate_min_pkr, current + delta))
    if (next === current) return
    setSavingMachineryRate(true)
    const { error } = await supabase.rpc('set_own_machinery_rate', { p_vehicle_id: vehicle.id, p_rate_pkr: next })
    setSavingMachineryRate(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle((v) => v ? { ...v, machinery_hourly_rate_pkr: next } : v)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return null

  const activeServices = SERVICE_KEYS.filter((s) => vehicle[s.flag])
  const hasEquipment = vehicle.offers_machinery || vehicle.offers_tractor || vehicle.offers_loader

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] text-[#005A36]">{t('mb.navVehicle')}</h1>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden">
        <div className="relative h-[150px]" style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
          {regRequest?.driver_photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={regRequest.driver_photo_url} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center"><Truck size={44} className="text-white/85" /></div>
          )}
        </div>
        <div className="p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="min-w-0">
            <p className="font-sans text-[16px] font-bold text-[#1e293b] truncate">{vehicleDisplayName(vehicle.vehicle_type, vehicle.model)}</p>
            <p className="font-sans text-[12.5px] text-[#64748b]">{vehicle.color ?? ''}</p>
          </div>
          <span dir="ltr" className="shrink-0 font-sans text-[12px] font-bold px-2 py-0.5 border-2 border-[#005A36] rounded-[5px] text-[#005A36]">{vehicle.vehicle_number}</span>
        </div>
        <dl className="grid grid-cols-2 gap-y-1.5 text-[13px] font-sans">
          <dt className="text-[#64748b]">{t('vp.seatsLabel')}</dt><dd className="text-end font-semibold text-[#1e293b]">{vehicle.total_seats ?? '—'}</dd>
          <dt className="text-[#64748b]">{t('vp.registeredOnLabel')}</dt><dd className="text-end font-semibold text-[#1e293b]">{new Date(vehicle.created_at).toLocaleDateString('en-GB')}</dd>
        </dl>

        {(activeServices.length > 0 || hasEquipment) && (
          <>
            <h3 className="font-sans text-[12px] font-bold text-[#64748b] uppercase tracking-[0.05em] mt-4 mb-2">{t('vp.approvedServicesHeading')}</h3>
            <div className="flex flex-wrap gap-1.5">
              {activeServices.map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#166534]/10 text-[#166534] text-[12px] font-semibold">{t(s.label)}</span>
              ))}
              {hasEquipment && <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#166534]/10 text-[#166534] text-[12px] font-semibold">{t('mv.tab.equipment')}</span>}
            </div>
          </>
        )}

        <div className="flex items-start gap-2 bg-[#F9F9F6] rounded-xl p-3 mt-4">
          <Lock size={14} className="text-[#64748b] shrink-0 mt-0.5" />
          <p className="font-sans text-[12px] text-[#64748b] leading-[1.6]">{t('vp.servicesLockNote')}</p>
        </div>
        </div>
      </div>

      {regRequest && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <h3 className="font-sans text-[13px] font-bold text-[#1e293b] mb-2">{t('vp.documentsHeading')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {([
              ['owner_id_card_url', 'vp.docCnic'], ['license_url', 'vp.docLicense'],
              ['vehicle_doc_url', 'vp.docRegistration'], ['driver_photo_url', 'vp.docPhoto'],
            ] as const).map(([field, label]) => {
              const onFile = !!regRequest[field]
              return (
                <span key={field} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] font-semibold ${onFile ? 'bg-[#166534]/10 text-[#166534]' : 'bg-amber-50 text-amber-800'}`}>
                  {onFile ? <CheckCircle2 size={11} /> : null} {t(label)}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {(vehicle.offers_hourly || vehicle.offers_shadi || vehicle.offers_machinery || vehicle.offers_tractor || vehicle.offers_loader || vehicle.offers_rental) && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#f1f5f9]"><h3 className="font-sans text-[13px] font-bold text-[#005A36]">🏷️ {t('vp.ratesHeading')}</h3></div>
          <div className="divide-y divide-[#f8fafc]">
            {vehicle.offers_hourly && vehicle.hourly_rate_pkr != null && (
              <div className="flex items-center gap-2 px-4 py-2.5"><span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.hourly')}</span><span dir="ltr" className="font-sans text-[12.5px] font-extrabold text-[#166534] ltr-num">{fmt(vehicle.hourly_rate_pkr)}{t('vp.perHourSuffix')}</span></div>
            )}
            {vehicle.offers_shadi && vehicle.shadi_full_day_rate_pkr != null && (
              <div className="flex items-center gap-2 px-4 py-2.5"><span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.shadi')}</span><span dir="ltr" className="font-sans text-[12.5px] font-extrabold text-[#166534] ltr-num">{fmt(vehicle.shadi_full_day_rate_pkr)}{t('vp.perFullDaySuffix')}</span></div>
            )}
            {vehicle.offers_machinery && vehicle.machinery_hourly_rate_min_pkr != null && vehicle.machinery_hourly_rate_max_pkr != null ? (
              <div className="flex items-center gap-2 px-4 py-2.5">
                <span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.equipment')}</span>
                <div dir="ltr" className="flex items-center border border-[#e5e2d0] rounded-[9px] overflow-hidden">
                  <button onClick={() => adjustMachineryRate(-100)} disabled={savingMachineryRate} className="w-7 h-7 border-0 bg-[#F9F9F6] text-[#166534] font-extrabold cursor-pointer disabled:opacity-50">−</button>
                  <span className="min-w-[74px] text-center font-sans font-extrabold text-[12px] ltr-num">{fmt(vehicle.machinery_hourly_rate_pkr ?? vehicle.machinery_hourly_rate_min_pkr)}</span>
                  <button onClick={() => adjustMachineryRate(100)} disabled={savingMachineryRate} className="w-7 h-7 border-0 bg-[#F9F9F6] text-[#166534] font-extrabold cursor-pointer disabled:opacity-50">+</button>
                </div>
              </div>
            ) : vehicle.offers_machinery && vehicle.machinery_hourly_rate_pkr != null && (
              <div className="flex items-center gap-2 px-4 py-2.5"><span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.equipment')}</span><span dir="ltr" className="font-sans text-[12.5px] font-extrabold text-[#166534] ltr-num">{fmt(vehicle.machinery_hourly_rate_pkr)}{t('vp.perHourSuffix')}</span></div>
            )}
            {vehicle.offers_tractor && tractorServices.map((ts) => (
              <div key={ts.service_key} className="flex items-center gap-2 px-4 py-2.5"><span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{isUrdu ? ts.name_ur : ts.name_en}</span><span dir="ltr" className="font-sans text-[12.5px] font-extrabold text-[#166534] ltr-num">{fmt(ts.rate_pkr)}/{ts.unit}</span></div>
            ))}
            {vehicle.offers_loader && vehicle.loader_trip_rate_pkr != null && (
              <div className="flex items-center gap-2 px-4 py-2.5"><span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('vp.loaderPageTitle')}</span><span dir="ltr" className="font-sans text-[12.5px] font-extrabold text-[#166534] ltr-num">{fmt(vehicle.loader_trip_rate_pkr)}{t('vp.perTripSuffix')}</span></div>
            )}
            {vehicle.offers_rental && vehicle.rental_base_pkr != null && (
              <div className="flex items-center gap-2 px-4 py-2.5"><span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('vp.rentalPageTitle')}</span><span dir="ltr" className="font-sans text-[12.5px] font-extrabold text-[#166534] ltr-num">{fmt(vehicle.rental_base_pkr)}{vehicle.rental_per_km_pkr != null ? ` + ${fmt(vehicle.rental_per_km_pkr)}${t('vp.perKmSuffix')}` : ''}</span></div>
            )}
          </div>
          <div className="px-4 py-2.5 bg-[#F9F9F6] font-sans text-[11px] text-[#64748b]">
            {vehicle.offers_machinery && vehicle.machinery_hourly_rate_min_pkr != null && vehicle.machinery_hourly_rate_max_pkr != null
              ? t('vp.ratesLockNoteWithMachineryBand').replace('{min}', fmt(vehicle.machinery_hourly_rate_min_pkr)).replace('{max}', fmt(vehicle.machinery_hourly_rate_max_pkr))
              : t('vp.ratesLockNote')}
          </div>
        </div>
      )}

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <h3 className="font-sans text-[13px] font-bold text-[#1e293b] mb-2">{t('vp.contactDetailsHeading')}</h3>
        <a href={`tel:${vehicle.owner_mobile}`} className="flex items-center gap-2 font-sans text-[13.5px] text-[#166534] font-semibold">
          <Phone size={14} /> <span className="ltr-num">{vehicle.owner_mobile}</span>
        </a>
      </div>

      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mt-1">{t('vp.vehicleSettingsHeading')}</p>
      <div className="flex flex-col gap-2">
        <Link href="/portal/my-vehicle/delivery" className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="shrink-0 w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Package size={16} className="text-[#166534]" /></span>
          <span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.delivery')}</span>
          <ChevronRight size={16} className={`text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/my-vehicle/weekend" className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="shrink-0 w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><CalendarClock size={16} className="text-[#166534]" /></span>
          <span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.weekend')}</span>
          <ChevronRight size={16} className={`text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/my-vehicle/catalog" className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="shrink-0 w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><ShoppingBag size={16} className="text-[#166534]" /></span>
          <span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.catalog')}</span>
          <ChevronRight size={16} className={`text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/my-vehicle/routes" className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="shrink-0 w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><RouteIcon size={16} className="text-[#166534]" /></span>
          <span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.routes')}</span>
          <ChevronRight size={16} className={`text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
        <Link href="/portal/my-vehicle/ilan" className="flex items-center gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
          <span className="shrink-0 w-9 h-9 rounded-full bg-[#F9F9F6] flex items-center justify-center"><Megaphone size={16} className="text-[#166534]" /></span>
          <span className="flex-1 font-sans text-[13px] font-semibold text-[#1e293b]">{t('mv.tab.ilan')}</span>
          <ChevronRight size={16} className={`text-[#94a3b8] ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      </div>
    </div>
  )
}
