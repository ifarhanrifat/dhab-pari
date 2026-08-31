'use client'

// Marketplace phase 2 — admin catalog CRUD for vehicles + their routes.
// A vehicle is staff-listed (a driver/owner asks the committee to be
// listed). Booking/checkout land in phase 3 once place_ride_booking()/
// confirm_ride_booking() exist. Same two-level shape as shops/page.tsx and
// academy-fees/page.tsx: one `selected` piece of state switches between
// the parent grid and the detail panel, everything else is a modal.
//
// A route has no trip/calendar table of its own — it's a recurring
// schedule (which days it runs); how many seats are left on any given
// travel date is computed live from ride_bookings once phase 3 exists,
// the same way training_batches_for_join() already computes spots_left.
// This page only manages the schedule itself, not bookings against it.

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Bus, PlusCircle, X, Pencil, Trash2, MapPin, CheckCircle2, XCircle, Clock, Percent } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSystemAccess } from '@/hooks/useSystemAccess'

const LeafletPinPicker = dynamic(() => import('@/components/shared/LeafletPinPicker'), { ssr: false })

interface Vehicle {
  id: string; owner_name: string; owner_mobile: string | null; owner_whatsapp: string | null
  vehicle_type: string; vehicle_number: string | null; total_seats: number; is_active: boolean
  portal_user_id: string | null; commission_mode: string; lumpsum_fee_pkr: number | null
}
interface Route {
  id: string; vehicle_id: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; fare_per_seat_pkr: number; departure_time: string | null; days_of_week: number[]; is_active: boolean
  origin_lat: number | null; origin_lng: number | null; destination_lat: number | null; destination_lng: number | null
}
interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface LumpsumCharge { id: string; period: string; amount_pkr: number }
interface WalletTopup { id: string; amount_pkr: number; status: string; announced_method: string; announced_at: string; rejected_reason: string | null }
interface TypeRate { id: string; vehicle_type: string; classification: string; commission_pct: number }

const emptyVehicle = {
  owner_name: '', owner_mobile: '', owner_whatsapp: '', vehicle_type: '', vehicle_number: '', total_seats: 4, is_active: true,
  portal_user_id: null as string | null, commission_mode: 'per_order' as string, lumpsum_fee_pkr: 0,
}
const emptyRoute = {
  origin: '', origin_ur: '', destination: '', destination_ur: '', classification: 'intercity',
  fare_per_seat_pkr: 0, departure_time: '', days_of_week: [0, 1, 2, 3, 4, 5, 6] as number[], is_active: true,
  origin_lat: null as number | null, origin_lng: null as number | null, destination_lat: null as number | null, destination_lng: null as number | null,
}

const DAY_KEYS = ['af.daySun', 'af.dayMon', 'af.dayTue', 'af.dayWed', 'af.dayThu', 'af.dayFri', 'af.daySat']

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function AdminVehiclesPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <AdminVehiclesInner />
    </Suspense>
  )
}

function AdminVehiclesInner() {
  const { t, isUrdu } = useLocale()
  const searchParams = useSearchParams()
  const access = useSystemAccess()
  const supabase = createClient()

  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [routeCountByVehicle, setRouteCountByVehicle] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Vehicle | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [bookingActionId, setBookingActionId] = useState<string | null>(null)
  const [charges, setCharges] = useState<LumpsumCharge[]>([])
  const [topups, setTopups] = useState<WalletTopup[]>([])
  const [topupActionId, setTopupActionId] = useState<string | null>(null)
  const [keeperMobile, setKeeperMobile] = useState('')
  const [keeperName, setKeeperName] = useState<string | null>(null)
  const [linkingKeeper, setLinkingKeeper] = useState(false)

  const [showVehicleForm, setShowVehicleForm] = useState(false)
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null)
  const [vehicleForm, setVehicleForm] = useState(emptyVehicle)

  const [rates, setRates] = useState<TypeRate[]>([])
  const [showRates, setShowRates] = useState(false)
  const [newRate, setNewRate] = useState({ vehicle_type: '', classification: 'intercity', commission_pct: 0 })
  const [savingRate, setSavingRate] = useState(false)

  const [showRouteForm, setShowRouteForm] = useState(false)
  const [editingRoute, setEditingRoute] = useState<Route | null>(null)
  const [routeForm, setRouteForm] = useState(emptyRoute)

  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data } = await supabase.from('vehicles').select('*').order('owner_name')
    setVehicles(data ?? [])
    if (data && data.length > 0) {
      const { data: allRoutes } = await supabase.from('vehicle_routes').select('id, vehicle_id').in('vehicle_id', data.map((v) => v.id))
      const counts: Record<string, number> = {}
      for (const r of allRoutes ?? []) counts[r.vehicle_id] = (counts[r.vehicle_id] ?? 0) + 1
      setRouteCountByVehicle(counts)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const loadRates = async () => {
    const { data } = await supabase.from('vehicle_type_commission_rates').select('*').order('vehicle_type')
    setRates(data ?? [])
  }
  useEffect(() => { loadRates() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveRate = async () => {
    if (!newRate.vehicle_type.trim()) return
    setSavingRate(true)
    const { error } = await supabase.from('vehicle_type_commission_rates')
      .upsert({ vehicle_type: newRate.vehicle_type.trim(), classification: newRate.classification, commission_pct: newRate.commission_pct }, { onConflict: 'vehicle_type,classification' })
    setSavingRate(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.rateSaved'))
    setNewRate({ vehicle_type: '', classification: 'intercity', commission_pct: 0 })
    loadRates()
  }
  const deleteRate = async (id: string) => {
    await supabase.from('vehicle_type_commission_rates').delete().eq('id', id)
    loadRates()
  }

  useEffect(() => {
    const vehicleParam = searchParams.get('vehicle')
    if (!vehicleParam || vehicles.length === 0) return
    const v = vehicles.find((x) => x.id === vehicleParam)
    if (v) openVehicle(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles.length, searchParams])

  const loadRoutes = async (vehicleId: string) => {
    const { data } = await supabase.from('vehicle_routes').select('*').eq('vehicle_id', vehicleId).order('origin')
    setRoutes(data ?? [])
  }

  const loadBookings = async (vehicleId: string) => {
    const { data } = await supabase.from('ride_bookings')
      .select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
      .eq('vehicle_routes.vehicle_id', vehicleId).order('created_at', { ascending: false })
    setBookings((data ?? []) as unknown as Booking[])
  }

  const loadCharges = async (vehicleId: string) => {
    const { data } = await supabase.from('vehicle_lumpsum_charges').select('id, period, amount_pkr').eq('vehicle_id', vehicleId).order('period', { ascending: false })
    setCharges(data ?? [])
  }
  const loadTopups = async (vehicleId: string) => {
    const { data } = await supabase.from('vehicle_wallet_topups').select('id, amount_pkr, status, announced_method, announced_at, rejected_reason').eq('vehicle_id', vehicleId).order('announced_at', { ascending: false })
    setTopups(data ?? [])
  }

  const openVehicle = (v: Vehicle) => { setSelected(v); loadRoutes(v.id); loadBookings(v.id); loadCharges(v.id); loadTopups(v.id) }

  const confirmTopup = async (id: string) => {
    setTopupActionId(id)
    const { error } = await supabase.rpc('confirm_vehicle_wallet_topup', { p_topup_id: id })
    setTopupActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.topupConfirmedToast'))
    if (selected) loadTopups(selected.id)
  }
  const rejectTopup = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setTopupActionId(id)
    const { error } = await supabase.rpc('reject_vehicle_wallet_topup', { p_topup_id: id, p_reason: reason || null })
    setTopupActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.topupRejectedToast'))
    if (selected) loadTopups(selected.id)
  }

  // See admin/shops' identical findKeeper for why this persists
  // immediately rather than waiting for a later form save, and why a
  // portal account already linked to another vehicle is blocked here
  // with a named error instead of a raw constraint failure (migration 406).
  const findKeeper = async () => {
    const mobile = keeperMobile.trim()
    if (!mobile) return
    setLinkingKeeper(true)
    const { data } = await supabase.from('portal_users').select('id, full_name, mobile').eq('mobile', mobile).eq('is_active', true).maybeSingle()
    if (!data) { setLinkingKeeper(false); toast.error(t('sk.keeperNotFound')); return }

    const { data: existingLink } = await supabase.from('vehicles').select('id, owner_name').eq('portal_user_id', data.id).maybeSingle()
    if (existingLink && existingLink.id !== editingVehicle?.id) {
      setLinkingKeeper(false)
      toast.error(t('sk.keeperAlreadyLinkedElsewhereVehicle').replace('{vehicle}', existingLink.owner_name))
      return
    }

    if (editingVehicle) {
      const { error } = await supabase.from('vehicles').update({ portal_user_id: data.id }).eq('id', editingVehicle.id)
      setLinkingKeeper(false)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('sk.keeperLinkedToast'))
      load()
    } else {
      setLinkingKeeper(false)
    }
    setVehicleForm({ ...vehicleForm, portal_user_id: data.id })
    setKeeperName(`${data.full_name} (${data.mobile})`)
    setKeeperMobile('')
  }
  const unlinkKeeper = async () => {
    setVehicleForm({ ...vehicleForm, portal_user_id: null }); setKeeperName(null)
    if (!editingVehicle) return
    const { error } = await supabase.from('vehicles').update({ portal_user_id: null }).eq('id', editingVehicle.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.keeperUnlinkedToast'))
    load()
  }

  const confirmBooking = async (b: Booking) => {
    setBookingActionId(b.id)
    const { error } = await supabase.rpc('confirm_ride_booking', { p_booking_id: b.id })
    setBookingActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.bookingConfirmedToast'))
    if (selected) loadBookings(selected.id)
  }

  const rejectBooking = async (b: Booking) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setBookingActionId(b.id)
    const { error } = await supabase.rpc('reject_ride_booking', { p_booking_id: b.id, p_reason: reason || null })
    setBookingActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.bookingRejectedToast'))
    if (selected) loadBookings(selected.id)
  }

  const openNewVehicle = () => { setEditingVehicle(null); setVehicleForm(emptyVehicle); setShowVehicleForm(true) }
  const openEditVehicle = (v: Vehicle) => {
    setEditingVehicle(v)
    setVehicleForm({
      owner_name: v.owner_name, owner_mobile: v.owner_mobile ?? '', owner_whatsapp: v.owner_whatsapp ?? '',
      vehicle_type: v.vehicle_type, vehicle_number: v.vehicle_number ?? '', total_seats: v.total_seats, is_active: v.is_active,
      portal_user_id: v.portal_user_id, commission_mode: v.commission_mode, lumpsum_fee_pkr: v.lumpsum_fee_pkr ?? 0,
    })
    setKeeperMobile('')
    if (v.portal_user_id) {
      supabase.from('portal_users').select('full_name, mobile').eq('id', v.portal_user_id).maybeSingle()
        .then(({ data }) => setKeeperName(data ? `${data.full_name} (${data.mobile})` : null))
    } else setKeeperName(null)
    setShowVehicleForm(true)
  }

  const saveVehicle = async () => {
    if (!vehicleForm.owner_name.trim() || !vehicleForm.vehicle_type.trim()) { toast.error(t('mk.nameRequired')); return }
    setSaving(true)
    const payload = {
      ...vehicleForm, owner_mobile: vehicleForm.owner_mobile || null, owner_whatsapp: vehicleForm.owner_whatsapp || null, vehicle_number: vehicleForm.vehicle_number || null,
      lumpsum_fee_pkr: vehicleForm.commission_mode === 'monthly_lumpsum' ? vehicleForm.lumpsum_fee_pkr : null,
    }
    const { error } = editingVehicle
      ? await supabase.from('vehicles').update(payload).eq('id', editingVehicle.id)
      : await supabase.from('vehicles').insert(payload)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.vehicleSaved'))
    setShowVehicleForm(false)
    load()
    if (selected && editingVehicle) setSelected({ ...selected, ...payload })
  }

  const deleteVehicle = async (v: Vehicle) => {
    if (!confirm(t('mk.confirmDeleteVehicle'))) return
    const { error } = await supabase.from('vehicles').delete().eq('id', v.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.vehicleDeleted'))
    if (selected?.id === v.id) setSelected(null)
    load()
  }

  const openNewRoute = () => { setEditingRoute(null); setRouteForm(emptyRoute); setShowRouteForm(true) }
  const openEditRoute = (r: Route) => {
    setEditingRoute(r)
    setRouteForm({
      origin: r.origin, origin_ur: r.origin_ur ?? '', destination: r.destination, destination_ur: r.destination_ur ?? '',
      classification: r.classification, fare_per_seat_pkr: r.fare_per_seat_pkr, departure_time: r.departure_time ?? '',
      days_of_week: r.days_of_week, is_active: r.is_active,
      origin_lat: r.origin_lat, origin_lng: r.origin_lng, destination_lat: r.destination_lat, destination_lng: r.destination_lng,
    })
    setShowRouteForm(true)
  }

  const toggleDay = (d: number) => {
    setRouteForm((f) => ({ ...f, days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter((x) => x !== d) : [...f.days_of_week, d].sort() }))
  }

  const saveRoute = async () => {
    if (!selected || !routeForm.origin.trim() || !routeForm.destination.trim()) { toast.error(t('mk.nameRequired')); return }
    if (routeForm.days_of_week.length === 0) { toast.error(t('mk.pickAtLeastOneDay')); return }
    setSaving(true)
    const payload = {
      vehicle_id: selected.id, origin: routeForm.origin, origin_ur: routeForm.origin_ur || null,
      destination: routeForm.destination, destination_ur: routeForm.destination_ur || null,
      classification: routeForm.classification, fare_per_seat_pkr: routeForm.fare_per_seat_pkr,
      departure_time: routeForm.departure_time || null, days_of_week: routeForm.days_of_week, is_active: routeForm.is_active,
      origin_lat: routeForm.origin_lat, origin_lng: routeForm.origin_lng, destination_lat: routeForm.destination_lat, destination_lng: routeForm.destination_lng,
    }
    const { error } = editingRoute
      ? await supabase.from('vehicle_routes').update(payload).eq('id', editingRoute.id)
      : await supabase.from('vehicle_routes').insert(payload)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.routeSaved'))
    setShowRouteForm(false)
    loadRoutes(selected.id)
    load()
  }

  const deleteRoute = async (r: Route) => {
    if (!confirm(t('mk.confirmDeleteRoute'))) return
    const { error } = await supabase.from('vehicle_routes').delete().eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mk.routeDeleted'))
    if (selected) loadRoutes(selected.id)
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('dn.noAccessMessage')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      {!selected ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
            <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2"><Bus size={24} /> {t('mk.vehiclesTitle')}</h1>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowRates((s) => !s)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container"><Percent size={14} /> {t('cm.ratesBtn')}</button>
              <button onClick={openNewVehicle} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('mk.newVehicleBtn')}</button>
            </div>
          </div>

          {showRates && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-6">
              <p className="font-sans text-[13px] font-bold text-dp-on-surface mb-1">{t('cm.ratesHeading')}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">{t('cm.ratesHint')}</p>
              <div className="space-y-1.5 mb-3">
                {rates.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 bg-dp-surface-container rounded-lg px-3 py-2">
                    <span className="font-sans text-[13px] text-dp-on-surface">{r.vehicle_type} — {r.classification === 'intercity' ? t('mk.intercity') : t('mk.outOfCity')}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-sans text-[13px] font-bold text-dp-secondary ltr-num">{r.commission_pct}%</span>
                      <button onClick={() => deleteRate(r.id)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={13} /></button>
                    </div>
                  </div>
                ))}
                {rates.length === 0 && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('cm.noRatesYet')}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input value={newRate.vehicle_type} onChange={(e) => setNewRate({ ...newRate, vehicle_type: e.target.value })} placeholder={t('mk.vehicleTypePlaceholder')} className="input-field flex-1 min-w-[140px]" />
                <select value={newRate.classification} onChange={(e) => setNewRate({ ...newRate, classification: e.target.value })} className="input-field w-auto">
                  <option value="intercity">{t('mk.intercity')}</option>
                  <option value="out_of_city">{t('mk.outOfCity')}</option>
                </select>
                <input type="number" value={newRate.commission_pct || ''} onChange={(e) => setNewRate({ ...newRate, commission_pct: +e.target.value })} placeholder="%" className="input-field w-20" />
                <button onClick={saveRate} disabled={savingRate} className="px-3 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('g.saveChanges')}</button>
              </div>
            </div>
          )}

          {loading && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('action.loading')}</p>}
          {!loading && vehicles.length === 0 && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('mk.noVehiclesYet')}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {vehicles.map((v) => (
              <button key={v.id} onClick={() => openVehicle(v)} className="text-start bg-white border border-dp-outline-variant rounded-lg p-4 hover:border-dp-secondary transition-colors cursor-pointer">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-sans text-[15px] font-bold text-dp-on-surface truncate">{v.owner_name}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{v.vehicle_type}{v.vehicle_number ? ` · ${v.vehicle_number}` : ''}</p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${v.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                    {v.is_active ? t('mk.active') : t('mk.inactive')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-3">
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{v.total_seats} {t('mk.seatsLabel')}</span>
                  <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{routeCountByVehicle[v.id] ?? 0} {t('mk.routesCount')}</span>
                  {v.commission_mode === 'monthly_lumpsum' && <span className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">{t('cm.lumpsumBadge')}</span>}
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
            <div>
              <button onClick={() => setSelected(null)} className="font-sans text-[13px] font-semibold text-dp-secondary hover:underline cursor-pointer mb-1">{t('mk.backToVehicles')}</button>
              <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary">{selected.owner_name}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => openEditVehicle(selected)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container"><Pencil size={14} /> {t('mk.editVehicleBtn')}</button>
              <button onClick={openNewRoute} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('mk.newRouteBtn')}</button>
            </div>
          </div>

          {routes.length === 0 && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('mk.noRoutesYet')}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {routes.map((r) => (
              <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-sans text-[14.5px] font-bold text-dp-on-surface flex items-center gap-1.5">
                    <MapPin size={14} className="text-dp-secondary shrink-0" />
                    {isUrdu && r.origin_ur ? r.origin_ur : r.origin} → {isUrdu && r.destination_ur ? r.destination_ur : r.destination}
                  </p>
                  <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${r.classification === 'intercity' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'}`}>
                    {r.classification === 'intercity' ? t('mk.intercity') : t('mk.outOfCity')}
                  </span>
                </div>
                <p className="font-sans text-[15px] font-bold text-dp-secondary mt-1.5">{fmt(r.fare_per_seat_pkr)} <span className="font-normal text-dp-on-surface-variant text-[12px]">{t('mk.perSeat')}</span></p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                  {r.departure_time ? r.departure_time.slice(0, 5) : t('mk.noFixedTime')}
                  {' · '}
                  {r.days_of_week.length === 7 ? t('mk.everyDay') : r.days_of_week.map((d) => t(DAY_KEYS[d])).join(', ')}
                </p>
                {!r.is_active && <span className="inline-block mt-1.5 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('mk.inactive')}</span>}
                <div className="flex items-center gap-1 mt-2 pt-2 border-t border-dp-outline-variant/60">
                  <button onClick={() => openEditRoute(r)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={14} /></button>
                  <button onClick={() => deleteRoute(r)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>

          {bookings.length > 0 && (
            <div className="mt-8">
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mp.bookingsHeading')}</p>
              <div className="space-y-2">
                {bookings.map((b) => (
                  <div key={b.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">
                          {b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—'}
                        </p>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(b.travel_date).toLocaleDateString('en-GB')} · {b.seats} {t('mk.seatsLabel')}</p>
                      </div>
                      <p className="font-sans text-[14px] font-bold text-dp-secondary shrink-0">{fmt(b.total_amount_pkr)}</p>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                      {b.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={12} /> {t('mp.confirmedStatus')}</span>}
                      {b.status === 'rejected' && <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold" title={b.rejected_reason ?? undefined}><XCircle size={12} /> {t('mp.rejectedStatus')}</span>}
                      {b.status === 'announced' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={12} /> {t('mp.awaitingStatus')}</span>}
                      {b.status === 'announced' && (
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => rejectBooking(b)} disabled={bookingActionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                          <button onClick={() => confirmBooking(b)} disabled={bookingActionId === b.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('mp.confirmBtn')}</button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {topups.filter((tp) => tp.status === 'announced').length > 0 && (
            <div className="mt-8">
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.topupsHeading')}</p>
              <div className="space-y-2">
                {topups.filter((tp) => tp.status === 'announced').map((tp) => (
                  <div key={tp.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5">
                    <p className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(tp.amount_pkr)}</p>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => rejectTopup(tp.id)} disabled={topupActionId === tp.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                      <button onClick={() => confirmTopup(tp.id)} disabled={topupActionId === tp.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('mp.confirmBtn')}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selected.commission_mode === 'monthly_lumpsum' && (
            <div className="mt-8">
              <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.chargeHistoryHeading')}</p>
              {charges.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('cm.noChargesYet')}</p>}
              <div className="space-y-1.5">
                {charges.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg px-3.5 py-2.5">
                    <p className="font-sans text-[13px] text-dp-on-surface">{c.period}</p>
                    <p className="font-sans text-[13.5px] font-bold text-dp-secondary">{fmt(c.amount_pkr)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {showVehicleForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowVehicleForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingVehicle ? t('mk.editVehicleBtn') : t('mk.newVehicleBtn')}</h2>
              <button onClick={() => setShowVehicleForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input value={vehicleForm.owner_name} onChange={(e) => setVehicleForm({ ...vehicleForm, owner_name: e.target.value })} placeholder={t('mk.ownerNamePlaceholder')} className="input-field" />
              <div className="grid grid-cols-2 gap-3">
                <input value={vehicleForm.owner_mobile} onChange={(e) => setVehicleForm({ ...vehicleForm, owner_mobile: e.target.value })} placeholder={t('a.phone')} className="input-field" />
                <input value={vehicleForm.owner_whatsapp} onChange={(e) => setVehicleForm({ ...vehicleForm, owner_whatsapp: e.target.value })} placeholder={t('w.whatsapp')} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={vehicleForm.vehicle_type} onChange={(e) => setVehicleForm({ ...vehicleForm, vehicle_type: e.target.value })} placeholder={t('mk.vehicleTypePlaceholder')} className="input-field" />
                <input value={vehicleForm.vehicle_number} onChange={(e) => setVehicleForm({ ...vehicleForm, vehicle_number: e.target.value })} placeholder={t('mk.vehicleNumberPlaceholder')} className="input-field" />
              </div>
              <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={vehicleForm.total_seats || ''} onChange={(e) => setVehicleForm({ ...vehicleForm, total_seats: +e.target.value })} className="input-field" placeholder="0" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={vehicleForm.is_active} onChange={(e) => setVehicleForm({ ...vehicleForm, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('mk.vehicleActiveLabel')}</span></label>

              <div className="pt-2 border-t border-dp-outline-variant/60">
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.modeLabel')}</label>
                <select value={vehicleForm.commission_mode} onChange={(e) => setVehicleForm({ ...vehicleForm, commission_mode: e.target.value })} className="input-field">
                  <option value="per_order">{t('cm.perOrderOption')}</option>
                  <option value="monthly_lumpsum">{t('cm.lumpsumOption')}</option>
                </select>
                {vehicleForm.commission_mode === 'per_order' ? (
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('cm.vehiclePerOrderHint')}</p>
                ) : (
                  <>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('cm.lumpsumHint')}</p>
                    <div className="mt-2">
                      <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.lumpsumFeeLabel')}</label>
                      <input type="number" value={vehicleForm.lumpsum_fee_pkr || ''} onChange={(e) => setVehicleForm({ ...vehicleForm, lumpsum_fee_pkr: +e.target.value })} className="input-field" placeholder="0" />
                    </div>
                  </>
                )}
              </div>

              <div className="pt-2 border-t border-dp-outline-variant/60">
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.driverLinkLabel')}</label>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2">{t('cm.driverLinkHint')}</p>
                {keeperName ? (
                  <div className="flex items-center justify-between gap-2 bg-dp-secondary-container/40 rounded-lg px-3 py-2">
                    <span className="font-sans text-[13px] text-dp-on-surface truncate">{keeperName}</span>
                    <button onClick={unlinkKeeper} className="font-sans text-[12px] font-semibold text-dp-error cursor-pointer shrink-0">{t('g.remove')}</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input value={keeperMobile} onChange={(e) => setKeeperMobile(e.target.value)} placeholder={t('sk.keeperMobilePlaceholder')} className="input-field" dir="ltr" />
                    <button onClick={findKeeper} disabled={linkingKeeper} className="shrink-0 px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container disabled:opacity-50">{t('sk.linkBtn')}</button>
                  </div>
                )}
              </div>

              <button onClick={saveVehicle} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}

      {showRouteForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowRouteForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingRoute ? t('mk.editRouteBtn') : t('mk.newRouteBtn')}</h2>
              <button onClick={() => setShowRouteForm(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input value={routeForm.origin} onChange={(e) => setRouteForm({ ...routeForm, origin: e.target.value })} placeholder={t('mk.originPlaceholder')} className="input-field" />
                <input value={routeForm.destination} onChange={(e) => setRouteForm({ ...routeForm, destination: e.target.value })} placeholder={t('mk.destinationPlaceholder')} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={routeForm.origin_ur} onChange={(e) => setRouteForm({ ...routeForm, origin_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
                <input value={routeForm.destination_ur} onChange={(e) => setRouteForm({ ...routeForm, destination_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              </div>
              <select value={routeForm.classification} onChange={(e) => setRouteForm({ ...routeForm, classification: e.target.value })} className="input-field">
                <option value="intercity">{t('mk.intercity')}</option>
                <option value="out_of_city">{t('mk.outOfCity')}</option>
              </select>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.farePerSeatLabel')}</label><input type="number" value={routeForm.fare_per_seat_pkr || ''} onChange={(e) => setRouteForm({ ...routeForm, fare_per_seat_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.departureTimeLabel')}</label><input type="time" value={routeForm.departure_time} onChange={(e) => setRouteForm({ ...routeForm, departure_time: e.target.value })} className="input-field" /></div>
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('mk.daysOfWeekLabel')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_KEYS.map((k, i) => (
                    <button key={i} type="button" onClick={() => toggleDay(i)} className={`px-2.5 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer transition-all ${routeForm.days_of_week.includes(i) ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                      {t(k)}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={routeForm.is_active} onChange={(e) => setRouteForm({ ...routeForm, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('mk.routeActiveLabel')}</span></label>

              <div className="pt-2 border-t border-dp-outline-variant/60">
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.mapPinsLabel')}</label>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2">{t('cm.mapPinsHint')}</p>
                <LeafletPinPicker
                  originLat={routeForm.origin_lat} originLng={routeForm.origin_lng}
                  destinationLat={routeForm.destination_lat} destinationLng={routeForm.destination_lng}
                  onChange={(pins) => setRouteForm({ ...routeForm, origin_lat: pins.originLat, origin_lng: pins.originLng, destination_lat: pins.destinationLat, destination_lng: pins.destinationLng })}
                />
              </div>

              <button onClick={saveRoute} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('action.saving') : t('g.saveChanges')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
