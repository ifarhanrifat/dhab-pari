'use client'

// Delivery Settings — its own screen, matching the design zip. City
// presence moved to the shared layout header (it now shows on every
// screen, matching the zip's own header placement), so this page keeps
// just the delivery-specific toggles: delivers on/off, per-km rate
// (committee-set, read-only here), night booking, out-of-city, and a
// read-only display of the committee-assigned service classes.

import { useEffect, useState } from 'react'
import { Package, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Vehicle { id: string; delivers: boolean; per_km_pkr: number | null; night_booking_enabled: boolean; allows_out_of_city: boolean }
interface ServiceClass { id: string; name: string; name_ur: string | null; delivery_eligible: boolean; ride_eligible: boolean }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleDeliveryPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [vpSaving, setVpSaving] = useState(false)
  const [serviceClasses, setServiceClasses] = useState<ServiceClass[]>([])
  const [myServiceOfferIds, setMyServiceOfferIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, delivers, per_km_pkr, night_booking_enabled, allows_out_of_city').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) {
        const [{ data: sc }, { data: offers }] = await Promise.all([
          supabase.from('service_classes').select('id, name, name_ur, delivery_eligible, ride_eligible').eq('is_active', true).order('display_order'),
          supabase.from('vehicle_service_offers').select('service_class_id').eq('vehicle_id', data.id).eq('is_active', true),
        ])
        setServiceClasses(sc ?? [])
        setMyServiceOfferIds(new Set((offers ?? []).map((o) => o.service_class_id)))
      }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const myClasses = serviceClasses.filter((sc) => myServiceOfferIds.has(sc.id))
  const deliveryEligible = myClasses.length === 0 || myClasses.some((sc) => sc.delivery_eligible)

  const toggleDelivers = async () => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = await supabase.rpc('set_vehicle_delivery_prefs', { p_vehicle_id: vehicle.id, p_delivers: !vehicle.delivers, p_per_km_pkr: null })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, delivers: !vehicle.delivers })
  }
  const toggleNightBooking = async () => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = await supabase.rpc('set_vehicle_capability_prefs', { p_vehicle_id: vehicle.id, p_night_booking_enabled: !vehicle.night_booking_enabled, p_allows_out_of_city: vehicle.allows_out_of_city })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, night_booking_enabled: !vehicle.night_booking_enabled })
  }
  const toggleOutOfCity = async () => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = await supabase.rpc('set_vehicle_capability_prefs', { p_vehicle_id: vehicle.id, p_night_booking_enabled: vehicle.night_booking_enabled, p_allows_out_of_city: !vehicle.allows_out_of_city })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, allows_out_of_city: !vehicle.allows_out_of_city })
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicle) return null

  return (
    <div>
      <div className="mb-8">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Package size={13} /> {t('vp.deliverySettingsHeading')}</p>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          {!deliveryEligible ? (
            <p className="font-sans text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5">{t('vp.deliveryNotAllowedMessage')}</p>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('vp.deliversToggleLabel')}</p>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('vp.deliversToggleHint')}</p>
              </div>
              <button onClick={toggleDelivers} disabled={vpSaving} className={`shrink-0 relative w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${vehicle.delivers ? 'bg-dp-secondary' : 'bg-dp-surface-container-high'}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${vehicle.delivers ? (isUrdu ? '-translate-x-5 right-0.5' : 'translate-x-5 left-0.5') : 'left-0.5'}`} />
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-1.5 mt-3 pt-3 border-t border-dp-outline-variant/60">
            <span className="font-sans text-[12.5px] text-dp-on-surface-variant shrink-0">{t('vp.perKmRateLabel')}</span>
            <span className="font-sans text-[13px] font-bold text-dp-on-surface ltr-num">{vehicle.per_km_pkr != null ? fmt(vehicle.per_km_pkr) : t('vp.perKmRateNotSetYet')}</span>
          </div>
          <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('vp.perKmRateCommitteeNote')}</p>

          <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-dp-outline-variant/60">
            <div>
              <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('vp.nightBookingToggleLabel')}</p>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('vp.nightBookingToggleHint')}</p>
            </div>
            <button onClick={toggleNightBooking} disabled={vpSaving} className={`shrink-0 relative w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${vehicle.night_booking_enabled ? 'bg-dp-secondary' : 'bg-dp-surface-container-high'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${vehicle.night_booking_enabled ? (isUrdu ? '-translate-x-5 right-0.5' : 'translate-x-5 left-0.5') : 'left-0.5'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-dp-outline-variant/60">
            <div>
              <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('vp.outOfCityToggleLabel')}</p>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('vp.outOfCityToggleHint')}</p>
            </div>
            <button onClick={toggleOutOfCity} disabled={vpSaving} className={`shrink-0 relative w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${vehicle.allows_out_of_city ? 'bg-dp-secondary' : 'bg-dp-surface-container-high'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${vehicle.allows_out_of_city ? (isUrdu ? '-translate-x-5 right-0.5' : 'translate-x-5 left-0.5') : 'left-0.5'}`} />
            </button>
          </div>
        </div>
      </div>

      {myServiceOfferIds.size > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Truck size={13} /> {t('vp.serviceOffersHeading')}</p>
          <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
            <div className="flex flex-wrap gap-1.5">
              {myClasses.map((sc) => (
                <span key={sc.id} className="px-2.5 py-1.5 rounded-full text-[12px] font-sans font-semibold bg-dp-secondary text-white">
                  {isUrdu && sc.name_ur ? sc.name_ur : sc.name}
                </span>
              ))}
            </div>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-2">{t('vp.serviceOffersCommitteeNote')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
