'use client'

// Bookings screen of the new design (v.rTrips) — two tabs, the same
// browse/mine pattern already used for machinery/tractor/loader
// (EquipmentBookingPage.tsx, Phase 1):
//
// - Browse: the existing one-off return-trip rideshare board
//   (vehicle_trip_offers, propose/accept/withdraw) — preserved exactly,
//   just re-skinned, so this real feature isn't dropped by the rebuild.
// - My Bookings: genuinely new — a unified list merging every vertical's
//   own real "my bookings" source into one normalized shape, the same
//   normalization the design's own ov() does. No new backend: every
//   source here is an RPC/table that already existed before this page.
//   dispatch_calls (order-city) is deliberately left out — there's no
//   "my calls" listing anywhere in this app today, and its negotiation
//   side already shows up in Chat (kind='fetch'/'pro').

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { MapPin, Navigation, CheckCircle2, XCircle, Clock, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'
import { FareBandPicker, type FareBand } from '@/components/shared/FareBandPicker'

interface TripOffer {
  id: string; trip_type: string; origin: string; origin_ur: string | null; destination: string; destination_ur: string | null
  classification: string; travel_date: string; departure_time_estimate: string | null; seats_available: number; listed_fare_per_seat_pkr: number
  distance_km: number | null
  vehicles: { owner_name: string; vehicle_type: string } | null
}
interface MyFareOffer {
  id: string; trip_offer_id: string; seats_requested: number; proposed_fare_per_seat_pkr: number; counter_fare_per_seat_pkr: number | null; status: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null
}
interface MyTripBooking {
  id: string; trip_offer_id: string; seats: number; total_amount_pkr: number; status: string
  vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; travel_date: string } | null
}
interface BookingRow { id: string; title: string; subtitle: string; amount: number | null; status: 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'completed'; date: string; href: string | null }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
const STATUS_STYLE: Record<BookingRow['status'], { bg: string; fg: string }> = {
  pending: { bg: '#fef3c7', fg: '#92400e' }, confirmed: { bg: '#dcfce7', fg: '#166534' },
  declined: { bg: '#fee2e2', fg: '#b91c1c' }, cancelled: { bg: '#f1f5f9', fg: '#64748b' }, completed: { bg: '#e0f2fe', fg: '#0369a1' },
}
function mapStatus(s: string): BookingRow['status'] {
  if (s === 'completed') return 'completed'
  if (s === 'cancelled') return 'cancelled'
  if (['declined', 'rejected'].includes(s)) return 'declined'
  if (['confirmed', 'accepted', 'announced', 'in_progress'].includes(s)) return 'confirmed'
  return 'pending'
}

export default function TripsPage() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [tab, setTab] = useState<'browse' | 'mine'>('mine')

  // Browse tab state — unchanged from the page this replaces.
  const [offers, setOffers] = useState<TripOffer[]>([])
  const [myOffers, setMyOffers] = useState<MyFareOffer[]>([])
  const [myBookings, setMyBookings] = useState<MyTripBooking[]>([])
  const [proposing, setProposing] = useState<string | null>(null)
  const [seatsForm, setSeatsForm] = useState<Record<string, number>>({})
  const [fareForm, setFareForm] = useState<Record<string, number>>({})
  const [actionId, setActionId] = useState<string | null>(null)
  const [bandByTrip, setBandByTrip] = useState<Record<string, FareBand>>({})

  // My Bookings tab state — the new unified aggregator.
  const [rows, setRows] = useState<BookingRow[] | null>(null)

  const [loading, setLoading] = useState(true)

  const reloadBrowse = async () => {
    const [{ data: o }, { data: mo }, { data: mb }] = await Promise.all([
      supabase.from('vehicle_trip_offers').select('*, vehicles(owner_name, vehicle_type)').eq('status', 'open').order('travel_date'),
      supabase.from('vehicle_trip_fare_offers').select('id, trip_offer_id, seats_requested, proposed_fare_per_seat_pkr, counter_fare_per_seat_pkr, status, vehicle_trip_offers(origin, origin_ur, destination, destination_ur)')
        .in('status', ['pending', 'countered']).order('created_at', { ascending: false }),
      supabase.from('vehicle_trip_bookings').select('id, trip_offer_id, seats, total_amount_pkr, status, vehicle_trip_offers(origin, origin_ur, destination, destination_ur, travel_date)')
        .order('created_at', { ascending: false }).limit(20),
    ])
    const startsHere = (s: string | null) => !!s && (s.includes(site.name) || s.includes(site.nameUrdu))
    setOffers(((o ?? []) as unknown as TripOffer[]).filter((x) =>
      new Date(x.travel_date) >= new Date(new Date().toDateString()) && !startsHere(x.origin) && !startsHere(x.origin_ur)))
    setMyOffers((mo ?? []) as unknown as MyFareOffer[])
    setMyBookings((mb ?? []) as unknown as MyTripBooking[])
  }

  const reloadMine = async () => {
    const [tripShare, hourly, equipment, ride, shadi, cityPurchase] = await Promise.all([
      supabase.from('vehicle_trip_bookings').select('id, total_amount_pkr, status, created_at, vehicle_trip_offers(origin, origin_ur, destination, destination_ur)').order('created_at', { ascending: false }).limit(20),
      supabase.rpc('my_hourly_bookings'),
      supabase.rpc('my_equipment_bookings'),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, travel_date, vehicle_routes(origin, origin_ur, destination, destination_ur)').order('created_at', { ascending: false }).limit(20),
      supabase.rpc('my_shadi_events'),
      supabase.rpc('my_city_purchase_requests'),
    ])

    const out: BookingRow[] = []
    for (const b of (tripShare.data ?? []) as unknown as MyTripBooking[]) {
      const vto = b.vehicle_trip_offers
      out.push({ id: `trip-${b.id}`, title: t('cm.tripsPageTitle'), subtitle: vto ? `${isUrdu && vto.origin_ur ? vto.origin_ur : vto.origin} → ${isUrdu && vto.destination_ur ? vto.destination_ur : vto.destination}` : '—', amount: b.total_amount_pkr, status: mapStatus(b.status), date: vto?.travel_date ?? '', href: b.status === 'confirmed' ? `/portal/marketplace/trip/${b.id}` : null })
    }
    for (const b of (hourly.data ?? []) as Array<{ id: string; model: string | null; vehicle_type: string; total_amount_pkr: number | null; base_amount_pkr: number; status: string; requested_at: string }>) {
      out.push({ id: `hourly-${b.id}`, title: t('vp.hourlyPageTitle'), subtitle: b.model || b.vehicle_type, amount: b.total_amount_pkr ?? b.base_amount_pkr, status: mapStatus(b.status), date: b.requested_at, href: null })
    }
    for (const b of (equipment.data ?? []) as Array<{ id: string; kind: string; model: string | null; vehicle_type: string; total_amount_pkr: number | null; rate_pkr: number; status: string; requested_at: string }>) {
      out.push({ id: `equip-${b.id}`, title: t(`vp.${b.kind}PageTitle`), subtitle: b.model || b.vehicle_type, amount: b.total_amount_pkr ?? b.rate_pkr, status: mapStatus(b.status), date: b.requested_at, href: null })
    }
    for (const b of (ride.data ?? []) as unknown as Array<{ id: string; status: string; total_amount_pkr: number; travel_date: string; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null }>) {
      const vr = b.vehicle_routes
      out.push({ id: `ride-${b.id}`, title: t('af.addaBoardPageTitle'), subtitle: vr ? `${isUrdu && vr.origin_ur ? vr.origin_ur : vr.origin} → ${isUrdu && vr.destination_ur ? vr.destination_ur : vr.destination}` : '—', amount: b.total_amount_pkr, status: mapStatus(b.status), date: b.travel_date, href: null })
    }
    for (const e of (shadi.data ?? []) as Array<{ id: string; event_date: string; venue_address: string; status: string; advance_amount_pkr: number | null; created_at: string }>) {
      out.push({ id: `shadi-${e.id}`, title: t('vp.shadiPageTitle'), subtitle: e.venue_address, amount: e.advance_amount_pkr, status: mapStatus(e.status), date: e.event_date || e.created_at, href: null })
    }
    for (const r of (cityPurchase.data ?? []) as Array<{ id: string; item: string; status: string; total_fare_pkr: number | null; created_at: string; city_name: string; city_name_ur: string | null }>) {
      out.push({ id: `cp-${r.id}`, title: t('vp.cityPurchasePageTitle'), subtitle: `${r.item} · ${isUrdu && r.city_name_ur ? r.city_name_ur : r.city_name}`, amount: r.total_fare_pkr, status: mapStatus(r.status), date: r.created_at, href: null })
    }

    out.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    setRows(out)
  }

  useEffect(() => {
    if (!user) return
    Promise.all([reloadBrowse(), reloadMine()]).then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    const withDistance = offers.filter((o) => o.distance_km != null && !(o.id in bandByTrip))
    if (withDistance.length === 0) return
    Promise.all(withDistance.map((o) => supabase.rpc('fare_band_for', { p_flow: 'trip_share', p_km: o.distance_km }).then(({ data }) => [o.id, data] as const)))
      .then((pairs) => setBandByTrip((prev) => ({ ...prev, ...Object.fromEntries(pairs) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offers])

  const propose = async (tripId: string) => {
    const seats = seatsForm[tripId] ?? 1
    const fare = fareForm[tripId]
    if (!fare || fare <= 0) { toast.error(t('cm.enterFareOffer')); return }
    setProposing(tripId)
    const { error } = await supabase.rpc('propose_trip_fare', { p_trip_offer_id: tripId, p_seats_requested: seats, p_proposed_fare_per_seat_pkr: fare })
    setProposing(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.fareOfferSentToast'))
    reloadBrowse()
  }
  const acceptCounter = async (fareOfferId: string) => {
    setActionId(fareOfferId)
    const { error } = await supabase.rpc('accept_trip_fare_counter', { p_fare_offer_id: fareOfferId })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('cm.fareAcceptedToast'))
    reloadBrowse()
  }
  const withdraw = async (fareOfferId: string) => {
    setActionId(fareOfferId)
    const { error } = await supabase.rpc('withdraw_trip_fare_offer', { p_fare_offer_id: fareOfferId })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    reloadBrowse()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Receipt size={19} /> {t('cm.tripsPageTitle')}</h1>

      <div className="flex items-center gap-1 bg-white border border-[#e5e2d0] rounded-full p-1 w-fit">
        <button onClick={() => setTab('mine')} className="px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'mine' ? '#166534' : 'transparent', color: tab === 'mine' ? '#fff' : '#64748b' }}>{t('vp.myBookingsTab')}</button>
        <button onClick={() => setTab('browse')} className="px-4 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer" style={{ background: tab === 'browse' ? '#166534' : 'transparent', color: tab === 'browse' ? '#fff' : '#64748b' }}>{t('cm.openTripsHeading')}</button>
      </div>

      {tab === 'mine' ? (
        <div className="flex flex-col gap-2">
          {(rows?.length ?? 0) === 0 && <p className="text-center py-10 text-[#94a3b8] text-[13.5px]">{t('vp.noEquipmentBookingsHint')}</p>}
          {rows?.map((r) => {
            const style = STATUS_STYLE[r.status]
            const content = (
              <>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-bold text-[#1e293b] truncate">{r.title}</p>
                  <p className="text-[12px] text-[#64748b] truncate mt-0.5">{r.subtitle}</p>
                </div>
                <div className="shrink-0 text-end">
                  {r.amount != null && <p className="text-[13.5px] font-extrabold text-[#005A36] ltr-num">{fmt(r.amount)}</p>}
                  <span className="text-[9.5px] font-bold px-2 py-0.5 rounded-full" style={{ background: style.bg, color: style.fg }}>{t(`vp.equipmentStatus.${r.status === 'confirmed' ? 'accepted' : r.status === 'pending' ? 'requested' : r.status}`)}</span>
                </div>
              </>
            )
            return r.href ? (
              <Link key={r.id} href={r.href} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center justify-between gap-3">{content}</Link>
            ) : (
              <div key={r.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3 flex items-center justify-between gap-3">{content}</div>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {(myOffers.length > 0 || myBookings.length > 0) && (
            <div className="flex flex-col gap-2">
              {myOffers.map((fo) => (
                <div key={fo.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3">
                  <p className="text-[13px] font-bold text-[#1e293b]">{fo.vehicle_trip_offers ? `${isUrdu && fo.vehicle_trip_offers.origin_ur ? fo.vehicle_trip_offers.origin_ur : fo.vehicle_trip_offers.origin} → ${isUrdu && fo.vehicle_trip_offers.destination_ur ? fo.vehicle_trip_offers.destination_ur : fo.vehicle_trip_offers.destination}` : '—'}</p>
                  <p className="text-[12px] text-[#64748b] mt-0.5">{t('cm.yourOffer')} {fmt(fo.proposed_fare_per_seat_pkr)}/{t('mk.seatsLabel')} × <span className="ltr-num">{fo.seats_requested}</span></p>
                  {fo.status === 'pending' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold mt-1"><Clock size={11} /> {t('cm.awaitingDriverStatus')}</span>}
                  {fo.status === 'countered' && (
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
                      <p className="text-[12px] text-[#1e293b]">{t('cm.driverCountered')} <span className="font-bold text-[#166534]">{fmt(fo.counter_fare_per_seat_pkr ?? 0)}</span>/{t('mk.seatsLabel')}</p>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <button onClick={() => withdraw(fo.id)} disabled={actionId === fo.id} className="px-2.5 py-1 rounded-lg text-[11.5px] font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b] disabled:opacity-50">{t('cm.declineBtn')}</button>
                        <button onClick={() => acceptCounter(fo.id)} disabled={actionId === fo.id} className="px-2.5 py-1 rounded-lg text-[11.5px] font-semibold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{t('cm.acceptBtn')}</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {myBookings.map((tb) => (
                <div key={tb.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[13px] font-bold text-[#1e293b]">{tb.vehicle_trip_offers ? `${isUrdu && tb.vehicle_trip_offers.origin_ur ? tb.vehicle_trip_offers.origin_ur : tb.vehicle_trip_offers.origin} → ${isUrdu && tb.vehicle_trip_offers.destination_ur ? tb.vehicle_trip_offers.destination_ur : tb.vehicle_trip_offers.destination}` : '—'}</p>
                    <p className="text-[13px] font-extrabold text-[#166534]">{fmt(tb.total_amount_pkr)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    {tb.status === 'completed' ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('cm.tripCompletedStatus')}</span>
                    ) : tb.status === 'confirmed' ? (
                      <Link href={`/portal/marketplace/trip/${tb.id}`} className="inline-flex items-center gap-1 text-[#166534] text-[12px] font-semibold"><Navigation size={12} /> {t('cm.trackLocationBtn')}</Link>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-600 text-[11px] font-bold"><XCircle size={11} /> {tb.status}</span>
                    )}
                    {(tb.status === 'completed' || tb.status === 'confirmed') && <ReportProblemButton refType="trip_offer" refId={tb.trip_offer_id} kindOptions={['fare_dispute', 'no_show']} />}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] mb-2">{t('cm.openTripsHeading')}</p>
            {offers.length === 0 && <p className="text-[13px] text-[#94a3b8]">{t('cm.noOpenTrips')}</p>}
            <div className="flex flex-col gap-2.5">
              {offers.map((o) => (
                <div key={o.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[14px] font-bold text-[#1e293b] flex items-center gap-1.5"><MapPin size={13} className="text-[#166534] shrink-0" /> {isUrdu && o.origin_ur ? o.origin_ur : o.origin} → {isUrdu && o.destination_ur ? o.destination_ur : o.destination}</p>
                    <span className="shrink-0 text-[9.5px] font-bold uppercase px-2 py-0.5 rounded-full" style={{ background: o.trip_type === 'return' ? '#f3e8ff' : '#e0f2fe', color: o.trip_type === 'return' ? '#6d28d9' : '#0369a1' }}>{o.trip_type === 'return' ? t('cm.tripTypeReturn') : t('cm.tripTypeOneway')}</span>
                  </div>
                  <p className="text-[12px] text-[#64748b] mt-1">{o.vehicles?.owner_name} · {o.vehicles?.vehicle_type} · {new Date(o.travel_date).toLocaleDateString('en-GB')}{o.departure_time_estimate ? ` · ${o.departure_time_estimate.slice(0, 5)}` : ''}</p>
                  <p className="text-[13px] font-bold text-[#166534] mt-1">{fmt(o.listed_fare_per_seat_pkr)} <span className="font-normal text-[#64748b] text-[11px]">{t('cm.askingPerSeat')}</span> · <span className="font-normal text-[#64748b] text-[11px] ltr-num">{o.seats_available} {t('mk.seatsLabel')}</span></p>

                  {bandByTrip[o.id] && <FareBandPicker band={bandByTrip[o.id]} value={fareForm[o.id] ?? ''} onChange={(v) => setFareForm({ ...fareForm, [o.id]: v })} ownerLabel={t('cm.yourFareLabel')} />}
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#f1f5f9]">
                    <input type="number" min={1} max={o.seats_available} value={seatsForm[o.id] ?? 1} onChange={(e) => setSeatsForm({ ...seatsForm, [o.id]: +e.target.value })} className="w-16 border border-[#e2e8f0] rounded-xl px-2 py-2 text-[13px]" />
                    <input type="number" value={fareForm[o.id] ?? ''} onChange={(e) => setFareForm({ ...fareForm, [o.id]: +e.target.value })} placeholder={t('cm.yourFareOfferPlaceholder')} className="flex-1 border border-[#e2e8f0] rounded-xl px-2 py-2 text-[13px]" />
                    <button onClick={() => propose(o.id)} disabled={proposing === o.id} className="shrink-0 px-3 py-2 bg-[#166534] text-white rounded-xl text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">{t('cm.proposeFareBtn')}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
