'use client'

// Driver self-service: bookings + wallet + earnings for whichever vehicle
// is linked to this portal account (vehicles.portal_user_id, staff-set —
// see migration 394). Route/schedule creation stays staff-managed
// (unlike a shop's own catalog, that wasn't part of this ask) — this page
// is what a per_order driver actually needs day to day: their wallet
// balance, a top-up button, and marking a booking fulfilled themselves
// (no payment to verify — the rider already paid them directly).

import { useEffect, useState } from 'react'
import { Bus, Wallet, TrendingUp, Clock, CheckCircle2, XCircle, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { WalletTopupModal } from '@/components/portal/WalletTopupModal'

interface Vehicle { id: string; owner_name: string; vehicle_type: string; commission_mode: string }
interface Summary {
  balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null
  today_earnings_pkr: number; month_earnings_pkr: number; pending_bookings_count: number
  last_settlement_date: string | null; last_settlement_amount: number | null
}
interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehiclePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [actionId, setActionId] = useState<string | null>(null)
  const [showTopup, setShowTopup] = useState(false)

  const reload = async (vehicleId: string) => {
    const [{ data: s }, { data: b }] = await Promise.all([
      supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: vehicleId }),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
        .eq('vehicle_routes.vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(20),
    ])
    setSummary(s as unknown as Summary)
    setBookings((b ?? []) as unknown as Booking[])
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, vehicle_type, commission_mode').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) await reload(data.id)
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const fulfillBooking = async (id: string) => {
    setActionId(id)
    const { error } = await supabase.rpc('confirm_ride_booking', { p_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.bookingConfirmedToast'))
    if (vehicle) reload(vehicle.id)
  }
  const cancelBooking = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('reject_ride_booking', { p_booking_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.bookingRejectedToast'))
    if (vehicle) reload(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!vehicle) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('cm.noVehicleLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h1 className="font-heading text-[26px] font-bold leading-[34px] text-dp-primary flex items-center gap-2"><Bus size={22} /> {vehicle.owner_name}</h1>
        {vehicle.commission_mode === 'per_order' && (
          <button onClick={() => setShowTopup(true)} className="flex items-center gap-1.5 px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
            <Wallet size={14} /> {t('cm.topupWalletBtn')}
          </button>
        )}
      </div>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{vehicle.vehicle_type}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><Wallet size={12} /> {t('cm.balanceLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-primary mt-1">{fmt(summary?.balance_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><TrendingUp size={12} /> {t('cm.todayEarningsLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-secondary mt-1">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant">{t('cm.monthEarningsLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-secondary mt-1">{fmt(summary?.month_earnings_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><Clock size={12} /> {t('cm.pendingOrdersTag')}</p>
          <p className="font-heading text-[19px] font-bold text-amber-700 mt-1">{summary?.pending_bookings_count ?? 0}</p>
        </div>
      </div>

      {summary?.commission_mode === 'monthly_lumpsum' && (
        <div className="bg-violet-50 border border-violet-200 rounded-lg p-3.5 mb-6">
          <p className="font-sans text-[13px] text-violet-900">{t('cm.onLumpsumNote')} <span className="font-bold ltr-num">{fmt(summary.lumpsum_fee_pkr ?? 0)}</span></p>
        </div>
      )}

      {summary?.last_settlement_date && (
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-6">{t('cm.lastSettlementLabel')} <span className="font-semibold text-dp-on-surface">{fmt(summary.last_settlement_amount ?? 0)}</span> — {new Date(summary.last_settlement_date).toLocaleDateString('en-GB')}</p>
      )}

      <div>
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.bookingsHeading')}</p>
        {bookings.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('cm.noBookingsYet')}</p>}
        <div className="space-y-2">
          {bookings.map((b) => (
            <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate flex items-center gap-1">
                    <MapPin size={12} className="shrink-0 text-dp-secondary" />
                    {b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—'}
                  </p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(b.travel_date).toLocaleDateString('en-GB')} · {b.seats} {t('mk.seatsLabel')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(b.total_amount_pkr)}</p>
                  {b.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>}
                  {b.status === 'rejected' && <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold" title={b.rejected_reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>}
                  {b.status === 'announced' && summary?.commission_mode !== 'per_order' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>}
                </div>
              </div>
              {b.status === 'announced' && summary?.commission_mode === 'per_order' && (
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  <span className="font-sans text-[11px] text-dp-on-surface-variant">{t('cm.markFulfilledHint')}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => cancelBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                    <button onClick={() => fulfillBooking(b.id)} disabled={actionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.markFulfilledBtn')}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {showTopup && (
        <WalletTopupModal kind="vehicle" sellerId={vehicle.id} onClose={() => setShowTopup(false)} onSubmitted={() => { setShowTopup(false); reload(vehicle.id) }} />
      )}
    </div>
  )
}
