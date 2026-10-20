'use client'

// Real bug/ask, 2026-10-20: the rider's "Bookings" list sent hourly/
// equipment/ride rows to a generic, unscoped browse page instead of
// showing *that* booking — not just unlike a real app, a genuine defect
// (tapping your own booking should show your booking). This pops up
// that one booking's own status/actions instead, reusing the exact
// RPCs/fields each vertical's own "mine" tab already uses — no new
// backend. trip/shadi/cityPurchase rows keep navigating to their real
// (and genuinely rich) detail pages; this sheet is only for the 3 kinds
// that had nowhere real to go before.

import { useEffect, useState } from 'react'
import { Loader2, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { CallButton } from '@/components/portal/CallButton'
import { ChatButton } from '@/components/portal/ChatButton'

export type QuickViewKind = 'hourly' | 'equipment' | 'ride'
interface Props { kind: QuickViewKind; rawId: string; onClose: () => void; onChanged: () => void }

interface HourlyDetail {
  id: string; status: string; pickup_address: string; decline_reason: string | null
  total_amount_pkr: number | null; base_amount_pkr: number; pin: string | null
  vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null
}
interface EquipmentDetail {
  id: string; kind: string; status: string; site_address: string; decline_reason: string | null
  total_amount_pkr: number | null; rate_pkr: number; pin: string | null
  vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; model: string | null
}
interface RideDetail {
  id: string; status: string; total_amount_pkr: number; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function BookingQuickViewSheet({ kind, rawId, onClose, onChanged }: Props) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [hourly, setHourly] = useState<HourlyDetail | null>(null)
  const [equipment, setEquipment] = useState<EquipmentDetail | null>(null)
  const [ride, setRide] = useState<RideDetail | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    (async () => {
      if (kind === 'hourly') {
        const { data } = await supabase.rpc('my_hourly_bookings')
        setHourly(((data ?? []) as HourlyDetail[]).find((b) => b.id === rawId) ?? null)
      } else if (kind === 'equipment') {
        const { data } = await supabase.rpc('my_equipment_bookings')
        setEquipment(((data ?? []) as EquipmentDetail[]).find((b) => b.id === rawId) ?? null)
      } else {
        const { data } = await supabase.from('ride_bookings').select('id, status, total_amount_pkr, rejected_reason, vehicle_routes(origin, origin_ur, destination, destination_ur)').eq('id', rawId).maybeSingle()
        setRide(data as unknown as RideDetail | null)
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, rawId])

  const cancel = async () => {
    setBusy(true)
    const rpc = kind === 'hourly' ? 'cancel_hourly_booking' : kind === 'equipment' ? 'cancel_equipment_booking' : 'cancel_ride_booking'
    const params = kind === 'ride' ? { p_booking_id: rawId, p_reason: null } : { p_booking_id: rawId }
    const { error } = await supabase.rpc(rpc, params)
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    onChanged()
    onClose()
  }

  const title = kind === 'hourly' ? t('vp.hourlyPageTitle') : kind === 'equipment' ? t(`vp.${equipment?.kind ?? 'machinery'}PageTitle`) : t('af.addaBoardPageTitle')

  return (
    <MobilityBottomSheet title={title} onClose={onClose}>
      {loading ? (
        <div className="py-8 text-center"><Loader2 size={20} className="animate-spin text-[#166534] mx-auto" /></div>
      ) : kind === 'hourly' && hourly ? (
        <div className="flex flex-col gap-3">
          <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">{vehicleDisplayName(hourly.vehicle_type, hourly.model)} — {hourly.owner_name}</p>
          <p className="font-sans text-[12.5px] text-[#64748b]">{hourly.pickup_address}</p>
          {hourly.pin && hourly.status === 'accepted' && (
            <div className="bg-[#F9F9F6] rounded-xl p-3 flex items-center justify-between">
              <span className="font-sans text-[11.5px] text-[#64748b]">{t('vp.yourPinLabel')}</span>
              <span className="font-extrabold text-[20px] tracking-[0.3em] text-[#005A36] ltr-num">{hourly.pin}</span>
            </div>
          )}
          <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">₨{fmt(hourly.total_amount_pkr ?? hourly.base_amount_pkr)}</p>
          {hourly.decline_reason && <p className="font-sans text-[12px] text-[#b91c1c]">{hourly.decline_reason}</p>}
          {(hourly.status === 'accepted' || hourly.status === 'in_progress') && (
            <div className="flex items-center gap-3">
              <CallButton phone={hourly.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534]" />
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
          <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">{vehicleDisplayName(equipment.vehicle_type, equipment.model)} — {equipment.owner_name}</p>
          <p className="font-sans text-[12.5px] text-[#64748b]">{equipment.site_address}</p>
          {equipment.pin && equipment.status === 'accepted' && (
            <div className="bg-[#F9F9F6] rounded-xl p-3 flex items-center justify-between">
              <span className="font-sans text-[11.5px] text-[#64748b]">{t('vp.yourPinLabel')}</span>
              <span className="font-extrabold text-[20px] tracking-[0.3em] text-[#005A36] ltr-num">{equipment.pin}</span>
            </div>
          )}
          <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">₨{fmt(equipment.total_amount_pkr ?? equipment.rate_pkr)}</p>
          {equipment.decline_reason && <p className="font-sans text-[12px] text-[#b91c1c]">{equipment.decline_reason}</p>}
          {(equipment.status === 'accepted' || equipment.status === 'in_progress') && (
            <div className="flex items-center gap-3">
              <CallButton phone={equipment.owner_mobile} className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534]" />
              <ChatButton refType="equipment_booking" refId={equipment.id} basePath="/portal/marketplace/negotiations" className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer" />
            </div>
          )}
          {(equipment.status === 'requested' || equipment.status === 'accepted') && (
            <button onClick={cancel} disabled={busy} className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] text-[#b91c1c] font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} {t('vp.cancelBookingBtn')}
            </button>
          )}
        </div>
      ) : kind === 'ride' && ride ? (
        <div className="flex flex-col gap-3">
          {ride.vehicle_routes && (
            <p className="font-sans text-[13.5px] font-bold text-[#1e293b]">
              {isUrdu && ride.vehicle_routes.origin_ur ? ride.vehicle_routes.origin_ur : ride.vehicle_routes.origin} → {isUrdu && ride.vehicle_routes.destination_ur ? ride.vehicle_routes.destination_ur : ride.vehicle_routes.destination}
            </p>
          )}
          <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num">₨{fmt(ride.total_amount_pkr)}</p>
          {ride.rejected_reason && <p className="font-sans text-[12px] text-[#b91c1c]">{ride.rejected_reason}</p>}
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
