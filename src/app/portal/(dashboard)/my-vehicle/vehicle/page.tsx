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
import { Truck, Phone, Lock, ChevronRight, Package, CalendarClock, ShoppingBag } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Vehicle {
  id: string; owner_name: string; owner_mobile: string; owner_whatsapp: string | null
  vehicle_type: string; vehicle_number: string; total_seats: number | null; color: string | null; model: string | null
  commission_mode: string; created_at: string; delivers: boolean
  offers_hourly: boolean; offers_shadi: boolean; offers_rental: boolean; offers_machinery: boolean; offers_tractor: boolean; offers_loader: boolean
}

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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, owner_mobile, owner_whatsapp, vehicle_type, vehicle_number, total_seats, color, model, commission_mode, created_at, delivers, offers_hourly, offers_shadi, offers_rental, offers_machinery, offers_tractor, offers_loader')
      .eq('portal_user_id', user.id).maybeSingle().then(({ data }) => { setVehicle(data); setLoading(false) })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return null

  const activeServices = SERVICE_KEYS.filter((s) => vehicle[s.flag])
  const hasEquipment = vehicle.offers_machinery || vehicle.offers_tractor || vehicle.offers_loader

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] text-[#005A36]">{t('mb.navVehicle')}</h1>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <span className="shrink-0 w-14 h-14 rounded-2xl bg-[#F9F9F6] flex items-center justify-center"><Truck size={26} className="text-[#166534]" /></span>
          <div className="min-w-0">
            <p className="font-sans text-[16px] font-bold text-[#1e293b] truncate">{vehicle.model || vehicle.vehicle_type}</p>
            <p className="font-sans text-[12.5px] text-[#64748b]">{vehicle.vehicle_number}{vehicle.color ? ` · ${vehicle.color}` : ''}</p>
          </div>
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
      </div>
    </div>
  )
}
