'use client'


// The driver/owner side of the machinery/tractor/loader accept/decline/
// start/complete/settle lifecycle (646/648) — one combined screen for
// all 3 verticals (not 3 tabs) since most vehicles only ever offer one
// or two of them. Modeled directly on my-vehicle/hourly/page.tsx's own
// lifecycle screen, with no GPS tracking: these are stationary/on-site
// jobs (dig a foundation, plough a field, haul a load), not a moving
// trip, so the only thing "in progress" shows is elapsed time, not a
// live map.
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Jobs tab's equipment rows rather than its own nav tab.
//
// 2026-10-30: the booking lifecycle (accept → PIN start → complete →
// settle) now happens in each booking's own popup (BookingLifecycleSheet);
// this page is the grouped list plus the rate-offer negotiation, which
// is a separate pre-booking flow and stays here as it was.

import { useEffect, useState } from 'react'
import { Wrench, X, Check, Loader2, Banknote } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { FarePolicyCard } from '@/components/mobility/FarePolicyCard'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { LifecycleBookingsList } from '@/components/mobility/LifecycleBookingsList'

interface Vehicle { id: string; owner_name: string; commission_mode: string; offers_machinery: boolean; offers_tractor: boolean; offers_loader: boolean }
interface RateOffer { id: string; proposed_rate_pkr: number; counter_rate_pkr: number | null; status: string; rider_full_name: string; rider_mobile: string | null }
interface Booking {
  id: string; kind: string; site_address: string; requested_hours: number | null; status: string; status_confirmed: boolean
  rate_pkr: number; total_amount_pkr: number | null; started_at: string | null; customer_name: string
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyEquipmentBookingsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const equipmentKinds = (['machinery', 'tractor', 'loader'] as const).filter((k) => vehicle?.[`offers_${k}`])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [rateOffers, setRateOffers] = useState<RateOffer[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [counteringId, setCounteringId] = useState<string | null>(null)
  const [counterAmount, setCounterAmount] = useState('')
  // 852: machinery/tractor/loader sit on the same `vehicles` table buses
  // do, so a fleet owner (844) managing several machines under one
  // account hits the exact same "which one am I viewing" need the route
  // page's fleet picker already solves — same picker, same pattern,
  // reused here rather than invented fresh. Deliberately handles having
  // NO vehicle of one's own too (a pure fleet manager who personally
  // owns nothing), not just the common case.
  const [fleetVehicles, setFleetVehicles] = useState<{ id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }[]>([])
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)
  const [ownVehicleId, setOwnVehicleId] = useState<string | null>(null)

  const vehicleFields = 'id, owner_name, commission_mode, offers_machinery, offers_tractor, offers_loader'
  const loadBookings = (vehicleId: string) =>
    supabase.rpc('vehicle_equipment_bookings', { p_vehicle_id: vehicleId }).then(({ data }) => setBookings((data ?? []) as Booking[]))
  const loadRateOffers = (vehicleId: string) =>
    supabase.rpc('my_machinery_rate_offers', { p_vehicle_id: vehicleId }).then(({ data }) => setRateOffers((data ?? []) as RateOffer[]))

  const selectVehicle = async (id: string) => {
    setSelectedVehicleId(id)
    setLoading(true)
    const { data } = await supabase.from('vehicles').select(vehicleFields).eq('id', id).single()
    setVehicle(data)
    if (data) await Promise.all([loadBookings(data.id), loadRateOffers(data.id)])
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    Promise.all([
      supabase.from('vehicles').select(vehicleFields).eq('portal_user_id', user.id).maybeSingle(),
      supabase.rpc('my_fleet_vehicles'),
    ]).then(async ([{ data: own }, { data: fleet }]) => {
      setFleetVehicles((fleet ?? []) as typeof fleetVehicles)
      setOwnVehicleId(own?.id ?? null)
      const initialId = own?.id ?? (fleet ?? [])[0]?.id ?? null
      setSelectedVehicleId(initialId)
      if (own) {
        setVehicle(own)
        await Promise.all([loadBookings(own.id), loadRateOffers(own.id)])
      } else if (initialId) {
        const { data: v } = await supabase.from('vehicles').select(vehicleFields).eq('id', initialId).single()
        setVehicle(v)
        if (v) await Promise.all([loadBookings(v.id), loadRateOffers(v.id)])
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const respondToOffer = async (offerId: string, action: 'accept' | 'reject' | 'counter', counterRate?: number) => {
    if (!vehicle) return
    setBusyId(offerId)
    const { error } = await supabase.rpc('respond_machinery_rate_offer', { p_offer_id: offerId, p_action: action, p_counter_rate_pkr: counterRate ?? null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setCounteringId(null); setCounterAmount('')
    loadRateOffers(vehicle.id)
  }

  // Elapsed time on the active job for its list row — a minute tick is
  // plenty there; the popup shows the same figure while it's open.
  const activeJob = bookings.find((b) => b.status === 'in_progress') ?? null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!activeJob) return
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [activeJob])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('cm.noVehicleLinked')}</div>

  const label = (b: Booking) => b.requested_hours != null ? `${b.requested_hours}${t('vp.hoursShort')} · ${fmt(b.rate_pkr)}/${t('vp.hoursShort')}` : fmt(b.rate_pkr)

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Wrench size={19} /> {t('vp.myEquipmentBookingsHeading')}</h1>
        <p className="text-[12.5px] text-[#64748b] mt-0.5">{t('vp.myEquipmentBookingsSubtitle')}</p>
      </div>
      {fleetVehicles.length > 0 && (
        <div>
          <label className="block font-sans text-[11px] font-bold text-[#64748b] mb-1 uppercase tracking-[0.05em]">{t('mv.fleetViewSwitcherLabel')}</label>
          <div className="flex gap-1.5 flex-wrap">
            {[...(ownVehicleId ? [{ id: ownVehicleId, owner_name: t('mv.fleetMyOwnVehicleLabel'), vehicle_type: '', vehicle_number: null }] : []), ...fleetVehicles].map((v) => (
              <button key={v.id} type="button" onClick={() => selectVehicle(v.id)}
                className="px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer border"
                style={{ background: selectedVehicleId === v.id ? '#166534' : '#F9F9F6', color: selectedVehicleId === v.id ? '#fff' : '#334155', borderColor: selectedVehicleId === v.id ? '#166534' : '#e5e2d0' }}>
                {v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}
      {equipmentKinds.map((k) => <FarePolicyCard key={k} service={k} audience="driver" defaultOpen={false} />)}

      {rateOffers.length > 0 && (
        <Section title={t('vp.rateOffersHeading')}>
          {rateOffers.map((o) => (
            <div key={o.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[14px] font-semibold text-[#1e293b]">{o.rider_full_name}</p>
                  {o.rider_mobile && <a href={`tel:${o.rider_mobile}`} className="font-sans text-[11.5px] text-[#166534] font-semibold ltr-num underline">{o.rider_mobile}</a>}
                </div>
                <span className="flex items-center gap-1 font-sans text-[14px] font-extrabold text-[#166534] ltr-num"><Banknote size={13} /> {fmt(o.proposed_rate_pkr)}/{t('vp.hoursShort')}</span>
              </div>
              {counteringId === o.id ? (
                <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                  <input type="number" value={counterAmount} onChange={(e) => setCounterAmount(e.target.value)} placeholder={t('vp.counterRatePlaceholder')}
                    className="w-full border border-[#e5e2d0] rounded-xl p-2 font-sans text-[12.5px] mb-2" />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setCounteringId(null)} className="flex-1 py-2 border border-[#e5e2d0] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
                    <button onClick={() => respondToOffer(o.id, 'counter', Number(counterAmount))} disabled={busyId === o.id || !counterAmount}
                      className="flex-1 py-2 rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer text-white disabled:opacity-50 bg-[#166534]">{t('vp.counterRateBtn')}</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
                  <button onClick={() => respondToOffer(o.id, 'reject')} disabled={busyId === o.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-[#e5e2d0] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    <X size={13} /> {t('vp.declineBtn')}
                  </button>
                  {o.status === 'pending' && (
                    <>
                      <button onClick={() => { setCounteringId(o.id); setCounterAmount('') }} disabled={busyId === o.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-[#166534] text-[#166534] rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                        {t('vp.counterRateBtn')}
                      </button>
                      <button onClick={() => respondToOffer(o.id, 'accept')} disabled={busyId === o.id} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-[#166534] text-white rounded-xl font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                        {busyId === o.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t('vp.acceptBtn')}
                      </button>
                    </>
                  )}
                  {o.status === 'countered' && (
                    <span className="flex-1 flex items-center justify-center text-[11.5px] font-semibold text-amber-700 ltr-num">{t('vp.ownerCounteredLabel').replace('{price}', fmt(o.counter_rate_pkr ?? 0))}</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      <LifecycleBookingsList
        kind="equipment" vehicleId={vehicle.id} commissionMode={vehicle.commission_mode}
        emptyText={t('vp.noEquipmentBookingsYetHint')}
        onChanged={() => loadBookings(vehicle.id)}
        items={bookings.map((b) => ({
          id: b.id, status: b.status, status_confirmed: b.status_confirmed, customer_name: b.customer_name,
          subtitle: b.site_address, amount: b.total_amount_pkr ?? b.rate_pkr, meta: label(b),
          live: b.started_at ? `${((now - new Date(b.started_at).getTime()) / 3600000).toFixed(1)}${t('vp.hoursShort')}` : undefined,
        }))}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2">{title}</p>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}
