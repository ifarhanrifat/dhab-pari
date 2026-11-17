'use client'

// 2026-11-17: the Driver Operations screen — not a reskin of
// /my-vehicle/*, a genuinely separate, much simpler page for a fleet's
// employee-driver. Confirmed live: a fleet driver's entire experience
// used to be the same owner-oriented catalog/route-editor pages a
// solo owner-operator uses, with real admin actions (create/edit/close
// a route, edit the vehicle's catalog, upload its documents) now
// correctly blocked server-side (893/895) — so a driver landing on
// those old pages would just see broken buttons. This page is where
// they actually belong: today's route, who's onboard, the next stop,
// a simple walk-up-passenger form, and today's cash — all backed by
// RPCs that already existed (route_departure_chalan, 891;
// record_manual_booking, 883; fleet_vehicle_cash_positions, 864) and
// stay allowed for a driver (893 only blocked the configuration RPCs,
// not these operational ones).

import { useEffect, useState } from 'react'
import { Bus, Users, MapPin, Wallet, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetFormGrid, FleetFormField } from '@/components/portal/FleetPanel'

interface MyVehicle { id: string; vehicle_number: string | null; vehicle_type: string | null; fleet_id: string | null }
interface MyRoute { id: string; origin: string; destination: string; departure_time: string | null }
interface ChalanPassenger { id: string; passenger_name: string; seats: number; amount: number; is_confirmed: boolean }
interface Chalan {
  onboard_now: ChalanPassenger[]; next_stops: { label: string; passengers: ChalanPassenger[] }[]
  total_confirmed_count: number; cash_collected_pkr: number
}
interface CashPosition { vehicle_id: string; cash_in_hand_pkr: number }

function today() { return new Date().toISOString().slice(0, 10) }

export default function DriveOperationsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [vehicle, setVehicle] = useState<MyVehicle | null>(null)
  const [routes, setRoutes] = useState<MyRoute[]>([])
  const [chalanByRoute, setChalanByRoute] = useState<Record<string, Chalan>>({})
  const [cashInHand, setCashInHand] = useState<number | null>(null)

  const [walkupRouteId, setWalkupRouteId] = useState('')
  const [walkupName, setWalkupName] = useState('')
  const [walkupSeats, setWalkupSeats] = useState('1')
  const [walkupAmount, setWalkupAmount] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const { data: v } = await supabase.from('vehicles').select('id, vehicle_number, vehicle_type, fleet_id').eq('portal_user_id', user!.id).maybeSingle()
    const myVehicle = v as MyVehicle | null
    setVehicle(myVehicle)
    if (myVehicle) {
      const { data: r } = await supabase.from('vehicle_routes').select('id, origin, destination, departure_time').eq('vehicle_id', myVehicle.id).eq('is_active', true)
      const myRoutes = (r ?? []) as MyRoute[]
      setRoutes(myRoutes)
      if (myRoutes.length > 0 && !walkupRouteId) setWalkupRouteId(myRoutes[0].id)

      const chalans: Record<string, Chalan> = {}
      for (const route of myRoutes) {
        const { data: c } = await supabase.rpc('route_departure_chalan', { p_route_id: route.id, p_travel_date: today() })
        if (c) chalans[route.id] = c as Chalan
      }
      setChalanByRoute(chalans)

      if (myVehicle.fleet_id) {
        const { data: cp } = await supabase.rpc('fleet_vehicle_cash_positions', { p_fleet_id: myVehicle.fleet_id })
        const mine = ((cp ?? []) as CashPosition[]).find((p) => p.vehicle_id === myVehicle.id)
        setCashInHand(mine?.cash_in_hand_pkr ?? 0)
      }
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const recordWalkup = async () => {
    if (!walkupRouteId || !walkupName.trim() || !walkupAmount) { toast.error(t('mv.walkupFieldsRequiredError')); return }
    setSaving(true)
    const { error } = await supabase.rpc('record_manual_booking', {
      p_route_id: walkupRouteId, p_travel_date: today(), p_seats: Number(walkupSeats) || 1,
      p_passenger_name: walkupName, p_total_amount_pkr: Number(walkupAmount), p_payment_method: 'cash',
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.walkupRecordedToast'))
    setWalkupName(''); setWalkupSeats('1'); setWalkupAmount('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noVehicleAssignedHint')}</p>

  const totalOnboard = Object.values(chalanByRoute).reduce((sum, c) => sum + (c.onboard_now?.length ?? 0), 0)

  return (
    <div className="flex flex-col gap-3 p-3">
      <h1 className="font-bold text-[20px] text-dp-primary flex items-center gap-2">
        <Bus size={19} /> <span className="ltr-num">{vehicle.vehicle_number || vehicle.vehicle_type}</span>
      </h1>

      <div className="grid grid-cols-2 gap-2">
        <FleetStat label={t('mv.onboardNowLabel')} icon={<Users size={12} />} value={totalOnboard} />
        <FleetStat label={t('mv.cashInHandLabel')} icon={<Wallet size={12} />} value={cashInHand !== null ? `₨${cashInHand.toLocaleString()}` : '—'} />
      </div>

      {routes.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noActiveRouteHint')}</p>
      ) : (
        routes.map((route) => {
          const chalan = chalanByRoute[route.id]
          return (
            <FleetPanel key={route.id}>
              <FleetPanelHead icon={<MapPin size={14} />} title={`${route.origin} → ${route.destination}`}
                description={route.departure_time ? route.departure_time.slice(0, 5) : undefined} />
              <FleetPanelBody>
                {chalan && chalan.next_stops?.length > 0 && (
                  <p className="font-sans text-[12px] text-[#166534] font-semibold mb-2">{t('mv.nextStopLabel')}: {chalan.next_stops[0].label}</p>
                )}
                {chalan && chalan.onboard_now?.length > 0 ? (
                  <div className="flex flex-col divide-y divide-[#f1f5f9]">
                    {chalan.onboard_now.map((p) => (
                      <div key={p.id} className="py-1.5 flex items-center justify-between gap-2">
                        <span className="font-sans text-[12px] text-[#1e293b]">{p.passenger_name} · {p.seats} {t('mv.seatsSuffix')}</span>
                        <span className="font-sans text-[11px] text-[#64748b] ltr-num">₨{p.amount.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="font-sans text-[11.5px] text-[#94a3b8]">{t('mv.noOneOnboardHint')}</p>
                )}
              </FleetPanelBody>
            </FleetPanel>
          )
        })
      )}

      {routes.length > 0 && (
        <FleetPanel>
          <FleetPanelHead icon={<Plus size={14} />} title={t('mv.addWalkupPassengerHeading')} />
          <FleetPanelBody>
            <FleetFormGrid>
              {routes.length > 1 && (
                <FleetFormField label={t('mv.routeContextLabel')} full>
                  <select value={walkupRouteId} onChange={(e) => setWalkupRouteId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                    {routes.map((r) => <option key={r.id} value={r.id}>{r.origin} → {r.destination}</option>)}
                  </select>
                </FleetFormField>
              )}
              <FleetFormField label={t('mv.passengerNameLabel')} full>
                <input value={walkupName} onChange={(e) => setWalkupName(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </FleetFormField>
              <FleetFormField label={t('mv.seatsSuffix')}>
                <input type="number" min={1} value={walkupSeats} onChange={(e) => setWalkupSeats(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </FleetFormField>
              <FleetFormField label={t('mv.cashCollectedLabel')}>
                <input type="number" value={walkupAmount} onChange={(e) => setWalkupAmount(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </FleetFormField>
              <FleetFormField label="" full>
                <button onClick={recordWalkup} disabled={saving} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
                  {saving ? t('action.saving') : t('mv.recordWalkupBtn')}
                </button>
              </FleetFormField>
            </FleetFormGrid>
          </FleetPanelBody>
        </FleetPanel>
      )}
    </div>
  )
}
