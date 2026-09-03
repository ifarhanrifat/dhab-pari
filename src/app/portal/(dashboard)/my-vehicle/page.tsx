'use client'

// Driver self-service: bookings + wallet + earnings for whichever vehicle
// is linked to this portal account (vehicles.portal_user_id, staff-set —
// see migration 394). Route/schedule creation stays staff-managed
// (unlike a shop's own catalog, that wasn't part of this ask) — this page
// is what a per_order driver actually needs day to day: their wallet
// balance, a top-up button, and marking a booking fulfilled themselves
// (no payment to verify — the rider already paid them directly).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bus, Wallet, TrendingUp, Clock, CheckCircle2, XCircle, MapPin, PlusCircle, X, Navigation, Signpost, LogOut, SkipForward, Timer, Trophy, Pencil, Truck, Package, MessageCircle, CalendarClock, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { WalletTopupModal } from '@/components/portal/WalletTopupModal'
import { TripLiveShareToggle } from '@/components/portal/TripLiveShareToggle'
import { getCurrentPositionOnce, classifyLocationError, type LocationErrorReason } from '@/hooks/useLiveLocation'
import { LocationSettingsModal } from '@/components/portal/LocationSettingsModal'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Vehicle { id: string; owner_name: string; vehicle_type: string; commission_mode: string; delivers: boolean; per_km_pkr: number | null }
interface TripOffer {
  id: string; trip_type: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; seats_available: number; listed_fare_per_seat_pkr: number; status: string
  share_live_location: boolean
}
interface FareOffer {
  id: string; trip_offer_id: string; seats_requested: number; proposed_fare_per_seat_pkr: number
  counter_fare_per_seat_pkr: number | null; status: string; portal_users: { full_name: string; mobile: string } | null
}
interface TripBooking {
  id: string; seats: number; agreed_fare_per_seat_pkr: number; total_amount_pkr: number; status: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; travel_date: string } | null
}
const emptyTripOffer = {
  trip_type: 'oneway' as string, origin: '', origin_ur: '', destination: '', destination_ur: '', classification: 'intercity',
  travel_date: '', departure_time_estimate: '', seats_available: 1, listed_fare_per_seat_pkr: 0,
}
interface Summary {
  balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null
  today_earnings_pkr: number; month_earnings_pkr: number; pending_bookings_count: number
  last_settlement_date: string | null; last_settlement_amount: number | null
}
interface Booking {
  id: string; status: string; total_amount_pkr: number; seats: number; travel_date: string; rejected_reason: string | null
  vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface Adda { id: string; name: string; name_ur: string | null; pair_adda_id: string | null; fixed_fare_per_seat_pkr: number | null }
interface AddaBoardEntry {
  entry_id: string; status: string; position: number
  turn_started_at: string | null; turn_expires_at: string | null
  seats_total: number; seats_available: number; fare_mode: string; fixed_fare_per_seat_pkr: number | null
  vehicle_id: string; owner_name: string
}
interface AddaBoard { adda: Adda; pair_adda: Adda | null; entries: AddaBoardEntry[] }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehiclePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const router = useRouter()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [actionId, setActionId] = useState<string | null>(null)
  const [showTopup, setShowTopup] = useState(false)

  const [tripOffers, setTripOffers] = useState<TripOffer[]>([])
  const [fareOffersByTrip, setFareOffersByTrip] = useState<Record<string, FareOffer[]>>({})
  const [tripBookings, setTripBookings] = useState<TripBooking[]>([])
  const [showPostTrip, setShowPostTrip] = useState(false)
  const [tripForm, setTripForm] = useState(emptyTripOffer)
  const [posting, setPosting] = useState(false)
  const [counterAmount, setCounterAmount] = useState<Record<string, number>>({})

  const reload = async (vehicleId: string) => {
    const [{ data: s }, { data: b }, { data: trips }, { data: tripB }] = await Promise.all([
      supabase.rpc('vehicle_dashboard_summary', { p_vehicle_id: vehicleId }),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, seats, travel_date, rejected_reason, vehicle_routes!inner(vehicle_id, origin, origin_ur, destination, destination_ur)')
        .eq('vehicle_routes.vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(20),
      supabase.from('vehicle_trip_offers').select('*').eq('vehicle_id', vehicleId).order('created_at', { ascending: false }),
      supabase.from('vehicle_trip_bookings').select('id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, status, vehicle_trip_offers(origin, origin_ur, destination, destination_ur, travel_date)')
        .eq('vehicle_id', vehicleId).order('created_at', { ascending: false }).limit(20),
    ])
    setSummary(s as unknown as Summary)
    setBookings((b ?? []) as unknown as Booking[])
    setTripOffers(trips ?? [])
    setTripBookings((tripB ?? []) as unknown as TripBooking[])

    if (trips && trips.length > 0) {
      const { data: fareOffers } = await supabase.from('vehicle_trip_fare_offers')
        .select('id, trip_offer_id, seats_requested, proposed_fare_per_seat_pkr, counter_fare_per_seat_pkr, status, portal_users(full_name, mobile)')
        .in('trip_offer_id', trips.map((tr) => tr.id)).in('status', ['pending', 'countered']).order('created_at', { ascending: false })
      const grouped: Record<string, FareOffer[]> = {}
      for (const fo of (fareOffers ?? []) as unknown as FareOffer[]) {
        grouped[fo.trip_offer_id] = [...(grouped[fo.trip_offer_id] ?? []), fo]
      }
      setFareOffersByTrip(grouped)
    } else setFareOffersByTrip({})
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, vehicle_type, commission_mode, delivers, per_km_pkr').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) await reload(data.id)
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // ═══ Adda queue — "at the adda" self-service. A driver either has no
  // live entry today (show the check-in card) or has exactly one (the
  // adda_queue_one_live_per_vehicle index guarantees that), shown as a
  // status card with whichever actions its status allows.
  const [addas, setAddas] = useState<Adda[]>([])
  const [myEntry, setMyEntry] = useState<AddaBoardEntry & { adda_id: string; adda_name: string; adda_name_ur: string | null } | null>(null)
  const [myBoard, setMyBoard] = useState<AddaBoard | null>(null)
  const [addaActionLoading, setAddaActionLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [checkInAddaId, setCheckInAddaId] = useState('')
  const [checkInFareMode, setCheckInFareMode] = useState('fixed')
  const [checkInSeats, setCheckInSeats] = useState(0)
  const [checkInShareLocation, setCheckInShareLocation] = useState(true)
  const [checkingLocation, setCheckingLocation] = useState(false)
  const [locationModalReason, setLocationModalReason] = useState<Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'> | null>(null)
  const [editingSeats, setEditingSeats] = useState(false)
  const [seatsEditValue, setSeatsEditValue] = useState(0)

  const reloadAdda = async (vehicleId: string) => {
    const { data: addaList } = await supabase.from('addas').select('id, name, name_ur, pair_adda_id, fixed_fare_per_seat_pkr').eq('is_active', true).order('name')
    setAddas(addaList ?? [])
    const today = new Date().toLocaleDateString('en-CA')
    const { data: entry } = await supabase.from('adda_queue_entries').select('*, addas(name, name_ur)')
      .eq('vehicle_id', vehicleId).eq('queue_date', today).in('status', ['waiting', 'current']).maybeSingle()
    if (entry) {
      setMyEntry({ ...entry, entry_id: entry.id, adda_id: entry.adda_id, adda_name: entry.addas?.name ?? '', adda_name_ur: entry.addas?.name_ur ?? null })
      const { data: board } = await supabase.rpc('adda_board', { p_adda_id: entry.adda_id })
      if (board) setMyBoard(board)
    } else { setMyEntry(null); setMyBoard(null) }
  }
  useEffect(() => { if (vehicle) reloadAdda(vehicle.id) }, [vehicle]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!vehicle) return
    const iv = setInterval(() => reloadAdda(vehicle.id), 15000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle])
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  // ═══ Village-portal marketplace extensions — delivery on/off, city
  // presence check-in, service-class offers, weekend share offers, and
  // an inbox for incoming negotiation/dispatch requests. All self-service
  // via the RPCs migrations 421/424/426/428 built (vehicles' own RLS is
  // admin-write-only, see 428's comment).
  const [cities, setCities] = useState<{ id: string; name: string; name_ur: string | null }[]>([])
  const [presence, setPresence] = useState<{ city_id: string; city_name: string; expected_return_at: string | null } | null>(null)
  const [checkInCityId, setCheckInCityId] = useState('')
  const [perKmInput, setPerKmInput] = useState('')
  const [vpSaving, setVpSaving] = useState(false)
  const [serviceClasses, setServiceClasses] = useState<{ id: string; name: string; name_ur: string | null }[]>([])
  const [myServiceOfferIds, setMyServiceOfferIds] = useState<Set<string>>(new Set())
  const [weekendOffers, setWeekendOffers] = useState<{ id: string; city_name: string; city_name_ur: string | null; direction: string; day_of_week: number; seats_total: number; seats_taken: number; fare_per_seat_pkr: number; is_active: boolean }[]>([])
  const [showAddWeekendOffer, setShowAddWeekendOffer] = useState(false)
  const [weekendForm, setWeekendForm] = useState({ city_id: '', direction: 'to_village', day_of_week: 6, seats_total: 1, fare_per_seat_pkr: 0 })
  const [negotiationInbox, setNegotiationInbox] = useState<{ id: string; kind: string; status: string; item: string | null; last_message: string | null; as_role: string }[]>([])
  const [dispatchInvites, setDispatchInvites] = useState<{ call_id: string; item: string; address: string; goods_budget_pkr: number; tier: number; shop_name: string; city_name: string }[]>([])
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

  const reloadVillagePortal = async (vehicleId: string) => {
    const [{ data: p }, { data: sc }, { data: offers }, { data: wo }, { data: inbox }, { data: invites }] = await Promise.all([
      supabase.from('vehicle_city_presence').select('city_id, expected_return_at, cities(name)').eq('vehicle_id', vehicleId).eq('is_active', true).maybeSingle(),
      supabase.from('service_classes').select('id, name, name_ur').eq('is_active', true).order('display_order'),
      supabase.from('vehicle_service_offers').select('service_class_id').eq('vehicle_id', vehicleId).eq('is_active', true),
      supabase.rpc('my_weekend_share_offers', { p_vehicle_id: vehicleId }),
      supabase.rpc('my_negotiation_threads'),
      supabase.rpc('my_dispatch_invitations', { p_vehicle_id: vehicleId }),
    ])
    setPresence(p ? { city_id: p.city_id, city_name: (p.cities as unknown as { name: string })?.name ?? '', expected_return_at: p.expected_return_at } : null)
    setServiceClasses(sc ?? [])
    setMyServiceOfferIds(new Set((offers ?? []).map((o) => o.service_class_id)))
    setWeekendOffers((wo ?? []) as typeof weekendOffers)
    setNegotiationInbox(((inbox ?? []) as typeof negotiationInbox).filter((th) => th.as_role === 'driver'))
    setDispatchInvites((invites ?? []) as typeof dispatchInvites)
  }
  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (vehicle) { setPerKmInput(vehicle.per_km_pkr != null ? String(vehicle.per_km_pkr) : ''); reloadVillagePortal(vehicle.id) } }, [vehicle]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!vehicle) return
    const iv = setInterval(() => reloadVillagePortal(vehicle.id), 15000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle])

  const toggleDelivers = async () => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = await supabase.rpc('set_vehicle_delivery_prefs', { p_vehicle_id: vehicle.id, p_delivers: !vehicle.delivers, p_per_km_pkr: null })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, delivers: !vehicle.delivers })
  }
  const savePerKm = async () => {
    if (!vehicle || !perKmInput) return
    setVpSaving(true)
    const { error } = await supabase.rpc('set_vehicle_delivery_prefs', { p_vehicle_id: vehicle.id, p_delivers: vehicle.delivers, p_per_km_pkr: Number(perKmInput) })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, per_km_pkr: Number(perKmInput) })
    toast.success(t('vp.rateSavedToast'))
  }
  const doCheckIn = async () => {
    if (!vehicle || !checkInCityId) return
    setVpSaving(true)
    const { error } = await supabase.rpc('vehicle_check_in_city', { p_vehicle_id: vehicle.id, p_city_id: checkInCityId })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reloadVillagePortal(vehicle.id)
  }
  const doCheckOut = async () => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = await supabase.rpc('vehicle_check_out_city', { p_vehicle_id: vehicle.id })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reloadVillagePortal(vehicle.id)
  }
  const toggleServiceOffer = async (serviceClassId: string, offering: boolean) => {
    if (!vehicle) return
    if (offering) await supabase.from('vehicle_service_offers').delete().eq('vehicle_id', vehicle.id).eq('service_class_id', serviceClassId)
    else await supabase.from('vehicle_service_offers').insert({ vehicle_id: vehicle.id, service_class_id: serviceClassId })
    reloadVillagePortal(vehicle.id)
  }
  const addWeekendOffer = async () => {
    if (!vehicle || !weekendForm.city_id || !weekendForm.fare_per_seat_pkr) { toast.error(t('vp.fillWeekendFormError')); return }
    setVpSaving(true)
    const { error } = await supabase.from('weekend_share_offers').insert({
      vehicle_id: vehicle.id, city_id: weekendForm.city_id, direction: weekendForm.direction,
      day_of_week: weekendForm.day_of_week, seats_total: weekendForm.seats_total, fare_per_seat_pkr: weekendForm.fare_per_seat_pkr,
    })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setShowAddWeekendOffer(false)
    setWeekendForm({ city_id: '', direction: 'to_village', day_of_week: 6, seats_total: 1, fare_per_seat_pkr: 0 })
    reloadVillagePortal(vehicle.id)
  }
  const removeWeekendOffer = async (id: string) => {
    if (!vehicle) return
    await supabase.from('weekend_share_offers').delete().eq('id', id)
    reloadVillagePortal(vehicle.id)
  }
  const respondDispatchInvite = async (callId: string, action: 'accept' | 'decline') => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = await supabase.rpc(action === 'accept' ? 'accept_dispatch_call' : 'decline_dispatch_call', { p_call_id: callId, p_vehicle_id: vehicle.id })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    if (action === 'accept') router.push(`/portal/marketplace/dispatch/${callId}`)
    else reloadVillagePortal(vehicle.id)
  }

  const secondsLeft = (expiresAt: string | null) => expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000)) : null
  const fmtCountdown = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

  const doAddaCheckIn = async () => {
    if (!vehicle || !checkInAddaId) { toast.error(t('af.pickAddaFirst')); return }
    setAddaActionLoading(true)
    // A driver checking himself in needs to actually be at the stand —
    // the RPC enforces this (409/415/416's geofence), this just supplies
    // the position it checks against. Missing/denied location still
    // reaches the RPC (as null lat/lng) rather than blocking the attempt
    // client-side, so the check-in can still go through for an adda with
    // no pin set — but tell the driver why the fix failed right away
    // (GPS off vs. permission vs. timeout are different fixes) rather
    // than leaving him to guess from whatever the server says next.
    setCheckingLocation(true)
    let lat: number | null = null; let lng: number | null = null
    try {
      const pos = await getCurrentPositionOnce()
      lat = pos.lat; lng = pos.lng
    } catch (err) {
      const reason = classifyLocationError(err)
      // See useMyLocation on the Going Home page for why 'unavailable'
      // also gets the settings shortcut rather than a dead-end toast.
      if (reason === 'timeout') toast.error(t('af.locationTimeoutHint'))
      else setLocationModalReason(reason === 'permission_denied' ? 'permission_denied' : 'services_disabled')
    }
    setCheckingLocation(false)

    const { error } = await supabase.rpc('adda_check_in', {
      p_adda_id: checkInAddaId, p_vehicle_id: vehicle.id, p_fare_mode: checkInFareMode,
      p_share_location_on_depart: checkInShareLocation, p_lat: lat, p_lng: lng,
      p_seats_available: checkInSeats || null,
    })
    setAddaActionLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.checkedInToast'))
    reloadAdda(vehicle.id)
  }
  const doAddaDeparted = async () => {
    if (!vehicle || !myEntry) return
    setAddaActionLoading(true)
    const { error } = await supabase.rpc('adda_mark_departed', { p_entry_id: myEntry.entry_id })
    setAddaActionLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.departedToast'))
    reloadAdda(vehicle.id)
  }
  const doAddaPass = async () => {
    if (!vehicle || !myEntry) return
    setAddaActionLoading(true)
    const { error } = await supabase.rpc('adda_pass_turn', { p_entry_id: myEntry.entry_id })
    setAddaActionLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.passedToast'))
    reloadAdda(vehicle.id)
  }
  const doAddaClaim = async () => {
    if (!vehicle || !myEntry) return
    setAddaActionLoading(true)
    const { error } = await supabase.rpc('adda_claim_front', { p_entry_id: myEntry.entry_id })
    setAddaActionLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.claimedToast'))
    reloadAdda(vehicle.id)
  }
  const doAddaLeave = async () => {
    if (!vehicle || !myEntry) return
    setAddaActionLoading(true)
    const { error } = await supabase.rpc('adda_leave_queue', { p_entry_id: myEntry.entry_id })
    setAddaActionLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.leftQueueToast'))
    reloadAdda(vehicle.id)
  }
  const openEditSeats = () => {
    if (!myEntry) return
    setSeatsEditValue(myEntry.seats_total)
    setEditingSeats(true)
  }
  const doUpdateSeats = async () => {
    if (!vehicle || !myEntry) return
    setAddaActionLoading(true)
    const { error } = await supabase.rpc('adda_update_seats', { p_entry_id: myEntry.entry_id, p_seats_total: seatsEditValue })
    setAddaActionLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.seatsUpdatedToast'))
    setEditingSeats(false)
    reloadAdda(vehicle.id)
  }

  const postTripOffer = async () => {
    if (!vehicle || !tripForm.origin.trim() || !tripForm.destination.trim() || !tripForm.travel_date) { toast.error(t('mk.nameRequired')); return }
    setPosting(true)
    const { error } = await supabase.rpc('place_trip_offer', {
      p_vehicle_id: vehicle.id, p_trip_type: tripForm.trip_type, p_origin: tripForm.origin, p_origin_ur: tripForm.origin_ur || null,
      p_destination: tripForm.destination, p_destination_ur: tripForm.destination_ur || null,
      p_classification: tripForm.classification, p_travel_date: tripForm.travel_date,
      p_departure_time_estimate: tripForm.departure_time_estimate || null,
      p_seats_available: tripForm.seats_available, p_listed_fare_per_seat_pkr: tripForm.listed_fare_per_seat_pkr,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cm.tripPostedToast'))
    setShowPostTrip(false)
    setTripForm(emptyTripOffer)
    reload(vehicle.id)
  }

  const respondFare = async (fareOfferId: string, action: 'accept' | 'reject' | 'counter') => {
    if (!vehicle) return
    setActionId(fareOfferId)
    const { error } = await supabase.rpc('respond_trip_fare_offer', {
      p_fare_offer_id: fareOfferId, p_action: action, p_counter_fare_per_seat_pkr: action === 'counter' ? counterAmount[fareOfferId] ?? null : null,
    })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(action === 'accept' ? t('cm.fareAcceptedToast') : action === 'counter' ? t('cm.fareCounteredToast') : t('cm.fareRejectedToast'))
    reload(vehicle.id)
  }

  const completeTripBooking = async (id: string) => {
    if (!vehicle) return
    setActionId(id)
    const { error } = await supabase.rpc('complete_trip_booking', { p_trip_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cm.tripCompletedToast'))
    reload(vehicle.id)
  }

  const fulfillBooking = async (id: string) => {
    setActionId(id)
    const { error } = await supabase.rpc('confirm_ride_booking', { p_booking_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingConfirmedToast'))
    if (vehicle) reload(vehicle.id)
  }
  const cancelBooking = async (id: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('reject_ride_booking', { p_booking_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mp.bookingRejectedToast'))
    if (vehicle) reload(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('cm.noVehicleLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h1 className="font-heading text-[26px] font-bold leading-[34px] text-dp-primary flex items-center gap-2"><Bus size={22} /> {vehicle.owner_name}</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPostTrip(true)} className="flex items-center gap-1.5 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container">
            <PlusCircle size={14} /> {t('cm.postTripBtn')}
          </button>
          {vehicle.commission_mode === 'per_order' && (
            <button onClick={() => setShowTopup(true)} className="flex items-center gap-1.5 px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
              <Wallet size={14} /> {t('cm.topupWalletBtn')}
            </button>
          )}
        </div>
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

      <div className="mb-8">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Signpost size={13} /> {t('af.atTheAddaHeading')}</p>
        {!myEntry ? (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-2.5">{t('af.checkInHint')}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <select value={checkInAddaId} onChange={(e) => setCheckInAddaId(e.target.value)} className="input-field !w-auto flex-1 min-w-[140px]">
                <option value="">{t('af.pickAddaOption')}</option>
                {addas.map((a) => <option key={a.id} value={a.id}>{isUrdu && a.name_ur ? a.name_ur : a.name}</option>)}
              </select>
              <select value={checkInFareMode} onChange={(e) => setCheckInFareMode(e.target.value)} className="input-field !w-auto">
                <option value="fixed">{t('af.fixedFareOption')}</option>
                <option value="request">{t('af.rideRequestOption')}</option>
              </select>
              <input type="number" value={checkInSeats || ''} onChange={(e) => setCheckInSeats(+e.target.value)} placeholder={t('af.seatsAvailablePlaceholder')} className="input-field !w-28" />
              <button onClick={doAddaCheckIn} disabled={addaActionLoading || checkingLocation} className="px-3 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                {checkingLocation ? t('af.confirmingLocationBtn') : t('af.checkInBtn')}
              </button>
            </div>
            {checkInFareMode === 'fixed' && checkInAddaId && (() => {
              const picked = addas.find((a) => a.id === checkInAddaId)
              return picked?.fixed_fare_per_seat_pkr != null
                ? <p className="font-sans text-[12px] text-dp-secondary font-semibold mt-2">{t('af.systemFareShownHint').replace('{amount}', fmt(picked.fixed_fare_per_seat_pkr))}</p>
                : <p className="font-sans text-[12px] text-amber-700 mt-2">{t('af.noSystemFareYet')}</p>
            })()}
            <label className="flex items-center gap-2 cursor-pointer mt-2.5">
              <input type="checkbox" checked={checkInShareLocation} onChange={(e) => setCheckInShareLocation(e.target.checked)} className="accent-dp-secondary" />
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('af.shareLocationOnDepartLabel')}</span>
            </label>
          </div>
        ) : (
          <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
            <p className="font-sans text-[13.5px] font-bold text-dp-on-surface flex items-center gap-1.5"><MapPin size={13} className="text-dp-secondary" /> {isUrdu && myEntry.adda_name_ur ? myEntry.adda_name_ur : myEntry.adda_name}</p>
            {!editingSeats ? (
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 flex items-center gap-1.5">
                <span className="ltr-num">{myEntry.seats_available}/{myEntry.seats_total}</span> {t('af.seatsFreeLabel')}
                <button onClick={openEditSeats} disabled={addaActionLoading} className="inline-flex items-center gap-0.5 text-dp-secondary font-semibold hover:underline cursor-pointer disabled:opacity-50"><Pencil size={11} /> {t('af.editSeatsBtn')}</button>
              </p>
            ) : (
              <div className="flex items-center gap-1.5 mt-1.5">
                <input type="number" min={1} value={seatsEditValue || ''} onChange={(e) => setSeatsEditValue(+e.target.value)} className="input-field !w-20 !py-1" />
                <button onClick={doUpdateSeats} disabled={addaActionLoading} className="px-2.5 py-1 bg-dp-secondary text-white rounded-md text-[12px] font-sans font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('af.saveSeatsBtn')}</button>
                <button onClick={() => setEditingSeats(false)} disabled={addaActionLoading} className="px-2.5 py-1 border border-dp-outline-variant rounded-md text-[12px] font-sans font-semibold cursor-pointer hover:bg-dp-surface-container disabled:opacity-50">{t('action.cancel')}</button>
              </div>
            )}
            {myEntry.status === 'current' ? (
              <div className="bg-dp-secondary-container/30 rounded-lg p-2.5 mt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-sans text-[13px] font-bold text-dp-secondary"><Trophy size={13} /> {t('af.yourTurnLabel')}</span>
                  {secondsLeft(myEntry.turn_expires_at) != null && <span className="inline-flex items-center gap-1 font-sans text-[13px] font-bold text-dp-secondary ltr-num"><Timer size={13} /> {fmtCountdown(secondsLeft(myEntry.turn_expires_at)!)}</span>}
                </div>
                <div className="flex items-center gap-1.5 mt-2.5">
                  <button onClick={doAddaDeparted} disabled={addaActionLoading} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50"><LogOut size={12} /> {t('af.departedBtn')}</button>
                  <button onClick={doAddaPass} disabled={addaActionLoading} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50"><SkipForward size={12} /> {t('af.passBtn')}</button>
                </div>
              </div>
            ) : (
              <div className="mt-2">
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('af.waitingAtPositionLabel').replace('{n}', String(myEntry.position))}</p>
                {myBoard && (() => {
                  const current = myBoard.entries.find((e) => e.status === 'current')
                  const waiting = myBoard.entries.filter((e) => e.status === 'waiting').sort((a, b) => a.position - b.position)
                  const secs = current ? secondsLeft(current.turn_expires_at) : null
                  const canClaim = waiting[0]?.entry_id === myEntry.entry_id && (!current || secs === 0)
                  return (
                    <>
                      {current && secs != null && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{t('af.currentVehicleTimeLeft').replace('{name}', current.owner_name).replace('{time}', fmtCountdown(secs))}</p>}
                      {canClaim && (
                        <button onClick={doAddaClaim} disabled={addaActionLoading} className="mt-2 px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">{t('af.claimBtn')}</button>
                      )}
                    </>
                  )
                })()}
                <button onClick={doAddaLeave} disabled={addaActionLoading} className="mt-2 ms-2 font-sans text-[12px] text-dp-on-surface-variant hover:text-dp-error cursor-pointer">{t('af.leaveQueueBtn')}</button>
              </div>
            )}
          </div>
        )}
      </div>

      {dispatchInvites.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Truck size={13} /> {t('vp.incomingDeliveryCallsHeading')}</p>
          <div className="space-y-2">
            {dispatchInvites.map((c) => (
              <div key={c.call_id} className="bg-amber-50 border border-amber-200 rounded-lg p-3.5">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{c.item}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{c.shop_name} · {c.city_name} · {t('vp.tierLabel')} {c.tier}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1"><MapPin size={11} /> {c.address}</p>
                <div className="flex items-center gap-1.5 mt-2">
                  <button onClick={() => respondDispatchInvite(c.call_id, 'decline')} disabled={vpSaving} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('vp.declineDeliveryBtn')}</button>
                  <button onClick={() => respondDispatchInvite(c.call_id, 'accept')} disabled={vpSaving} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('vp.acceptDeliveryBtn')}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-8">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Package size={13} /> {t('vp.deliverySettingsHeading')}</p>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t('vp.deliversToggleLabel')}</p>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('vp.deliversToggleHint')}</p>
            </div>
            <button onClick={toggleDelivers} disabled={vpSaving} className={`shrink-0 relative w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${vehicle.delivers ? 'bg-dp-secondary' : 'bg-dp-surface-container-high'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${vehicle.delivers ? (isUrdu ? '-translate-x-5 right-0.5' : 'translate-x-5 left-0.5') : 'left-0.5'}`} />
            </button>
          </div>
          <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-dp-outline-variant/60">
            <span className="font-sans text-[12.5px] text-dp-on-surface-variant shrink-0">{t('vp.perKmRateLabel')}</span>
            <input type="number" value={perKmInput} onChange={(e) => setPerKmInput(e.target.value)} placeholder={t('vp.perKmRatePlaceholder')} className="input-field !py-1.5 !text-[13px] !w-28" />
            <button onClick={savePerKm} disabled={vpSaving} className="px-2.5 py-1.5 bg-dp-secondary text-white rounded-md text-[12px] font-sans font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('action.save')}</button>
          </div>

          <div className="mt-3 pt-3 border-t border-dp-outline-variant/60">
            <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('vp.cityPresenceLabel')}</p>
            {presence ? (
              <div className="flex items-center justify-between gap-2">
                <p className="font-sans text-[13px] text-dp-on-surface flex items-center gap-1"><MapPin size={12} className="text-dp-secondary" /> {presence.city_name}</p>
                <button onClick={doCheckOut} disabled={vpSaving} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('vp.checkOutBtn')}</button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <select value={checkInCityId} onChange={(e) => setCheckInCityId(e.target.value)} className="input-field !py-1.5 !text-[13px] flex-1">
                  <option value="">{t('vp.pickCityOption')}</option>
                  {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
                </select>
                <button onClick={doCheckIn} disabled={vpSaving || !checkInCityId} className="px-2.5 py-1.5 bg-dp-secondary text-white rounded-md text-[12px] font-sans font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50 shrink-0">{t('vp.checkInBtn')}</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mb-8">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Truck size={13} /> {t('vp.serviceOffersHeading')}</p>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap gap-1.5">
          {serviceClasses.map((sc) => {
            const on = myServiceOfferIds.has(sc.id)
            return (
              <button key={sc.id} onClick={() => toggleServiceOffer(sc.id, on)} className={`px-2.5 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer transition-colors ${on ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant border border-dp-outline-variant'}`}>
                {isUrdu && sc.name_ur ? sc.name_ur : sc.name}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mb-8">
        <div className="flex items-center justify-between mb-2.5">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] flex items-center gap-1.5"><CalendarClock size={13} /> {t('vp.weekendOffersHeading')}</p>
          <button onClick={() => setShowAddWeekendOffer(true)} className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer"><PlusCircle size={12} /> {t('action.add')}</button>
        </div>
        {weekendOffers.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.noWeekendOffersYet')}</p>}
        <div className="space-y-2">
          {weekendOffers.map((o) => (
            <div key={o.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3">
              <div className="min-w-0">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{isUrdu && o.city_name_ur ? o.city_name_ur : o.city_name} · {t(o.direction === 'to_village' ? 'vp.toVillageShort' : 'vp.toCityShort')}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t(`vp.day.${DAY_KEYS[o.day_of_week]}`)} · <span className="ltr-num">{o.seats_total - o.seats_taken}/{o.seats_total}</span> {t('vp.seatsFreeShortLabel')} · {fmt(o.fare_per_seat_pkr)}</p>
              </div>
              <button onClick={() => removeWeekendOffer(o.id)} className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-dp-error hover:bg-dp-error/10 cursor-pointer"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </div>

      {negotiationInbox.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><MessageCircle size={13} /> {t('vp.myConversationsTitle')}</p>
          <div className="space-y-2">
            {negotiationInbox.map((th) => (
              <Link key={th.id} href={`/portal/marketplace/negotiations/${th.id}`} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3 hover:border-dp-secondary transition-colors">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{th.item}</p>
                <span className={`shrink-0 text-[11px] font-bold ${th.status === 'open' ? 'text-amber-700' : th.status === 'agreed' ? 'text-emerald-700' : 'text-dp-on-surface-variant'}`}>{t(`vp.${th.status}StatusLabel`)}</span>
              </Link>
            ))}
          </div>
        </div>
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

      {tripOffers.length > 0 && (
        <div className="mt-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.myTripOffersHeading')}</p>
          <div className="space-y-3">
            {tripOffers.map((tr) => (
              <div key={tr.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate flex items-center gap-1"><MapPin size={12} className="shrink-0 text-dp-secondary" /> {isUrdu && tr.origin_ur ? tr.origin_ur : tr.origin} → {isUrdu && tr.destination_ur ? tr.destination_ur : tr.destination}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(tr.travel_date).toLocaleDateString('en-GB')} · {tr.seats_available} {t('mk.seatsLabel')} · {fmt(tr.listed_fare_per_seat_pkr)} {t('mk.perSeat')}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tr.trip_type === 'return' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>{tr.trip_type === 'return' ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}</span>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tr.status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>{tr.status === 'open' ? t('mk.active') : t('mk.inactive')}</span>
                  </div>
                </div>
                {(fareOffersByTrip[tr.id] ?? []).map((fo) => (
                  <div key={fo.id} className="mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">
                      {fo.portal_users?.full_name ?? '—'} — <span className="font-bold text-dp-secondary">{fmt(fo.proposed_fare_per_seat_pkr)}</span>/{t('mk.seatsLabel')} × <span className="ltr-num">{fo.seats_requested}</span>
                      {fo.status === 'countered' && <span className="text-amber-700 font-semibold"> ({t('cm.youCountered')} {fmt(fo.counter_fare_per_seat_pkr ?? 0)})</span>}
                    </p>
                    {fo.status === 'pending' && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <button onClick={() => respondFare(fo.id, 'reject')} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                        <input type="number" value={counterAmount[fo.id] ?? ''} onChange={(e) => setCounterAmount({ ...counterAmount, [fo.id]: +e.target.value })} placeholder={t('cm.counterPlaceholder')} className="input-field w-24 !py-1.5 !text-[12px]" />
                        <button onClick={() => respondFare(fo.id, 'counter')} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container disabled:opacity-50">{t('cm.counterBtn')}</button>
                        <button onClick={() => respondFare(fo.id, 'accept')} disabled={actionId === fo.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.acceptBtn')}</button>
                      </div>
                    )}
                  </div>
                ))}
                {tr.status === 'open' && (
                  <TripLiveShareToggle
                    tripOfferId={tr.id}
                    sharing={tr.share_live_location}
                    onSharingChange={(on) => setTripOffers((rows) => rows.map((r) => r.id === tr.id ? { ...r, share_live_location: on } : r))}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tripBookings.length > 0 && (
        <div className="mt-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.tripBookingsHeading')}</p>
          <div className="space-y-2">
            {tripBookings.map((tb) => (
              <div key={tb.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{tb.vehicle_trip_offers ? `${isUrdu && tb.vehicle_trip_offers.origin_ur ? tb.vehicle_trip_offers.origin_ur : tb.vehicle_trip_offers.origin} → ${isUrdu && tb.vehicle_trip_offers.destination_ur ? tb.vehicle_trip_offers.destination_ur : tb.vehicle_trip_offers.destination}` : '—'}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{tb.vehicle_trip_offers && new Date(tb.vehicle_trip_offers.travel_date).toLocaleDateString('en-GB')} · {tb.seats} {t('mk.seatsLabel')}</p>
                  </div>
                  <p className="font-sans text-[14px] font-bold text-dp-secondary shrink-0">{fmt(tb.total_amount_pkr)}</p>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  {tb.status === 'completed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('cm.tripCompletedStatus')}</span>}
                  {tb.status === 'confirmed' && (
                    <>
                      <Link href={`/portal/marketplace/trip/${tb.id}`} className="inline-flex items-center gap-1 text-dp-secondary text-[12px] font-semibold hover:underline"><Navigation size={12} /> {t('cm.trackLocationBtn')}</Link>
                      <button onClick={() => completeTripBooking(tb.id)} disabled={actionId === tb.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.markTripCompleteBtn')}</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPostTrip && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowPostTrip(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('cm.postTripBtn')}</h2>
              <button onClick={() => setShowPostTrip(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('cm.postTripHint')}</p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setTripForm({ ...tripForm, trip_type: 'oneway' })}
                  className={`py-2.5 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${tripForm.trip_type === 'oneway' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                  {t('cm.tripTypeOneway')}
                </button>
                <button type="button" onClick={() => setTripForm({ ...tripForm, trip_type: 'return' })}
                  className={`py-2.5 rounded-lg text-[13px] font-sans font-semibold cursor-pointer transition-all ${tripForm.trip_type === 'return' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                  {t('cm.tripTypeReturn')}
                </button>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{tripForm.trip_type === 'return' ? t('cm.tripTypeReturnHint') : t('cm.tripTypeOnewayHint')}</p>
              <div className="grid grid-cols-2 gap-3">
                <input value={tripForm.origin} onChange={(e) => setTripForm({ ...tripForm, origin: e.target.value })} placeholder={t('mk.originPlaceholder')} className="input-field" />
                <input value={tripForm.destination} onChange={(e) => setTripForm({ ...tripForm, destination: e.target.value })} placeholder={t('mk.destinationPlaceholder')} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={tripForm.origin_ur} onChange={(e) => setTripForm({ ...tripForm, origin_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
                <input value={tripForm.destination_ur} onChange={(e) => setTripForm({ ...tripForm, destination_ur: e.target.value })} placeholder={t('mk.nameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              </div>
              <select value={tripForm.classification} onChange={(e) => setTripForm({ ...tripForm, classification: e.target.value })} className="input-field">
                <option value="intercity">{t('mk.intercity')}</option>
                <option value="out_of_city">{t('mk.outOfCity')}</option>
              </select>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mp.travelDateLabel')}</label><input type="date" value={tripForm.travel_date} onChange={(e) => setTripForm({ ...tripForm, travel_date: e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.departureTimeLabel')}</label><input type="time" value={tripForm.departure_time_estimate} onChange={(e) => setTripForm({ ...tripForm, departure_time_estimate: e.target.value })} className="input-field" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={tripForm.seats_available || ''} onChange={(e) => setTripForm({ ...tripForm, seats_available: +e.target.value })} className="input-field" placeholder="1" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.listedFareLabel')}</label><input type="number" value={tripForm.listed_fare_per_seat_pkr || ''} onChange={(e) => setTripForm({ ...tripForm, listed_fare_per_seat_pkr: +e.target.value })} className="input-field" placeholder="0" /></div>
              </div>
              <button onClick={postTripOffer} disabled={posting} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{posting ? t('action.saving') : t('cm.postTripBtn')}</button>
            </div>
          </div>
        </div>
      )}

      {showAddWeekendOffer && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowAddWeekendOffer(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('vp.weekendOffersHeading')}</h2>
              <button onClick={() => setShowAddWeekendOffer(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <select value={weekendForm.city_id} onChange={(e) => setWeekendForm({ ...weekendForm, city_id: e.target.value })} className="input-field">
                <option value="">{t('vp.pickCityOption')}</option>
                {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setWeekendForm({ ...weekendForm, direction: 'to_village' })} className={`py-2 rounded-lg text-[13px] font-sans font-semibold cursor-pointer ${weekendForm.direction === 'to_village' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{t('vp.toVillageShort')}</button>
                <button type="button" onClick={() => setWeekendForm({ ...weekendForm, direction: 'to_city' })} className={`py-2 rounded-lg text-[13px] font-sans font-semibold cursor-pointer ${weekendForm.direction === 'to_city' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{t('vp.toCityShort')}</button>
              </div>
              <select value={weekendForm.day_of_week} onChange={(e) => setWeekendForm({ ...weekendForm, day_of_week: +e.target.value })} className="input-field">
                {DAY_KEYS.map((k, i) => <option key={k} value={i}>{t(`vp.day.${k}`)}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={weekendForm.seats_total || ''} onChange={(e) => setWeekendForm({ ...weekendForm, seats_total: +e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.listedFareLabel')}</label><input type="number" value={weekendForm.fare_per_seat_pkr || ''} onChange={(e) => setWeekendForm({ ...weekendForm, fare_per_seat_pkr: +e.target.value })} className="input-field" /></div>
              </div>
              <button onClick={addWeekendOffer} disabled={vpSaving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{vpSaving ? t('action.saving') : t('action.save')}</button>
            </div>
          </div>
        </div>
      )}

      {showTopup && (
        <WalletTopupModal kind="vehicle" sellerId={vehicle.id} onClose={() => setShowTopup(false)} onSubmitted={() => { setShowTopup(false); reload(vehicle.id) }} />
      )}

      {locationModalReason && <LocationSettingsModal reason={locationModalReason} onClose={() => setLocationModalReason(null)} />}
    </div>
  )
}
