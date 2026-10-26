'use client'

// Real bug/ask, 2026-10-20: the rider's "Bookings" list sent hourly/
// equipment/ride rows to a generic, unscoped browse page instead of
// showing *that* booking — not just unlike a real app, a genuine defect
// (tapping your own booking should show your booking). This pops up
// that one booking's own status/actions instead, reusing the exact
// RPCs/fields each vertical's own "mine" tab already uses — no new
// backend. trip/shadi/cityPurchase rows keep navigating to their real
// (and genuinely rich) detail pages; this sheet is only for the 4 kinds
// that had nowhere real to go before.
//
// Real gap found 2026-10-21: this used to fetch its one row once on
// mount and never again — opening it right after sending a request and
// then just sitting there gave no sign at all when the driver actually
// responded, the opposite of a real app's live "waiting for driver"
// screen. Now driven by useBookingLiveStatus (Realtime UPDATE on this
// exact row + a poll fallback), so a status flip from 'requested' to
// 'accepted'/'declined' shows up here on its own, no re-open needed.
// Each booking table already has a direct-select RLS policy for its
// own parties (hourly_bookings_parties_read etc.) — no new backend.

import { useState } from 'react'
import { Loader2, Ban, Radio, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useBookingLiveStatus } from '@/hooks/useBookingLiveStatus'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { CallButton } from '@/components/portal/CallButton'
import { ChatButton } from '@/components/portal/ChatButton'

export type QuickViewKind = 'hourly' | 'equipment' | 'ride' | 'rental'
interface Props { kind: QuickViewKind; rawId: string; onClose: () => void; onChanged: () => void }

interface HourlyDetail {
  id: string; status: string; pickup_address: string; decline_reason: string | null
  total_amount_pkr: number | null; base_amount_pkr: number; pin: string | null
  vehicle_id: string; vehicles: { owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null }
}
interface RentalDetail {
  id: string; status: string; from_address: string; to_address: string; decline_reason: string | null
  total_amount_pkr: number | null; base_amount_pkr: number; pin: string | null
  vehicle_id: string; vehicles: { owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null }
}
interface EquipmentDetail {
  id: string; kind: string; status: string; site_address: string; decline_reason: string | null
  total_amount_pkr: number | null; rate_pkr: number; pin: string | null
  vehicle_id: string; vehicles: { owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null }
}
type RideVehicle = { owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null; vehicle_number: string | null }
interface RideDetail {
  id: string; status: string; total_amount_pkr: number; rejected_reason: string | null; seats: number; travel_date: string
  // Adda-based bookings (checked in at an adda, no posted route) have
  // route_id NULL — adda_queue_entry_id is set instead. Real gap found
  // live, 2026-10-26: this sheet's query only ever joined through
  // vehicle_routes, so an adda booking's vehicle/driver info silently
  // came back null — same blind spot already fixed on the driver-side
  // jobs list for the same reason. Both join paths are fetched; the
  // render picks whichever one actually resolved.
  vehicle_routes: {
    origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; departure_time: string | null
    vehicles: RideVehicle | null
  } | null
  adda_queue_entries: { vehicles: RideVehicle | null; addas: { name: string; name_ur: string | null } | null } | null
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

// hourly/equipment/rental all share the same real 4-stage lifecycle
// (requested → accepted → in_progress → completed), confirmed against
// equipment_bookings' own status CHECK constraint — unlike ride_bookings
// (only 2 real stages), this one genuinely supports the reference
// design's 4-step progress bar with no fabrication.
const PROGRESS_STEP: Record<string, number> = { requested: 0, accepted: 1, in_progress: 2, completed: 3 }
function ProgressSteps({ status }: { status: string }) {
  if (status === 'declined' || status === 'cancelled') return null
  const step = PROGRESS_STEP[status] ?? 0
  return (
    <div dir="ltr" className="flex items-center gap-1">
      {[0, 1, 2, 3].map((i) => <span key={i} className="flex-1 h-1 rounded-full" style={{ background: i <= step ? '#16a34a' : '#e5e2d0' }} />)}
    </div>
  )
}

// Real ask, 2026-10-21: "the rider once sent the request... the same
// request popup kept displaying" — this sheet already live-updates,
// but while status is still 'requested' it showed nothing distinguishing
// "waiting for a driver" from any other state, unlike a real app's
// explicit "searching" screen. One shared banner for all 3 kinds here.
function StatusBanner({ t, status, declineReason }: { t: (k: string, f?: string) => string; status: string; declineReason: string | null }) {
  if (status === 'requested') {
    return (
      <p className="flex items-center gap-2 font-sans text-[13px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
        <Radio size={14} className="animate-pulse shrink-0" /> {t('vp.waitingForDriverLabel')}
      </p>
    )
  }
  if (status === 'declined') {
    return (
      <p className="flex items-center gap-2 font-sans text-[13px] font-bold text-[#b91c1c] bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
        <XCircle size={14} className="shrink-0" /> {declineReason || t('vp.requestDeclinedLabel')}
      </p>
    )
  }
  return null
}

const HOURLY_SELECT = 'id, status, pickup_address, decline_reason, total_amount_pkr, base_amount_pkr, pin, vehicle_id, vehicles(owner_name, owner_mobile, vehicle_type, model)'
const RENTAL_SELECT = 'id, status, from_address, to_address, decline_reason, total_amount_pkr, base_amount_pkr, pin, vehicle_id, vehicles(owner_name, owner_mobile, vehicle_type, model)'
const EQUIPMENT_SELECT = 'id, kind, status, site_address, decline_reason, total_amount_pkr, rate_pkr, pin, vehicle_id, vehicles(owner_name, owner_mobile, vehicle_type, model)'
const RIDE_SELECT = 'id, status, total_amount_pkr, rejected_reason, seats, travel_date, vehicle_routes(origin, origin_ur, destination, destination_ur, departure_time, vehicles(owner_name, owner_mobile, vehicle_type, model, vehicle_number)), adda_queue_entries(vehicles(owner_name, owner_mobile, vehicle_type, model, vehicle_number), addas(name, name_ur))'

export function BookingQuickViewSheet({ kind, rawId, onClose, onChanged }: Props) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [busy, setBusy] = useState(false)

  // All four always called (hooks can't be conditional) — only the one
  // matching `kind` gets a real id, the other three stay idle (id=null).
  const { row: hourly, loading: hourlyLoading } = useBookingLiveStatus<HourlyDetail>('hourly_bookings', kind === 'hourly' ? rawId : null, HOURLY_SELECT)
  const { row: rental, loading: rentalLoading } = useBookingLiveStatus<RentalDetail>('rental_bookings', kind === 'rental' ? rawId : null, RENTAL_SELECT)
  const { row: equipment, loading: equipmentLoading } = useBookingLiveStatus<EquipmentDetail>('equipment_bookings', kind === 'equipment' ? rawId : null, EQUIPMENT_SELECT)
  const { row: ride, loading: rideLoading } = useBookingLiveStatus<RideDetail>('ride_bookings', kind === 'ride' ? rawId : null, RIDE_SELECT)
  const loading = kind === 'hourly' ? hourlyLoading : kind === 'rental' ? rentalLoading : kind === 'equipment' ? equipmentLoading : rideLoading

  const cancel = async () => {
    setBusy(true)
    const rpc = kind === 'hourly' ? 'cancel_hourly_booking' : kind === 'equipment' ? 'cancel_equipment_booking' : kind === 'rental' ? 'cancel_rental_booking' : 'cancel_ride_booking'
    const params = kind === 'ride' ? { p_booking_id: rawId, p_reason: null } : { p_booking_id: rawId }
    const { error } = await supabase.rpc(rpc, params)
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    onChanged()
    onClose()
  }

  const title = kind === 'hourly' ? t('vp.hourlyPageTitle') : kind === 'equipment' ? t(`vp.${equipment?.kind ?? 'machinery'}PageTitle`) : kind === 'rental' ? t('vp.rentalPageTitle') : t('af.addaBoardPageTitle')

  return (
    <MobilityBottomSheet title={title} onClose={onClose}>
      {loading ? (
        <div className="py-8 text-center"><Loader2 size={20} className="animate-spin text-[#166534] mx-auto" /></div>
      ) : kind === 'hourly' && hourly ? (
        <div className="flex flex-col gap-3">
          <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">{vehicleDisplayName(hourly.vehicles.vehicle_type, hourly.vehicles.model)} — {hourly.vehicles.owner_name}</p>
          <p className="font-sans text-[12.5px] text-[#64748b]">{hourly.pickup_address}</p>
          <ProgressSteps status={hourly.status} />
          <StatusBanner t={t} status={hourly.status} declineReason={hourly.decline_reason} />
          {hourly.pin && hourly.status === 'accepted' && (
            <div className="bg-[#F9F9F6] rounded-xl p-3 flex items-center justify-between">
              <span className="font-sans text-[11.5px] text-[#64748b]">{t('vp.yourPinLabel')}</span>
              <span className="font-extrabold text-[20px] tracking-[0.3em] text-[#005A36] ltr-num">{hourly.pin}</span>
            </div>
          )}
          <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">₨{fmt(hourly.total_amount_pkr ?? hourly.base_amount_pkr)}</p>
          {(hourly.status === 'accepted' || hourly.status === 'in_progress') && (
            <div className="flex items-center gap-3">
              <CallButton phone={hourly.vehicles.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534]" />
              <ChatButton refType="hourly_booking" refId={hourly.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer" />
            </div>
          )}
          {(hourly.status === 'requested' || hourly.status === 'accepted') && (
            <button onClick={cancel} disabled={busy} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] text-[#b91c1c] font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} {t('vp.cancelBookingBtn')}
            </button>
          )}
        </div>
      ) : kind === 'equipment' && equipment ? (
        <div className="flex flex-col gap-3">
          <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">{vehicleDisplayName(equipment.vehicles.vehicle_type, equipment.vehicles.model)} — {equipment.vehicles.owner_name}</p>
          <p className="font-sans text-[12.5px] text-[#64748b]">{equipment.site_address}</p>
          <ProgressSteps status={equipment.status} />
          <StatusBanner t={t} status={equipment.status} declineReason={equipment.decline_reason} />
          {equipment.pin && equipment.status === 'accepted' && (
            <div className="bg-[#F9F9F6] rounded-xl p-3 flex items-center justify-between">
              <span className="font-sans text-[11.5px] text-[#64748b]">{t('vp.yourPinLabel')}</span>
              <span className="font-extrabold text-[20px] tracking-[0.3em] text-[#005A36] ltr-num">{equipment.pin}</span>
            </div>
          )}
          <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">₨{fmt(equipment.total_amount_pkr ?? equipment.rate_pkr)}</p>
          {(equipment.status === 'accepted' || equipment.status === 'in_progress') && (
            <div className="flex items-center gap-3">
              <CallButton phone={equipment.vehicles.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534]" />
              <ChatButton refType="equipment_booking" refId={equipment.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer" />
            </div>
          )}
          {(equipment.status === 'requested' || equipment.status === 'accepted') && (
            <button onClick={cancel} disabled={busy} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] text-[#b91c1c] font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} {t('vp.cancelBookingBtn')}
            </button>
          )}
        </div>
      ) : kind === 'rental' && rental ? (
        <div className="flex flex-col gap-3">
          <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">{vehicleDisplayName(rental.vehicles.vehicle_type, rental.vehicles.model)} — {rental.vehicles.owner_name}</p>
          <p className="font-sans text-[12.5px] text-[#64748b]">{rental.from_address} → {rental.to_address}</p>
          <ProgressSteps status={rental.status} />
          <StatusBanner t={t} status={rental.status} declineReason={rental.decline_reason} />
          {rental.pin && rental.status === 'accepted' && (
            <div className="bg-[#F9F9F6] rounded-xl p-3 flex items-center justify-between">
              <span className="font-sans text-[11.5px] text-[#64748b]">{t('vp.yourPinLabel')}</span>
              <span className="font-extrabold text-[20px] tracking-[0.3em] text-[#005A36] ltr-num">{rental.pin}</span>
            </div>
          )}
          <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">₨{fmt(rental.total_amount_pkr ?? rental.base_amount_pkr)}</p>
          {(rental.status === 'accepted' || rental.status === 'in_progress') && (
            <div className="flex items-center gap-3">
              <CallButton phone={rental.vehicles.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534]" />
              <ChatButton refType="rental_booking" refId={rental.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer" />
            </div>
          )}
          {(rental.status === 'requested' || rental.status === 'accepted') && (
            <button onClick={cancel} disabled={busy} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] text-[#b91c1c] font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} {t('vp.cancelBookingBtn')}
            </button>
          )}
        </div>
      ) : kind === 'ride' && ride ? (
        <div className="flex flex-col gap-3">
          {(() => {
            const vehicle = ride.vehicle_routes?.vehicles ?? ride.adda_queue_entries?.vehicles ?? null
            const adda = ride.adda_queue_entries?.addas
            const routeLabel = ride.vehicle_routes
              ? `${isUrdu && ride.vehicle_routes.origin_ur ? ride.vehicle_routes.origin_ur : ride.vehicle_routes.origin} → ${isUrdu && ride.vehicle_routes.destination_ur ? ride.vehicle_routes.destination_ur : ride.vehicle_routes.destination}`
              : adda ? `${t('mb.svc.adda')} · ${isUrdu && adda.name_ur ? adda.name_ur : adda.name}` : null
            return (
              <>
                {vehicle && (
                  <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">
                    {vehicleDisplayName(vehicle.vehicle_type, vehicle.model)} — {vehicle.owner_name}
                  </p>
                )}
                {routeLabel && <p className="font-sans text-[12.5px] text-[#64748b]">{routeLabel}</p>}
                <StatusBanner t={t} status={ride.status === 'announced' ? 'requested' : ride.status === 'rejected' ? 'declined' : ride.status} declineReason={ride.rejected_reason} />
                <div className="flex items-center justify-between gap-2 bg-[#F9F9F6] rounded-xl p-3">
                  <span className="font-sans text-[12px] text-[#64748b]">{t('mb.travelDateLabel')}</span>
                  <span className="font-sans text-[12.5px] font-semibold text-[#1e293b] ltr-num">
                    {new Date(ride.travel_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}{ride.vehicle_routes?.departure_time ? ` · ${ride.vehicle_routes.departure_time.slice(0, 5)}` : ''} · {ride.seats} {t('vp.seatsLabel')}
                  </span>
                </div>
                <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">₨{fmt(ride.total_amount_pkr)}</p>
                {ride.status === 'confirmed' && vehicle && (
                  <CallButton phone={vehicle.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534]" />
                )}
              </>
            )
          })()}
          {(ride.status === 'announced' || ride.status === 'confirmed') && (
            <button onClick={cancel} disabled={busy} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] text-[#b91c1c] font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} {t('vp.cancelBookingBtn')}
            </button>
          )}
        </div>
      ) : (
        <p className="text-center py-6 text-[#94a3b8] text-[13.5px]">{t('p.couldNotLoad')}</p>
      )}
    </MobilityBottomSheet>
  )
}
