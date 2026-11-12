'use client'

// 860: Fare-readjustment requests — genuinely new. Fare has only ever
// been settable once, at route creation (create_vehicle_route_self,
// 672); there was no edit path at all before this. Modeled on my-vehicle/
// ilan/page.tsx's own "submit, then watch the status" pattern, which
// itself mirrors commercial_ilans/677's "owner proposes, committee
// approves" shape.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicle { id: string }
interface Route { id: string; origin: string; destination: string; fare_per_seat_pkr: number }
interface FareRequest {
  id: string; route_id: string; origin: string; destination: string
  current_fare_per_seat_pkr: number; requested_fare_per_seat_pkr: number
  reason: string | null; status: string; rejection_reason: string | null; created_at: string
}

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  pending_approval: { bg: '#FFFBEB', fg: '#b45309' },
  approved: { bg: '#F0FDF4', fg: '#166534' },
  rejected: { bg: '#FEF2F2', fg: '#b91c1c' },
}

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function FleetFareRequestsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [routes, setRoutes] = useState<Route[]>([])
  const [requests, setRequests] = useState<FareRequest[]>([])
  const [routeId, setRouteId] = useState('')
  const [newFare, setNewFare] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    const { data: fleet } = await supabase.rpc('my_fleet_vehicles')
    const vehicleIds = ((fleet ?? []) as FleetVehicle[]).map((v) => v.id)
    const [{ data: r }, { data: reqs }] = await Promise.all([
      vehicleIds.length > 0
        ? supabase.from('vehicle_routes').select('id, origin, destination, fare_per_seat_pkr').in('vehicle_id', vehicleIds).eq('is_active', true)
        : Promise.resolve({ data: [] }),
      supabase.rpc('my_fare_change_requests'),
    ])
    setRoutes((r ?? []) as Route[])
    setRequests((reqs ?? []) as FareRequest[])
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const selectedRoute = routes.find((r) => r.id === routeId)

  const submitRequest = async () => {
    if (!routeId || !newFare) { toast.error(t('mv.fareRequestFillError')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('request_route_fare_change', {
      p_route_id: routeId, p_requested_fare_per_seat_pkr: Number(newFare), p_reason: reason || null,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.fareRequestSubmittedToast'))
    setRouteId(''); setNewFare(''); setReason('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><Receipt size={17} /> {t('mv.fareRequestsHeading')}</h1>
      </div>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.fareRequestHint')}</p>
        <select value={routeId} onChange={(e) => setRouteId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2">
          <option value="">{t('mv.selectRoutePlaceholder')}</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.origin} → {r.destination} (₨{fmt(r.fare_per_seat_pkr)})</option>)}
        </select>
        {routeId && (
          <>
            <input type="number" value={newFare} onChange={(e) => setNewFare(e.target.value)}
              placeholder={selectedRoute ? `${t('mv.currentFareLabel')} ₨${fmt(selectedRoute.fare_per_seat_pkr)}` : ''}
              className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2 ltr-num" />
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('mv.fareRequestReasonPlaceholder')}
              className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5" />
            <button onClick={submitRequest} disabled={submitting} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {submitting ? t('action.loading') : t('mv.submitFareRequestBtn')}
            </button>
          </>
        )}
      </div>

      <div>
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('mv.myFareRequestsHeading')}</p>
        {requests.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noFareRequestsYetHint')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {requests.map((r) => {
              const style = STATUS_STYLE[r.status] ?? STATUS_STYLE.pending_approval
              return (
                <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-lg px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{r.origin} → {r.destination}</span>
                    <span className="px-2 py-0.5 rounded-full font-sans text-[10px] font-bold" style={{ background: style.bg, color: style.fg }}>{t(`mv.fareStatus_${r.status}`)}</span>
                  </div>
                  <p className="font-sans text-[11px] text-[#64748b] mt-1 ltr-num">₨{fmt(r.current_fare_per_seat_pkr)} → ₨{fmt(r.requested_fare_per_seat_pkr)}</p>
                  {r.rejection_reason && <p className="font-sans text-[11px] text-[#b91c1c] mt-0.5">{r.rejection_reason}</p>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
