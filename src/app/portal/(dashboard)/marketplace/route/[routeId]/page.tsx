'use client'

// Marketplace phase 4 — route detail + seat booking. Availability is
// always fetched live from route_seats_available() for whatever date is
// picked (same "computed, not stored" approach as training_batches'
// spots_left) — the seat stepper's max just follows whatever that RPC
// says, so this never shows a stale number.

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Minus, Plus, MapPin, Bus } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_per_seat_pkr: number; departure_time: string | null; days_of_week: number[]
  origin_lat: number | null; origin_lng: number | null; destination_lat: number | null; destination_lng: number | null
}
interface Vehicle { id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; total_seats: number; commission_mode: string }

const DAY_KEYS = ['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat']

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export default function RouteDetailPage() {
  const { t, isUrdu } = useLocale()
  const params = useParams<{ routeId: string }>()
  const router = useRouter()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [route, setRoute] = useState<Route | null>(null)
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [travelDate, setTravelDate] = useState('')
  const [available, setAvailable] = useState<number | null>(null)
  const [checkingAvailability, setCheckingAvailability] = useState(false)
  const [seats, setSeats] = useState(1)
  const [method, setMethod] = useState('cash')
  const [proofPath, setProofPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [bookable, setBookable] = useState(true)

  useEffect(() => {
    supabase.from('vehicle_routes').select('*').eq('id', params.routeId).single().then(async ({ data: r }) => {
      setRoute(r)
      if (r) {
        const [{ data: v }, { data: bk }] = await Promise.all([
          supabase.from('vehicles').select('id, owner_name, owner_mobile, vehicle_type, total_seats, commission_mode').eq('id', r.vehicle_id).single(),
          supabase.rpc('vehicle_bookable', { p_vehicle_id: r.vehicle_id }),
        ])
        setVehicle(v)
        setBookable(bk !== false)
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.routeId])

  const wrongDay = route && travelDate ? !route.days_of_week.includes(new Date(travelDate + 'T00:00:00').getDay()) : false

  useEffect(() => {
    if (!travelDate || !route || wrongDay) { setAvailable(null); return }
    setCheckingAvailability(true)
    supabase.rpc('route_seats_available', { p_route_id: route.id, p_travel_date: travelDate }).then(({ data }) => {
      setAvailable(data as number)
      setSeats((s) => Math.min(s, Math.max(1, data as number)))
      setCheckingAvailability(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [travelDate, route?.id, wrongDay])

  const total = route ? seats * route.fare_per_seat_pkr : 0
  const isPerOrder = vehicle?.commission_mode === 'per_order'

  const submit = async () => {
    if (!route) return
    if (!travelDate) { toast.error(t('mp.pickDateFirst')); return }
    if (!isPerOrder && !proofPath) { toast.error(t('g.uploadPaymentScreenshot')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('place_ride_booking', {
      p_route_id: route.id, p_travel_date: travelDate, p_seats: seats, p_method: isPerOrder ? 'direct' : method, p_proof_url: isPerOrder ? null : proofPath,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(isPerOrder ? t('cm.orderPlacedDirectToast') : t('mp.bookingPlacedToast'))
    router.push('/portal/marketplace')
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>
  if (!route) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('mp.routeNotFound')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <button onClick={() => router.push('/portal/marketplace')} className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[13.5px] font-semibold hover:underline cursor-pointer mb-4">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}
      </button>

      <h1 className="font-heading text-[22px] font-bold text-dp-primary flex items-center gap-2">
        <MapPin size={19} className="text-dp-secondary shrink-0" /> {isUrdu && route.origin_ur ? route.origin_ur : route.origin} → {isUrdu && route.destination_ur ? route.destination_ur : route.destination}
      </h1>
      {vehicle && <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><Bus size={13} /> {vehicle.owner_name} · {vehicle.vehicle_type}</p>}
      <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">
        {route.departure_time ? route.departure_time.slice(0, 5) : t('mk.noFixedTime')}
        {' · '}
        {route.days_of_week.length === 7 ? t('mk.everyDay') : route.days_of_week.map((d) => t(DAY_KEYS[d])).join('، ')}
      </p>
      <p className="font-heading text-[22px] font-bold text-dp-secondary mt-2">{fmt(route.fare_per_seat_pkr)} <span className="font-sans font-normal text-dp-on-surface-variant text-[13px]">{t('mk.perSeat')}</span></p>

      {route.origin_lat != null && route.origin_lng != null && route.destination_lat != null && route.destination_lng != null && (
        <div className="mt-4">
          <LeafletMap
            pins={[
              { lat: route.origin_lat, lng: route.origin_lng, label: isUrdu && route.origin_ur ? route.origin_ur : route.origin, color: '#16a34a' },
              { lat: route.destination_lat, lng: route.destination_lng, label: isUrdu && route.destination_ur ? route.destination_ur : route.destination, color: '#dc2626' },
            ]}
          />
        </div>
      )}

      {!bookable && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 mt-4">
          <p className="font-sans text-[13px] text-amber-900">{t('cm.notBookableExplain')}</p>
          {vehicle?.owner_mobile && <p className="font-sans text-[13px] font-semibold text-amber-900 mt-1 ltr-num">{vehicle.owner_mobile}</p>}
        </div>
      )}

      {bookable && (
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mt-5">
        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('mp.travelDateLabel')}</label>
        <input type="date" min={todayStr()} value={travelDate} onChange={(e) => setTravelDate(e.target.value)} className="input-field" />
        {wrongDay && <p className="font-sans text-[12px] text-dp-error mt-1.5">{t('mp.wrongDayError')}</p>}
        {!wrongDay && travelDate && (
          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">
            {checkingAvailability ? t('action.loading') : available !== null ? `${available} ${t('mp.seatsAvailableSuffix')}` : ''}
          </p>
        )}

        {!wrongDay && travelDate && available !== null && available > 0 && (
          <>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 mt-4">{t('mk.seatsLabel')}</label>
            <div className="flex items-center gap-3">
              <button onClick={() => setSeats((s) => Math.max(1, s - 1))} className="w-8 h-8 rounded-full bg-dp-surface-container-high flex items-center justify-center cursor-pointer"><Minus size={14} /></button>
              <span className="font-sans text-[15px] font-bold ltr-num w-8 text-center">{seats}</span>
              <button onClick={() => setSeats((s) => Math.min(available, s + 1))} className="w-8 h-8 rounded-full bg-dp-secondary text-white flex items-center justify-center cursor-pointer"><Plus size={14} /></button>
            </div>

            <div className="flex items-center justify-between pt-3 mt-3 border-t border-dp-outline-variant">
              <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('mp.cartTotal')}</p>
              <p className="font-heading text-[19px] font-bold text-dp-secondary">{fmt(total)}</p>
            </div>

            {isPerOrder ? (
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-secondary-container/40 rounded-lg px-3 py-2.5 mt-4">{t('cm.payDirectlyNote')}</p>
            ) : (
              <>
                <div className="mt-4">
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
                  <select value={method} onChange={(e) => setMethod(e.target.value)} className="input-field">
                    <option value="cash">{t('w.cash')}</option>
                    <option value="jazzcash">{t('w.jazzcash')}</option>
                    <option value="easypaisa">{t('w.easypaisa')}</option>
                    <option value="bank">{t('a.bank')}</option>
                  </select>
                </div>
                <div className="mt-3">
                  <DonationReceiptUpload onUpload={setProofPath} />
                </div>
              </>
            )}
            <button onClick={submit} disabled={submitting} className="w-full mt-4 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
              {submitting ? t('mp.placingBooking') : t('mp.bookSeatsBtn')}
            </button>
          </>
        )}
        {!wrongDay && travelDate && available === 0 && (
          <p className="font-sans text-[13px] text-dp-error mt-3">{t('mp.fullyBookedError')}</p>
        )}
      </div>
      )}
    </div>
  )
}
