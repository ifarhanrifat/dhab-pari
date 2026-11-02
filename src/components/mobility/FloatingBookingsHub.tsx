'use client'

// Real ask, 2026-11-02: "there would be not whatsapp button for the
// vehicle screens, also the new floating buttons which appeared after
// the bookings must be adjusted... make it one button where will be
// appearing the numbers of booking on it and when we click on that
// then the list will appear... along with the remaining time of
// travel if the ride is scheduled or shared."
//
// Replaces the two separate floating widgets that used to compete for
// the same corner — OngoingRideFab (today's single live trip) and
// ActiveRequestsDock (every pending request) — with one button in one
// spot. One item: tapping it opens that item's own flow directly, same
// as before. Two or more: the button carries a count badge and opens a
// list popup of everything, each row still opening its own existing
// flow unchanged. A scheduled/shared seat booking that has a real
// departure time (vehicle_routes.departure_time + the booking's
// travel_date) gets a live countdown pill on its row; anything without
// a real target time keeps its plain status text instead of a fake
// countdown.
//
// The WhatsApp floating button living on top of this corner (see
// FloatingWhatsAppButton's own pathname check) is turned off on these
// same vehicle/marketplace screens so this is the only floating control
// a driver or rider sees here.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { vehicleDisplayName } from '@/lib/vehicleDisplayName'
import { RequestWaitingSheet, type WaitingKind, type WaitingSummary } from '@/components/mobility/RequestWaitingSheet'
import { RideLifecycleSheet } from '@/components/portal/RideLifecycleSheet'

type ItemState = 'ongoing' | 'searching' | 'action' | 'waiting'

interface HubItem {
  key: string
  emoji: string
  label: string
  state: ItemState
  since: string
  countdownTarget?: number // epoch ms — only set when a real scheduled time is known
  sheet?: { kind: WaitingKind; id: string; summary: WaitingSummary; viewHref: string }
  rideSheetBookingId?: string // ongoing ride-dispatch: opens RideLifecycleSheet directly
  href?: string
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [enabled])
  return now
}

function Countdown({ target, now, label }: { target: number; now: number; label: string }) {
  const diff = Math.max(0, Math.round((target - now) / 1000))
  const past = target <= now
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  const text = past ? label : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-sans text-[10.5px] font-bold ltr-num shrink-0 ${past ? 'bg-[#dcfce7] text-[#166534]' : 'bg-[#fff7ed] text-[#c2410c]'}`}>
      {!past && <span className="w-1.5 h-1.5 rounded-full bg-[#f97316] animate-pulse" />}
      {text}
    </span>
  )
}

export function FloatingBookingsHub() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const router = useRouter()
  const [items, setItems] = useState<HubItem[]>([])
  const [openSheet, setOpenSheet] = useState<HubItem['sheet'] | null>(null)
  const [openRideSheetId, setOpenRideSheetId] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [ongoing, hourly, rental, equipment, seats, rides, purchases] = await Promise.all([
      supabase.rpc('my_ongoing_ride'),
      supabase.rpc('my_hourly_bookings'),
      supabase.rpc('my_rental_bookings'),
      supabase.rpc('my_equipment_bookings'),
      supabase.from('ride_bookings').select('id, seats, travel_date, total_amount_pkr, created_at, vehicle_routes(origin, origin_ur, destination, destination_ur, departure_time), adda_queue_entries(addas(name, name_ur))').eq('portal_user_id', user!.id).eq('status', 'announced'),
      supabase.from('ride_dispatch_requests').select('id, pickup_label, dropoff_label, fare_pkr, created_at').eq('initiator_portal_user_id', user!.id).eq('status', 'open'),
      supabase.rpc('my_city_purchase_requests'),
    ])
    const out: HubItem[] = []
    const nm = (en: string | null | undefined, ur: string | null | undefined) => (isUrdu && ur ? ur : en) ?? ''

    const o = ongoing.data as { role: 'driver' | 'rider'; label: string; link: string; booking_id: string | null; is_ride_dispatch: boolean } | null
    if (o) {
      out.push({
        key: 'ongoing', emoji: '🧭', label: o.label, state: 'ongoing', since: new Date().toISOString(),
        ...(o.is_ride_dispatch && o.booking_id ? { rideSheetBookingId: o.booking_id } : { href: o.link }),
      })
    }

    for (const b of (hourly.data ?? []) as { id: string; status: string; hours: number; pickup_address: string; base_amount_pkr: number; total_amount_pkr: number | null; requested_at: string; owner_name: string; vehicle_type: string; model: string | null }[]) {
      if (b.status !== 'requested') continue
      out.push({ key: `h-${b.id}`, emoji: '⏱️', label: `${t('rq.kind.hourly')} · ${vehicleDisplayName(b.vehicle_type, b.model)}`, state: 'searching', since: b.requested_at,
        sheet: { kind: 'hourly', id: b.id, viewHref: '/portal/marketplace/hourly', summary: { vehicleLabel: vehicleDisplayName(b.vehicle_type, b.model), driverName: b.owner_name, from: b.pickup_address, amount: b.total_amount_pkr ?? b.base_amount_pkr, facts: [t('rw.hours').replace('{n}', String(b.hours))] } } })
    }
    for (const b of (rental.data ?? []) as { id: string; status: string; from_address: string; to_address: string; total_amount_pkr: number; requested_at: string; owner_name: string; vehicle_type: string; model: string | null }[]) {
      if (b.status !== 'requested') continue
      out.push({ key: `r-${b.id}`, emoji: '🚗', label: `${t('rq.kind.rental')} · ${b.to_address}`, state: 'searching', since: b.requested_at,
        sheet: { kind: 'rental', id: b.id, viewHref: '/portal/marketplace/rental', summary: { vehicleLabel: vehicleDisplayName(b.vehicle_type, b.model), driverName: b.owner_name, from: b.from_address, to: b.to_address, amount: b.total_amount_pkr } } })
    }
    for (const b of (equipment.data ?? []) as { id: string; kind: 'machinery' | 'tractor' | 'loader'; status: string; site_address: string; rate_pkr: number; total_amount_pkr: number | null; requested_at: string; owner_name: string; vehicle_type: string; model: string | null; advance_status?: string }[]) {
      const payAdvance = b.status === 'accepted' && ['due', 'rejected'].includes(b.advance_status ?? '')
      if (b.status !== 'requested' && !payAdvance) continue
      out.push({ key: `e-${b.id}`, emoji: b.kind === 'tractor' ? '🚜' : b.kind === 'loader' ? '🚚' : '🏗️', label: `${t(`rq.kind.equipment.${b.kind}`)} · ${payAdvance ? t('eqa.payBtn') : b.site_address}`,
        state: payAdvance ? 'action' : 'searching', since: b.requested_at,
        sheet: { kind: 'equipment', id: b.id, viewHref: `/portal/marketplace/${b.kind}`, summary: { vehicleLabel: vehicleDisplayName(b.vehicle_type, b.model), driverName: b.owner_name, from: b.site_address, amount: b.total_amount_pkr ?? b.rate_pkr } } })
    }
    for (const b of (seats.data ?? []) as unknown as { id: string; seats: number; travel_date: string; total_amount_pkr: number; created_at: string; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null; departure_time: string | null } | null; adda_queue_entries: { addas: { name: string; name_ur: string | null } | null } | null }[]) {
      const r = b.vehicle_routes
      const adda = b.adda_queue_entries?.addas
      const title = r ? `${nm(r.origin, r.origin_ur)} → ${nm(r.destination, r.destination_ur)}` : nm(adda?.name, adda?.name_ur)
      // A fixed route has a real scheduled clock time to count down to; an
      // adda (turn-based queue) has no fixed departure, so it keeps its
      // plain "waiting" status instead of a fabricated countdown.
      const countdownTarget = r?.departure_time ? new Date(`${b.travel_date}T${r.departure_time}+05:00`).getTime() : undefined
      out.push({ key: `s-${b.id}`, emoji: '🚌', label: `${t('rq.kind.route')} · ${title}`, state: 'waiting', since: b.created_at, countdownTarget,
        sheet: { kind: 'seat', id: b.id, viewHref: '/portal/marketplace/trips', summary: { vehicleLabel: title, from: r ? nm(r.origin, r.origin_ur) : nm(adda?.name, adda?.name_ur), to: r ? nm(r.destination, r.destination_ur) : null, amount: b.total_amount_pkr, facts: [b.travel_date, t('rw.seats').replace('{n}', String(b.seats))] } } })
    }
    for (const d of (rides.data ?? []) as { id: string; pickup_label: string; dropoff_label: string; fare_pkr: number; created_at: string }[]) {
      out.push({ key: `d-${d.id}`, emoji: '🚕', label: `${t('rq.kind.ride_dispatch')} · ${d.dropoff_label}`, state: 'searching', since: d.created_at, href: `/portal/marketplace/ride-dispatch/${d.id}` })
    }
    for (const c of (purchases.data ?? []) as { id: string; item: string; status: string; created_at: string; as_role: string }[]) {
      if (c.as_role !== 'user' || !['ringing', 'no_answer', 'priced'].includes(c.status)) continue
      out.push({ key: `c-${c.id}`, emoji: '🛍️', label: `${t('rq.kind.city_purchase')} · ${c.item}`, state: c.status === 'priced' ? 'action' : c.status === 'no_answer' ? 'waiting' : 'searching',
        since: c.created_at, href: `/portal/marketplace/city-purchase/${c.id}` })
    }
    // Live-now first, then needs-you, then newest.
    out.sort((a, b) =>
      (a.state === 'ongoing' ? 0 : 1) - (b.state === 'ongoing' ? 0 : 1) ||
      (a.state === 'action' ? 0 : 1) - (b.state === 'action' ? 0 : 1) ||
      b.since.localeCompare(a.since))
    setItems(out)
  }, [user, t, isUrdu])

  useEffect(() => {
    if (!user) return
    let live = true
    const run = () => { if (live) load() }
    const first = setTimeout(run, 0)
    const iv = setInterval(run, 20000)
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { live = false; clearTimeout(first); clearInterval(iv); document.removeEventListener('visibilitychange', onVisible) }
  }, [user, load])

  const hasCountdown = useMemo(() => items.some((i) => i.countdownTarget != null), [items])
  const now = useNow(hasCountdown)

  const openItem = (it: HubItem) => {
    setListOpen(false)
    if (it.rideSheetBookingId) setOpenRideSheetId(it.rideSheetBookingId)
    else if (it.sheet) setOpenSheet(it.sheet)
    else if (it.href) router.push(it.href)
  }

  const renderSheet = () => {
    if (openRideSheetId) return <RideLifecycleSheet bookingId={openRideSheetId} onClose={() => { setOpenRideSheetId(null); load() }} />
    if (!openSheet) return null
    return (
      <RequestWaitingSheet kind={openSheet.kind} bookingId={openSheet.id} summary={openSheet.summary}
        onClose={() => { setOpenSheet(null); load() }}
        onViewBooking={() => { const href = openSheet.viewHref; setOpenSheet(null); router.push(href) }} />
    )
  }

  if (!user || items.length === 0) return renderSheet()

  const badgeColor = (s: ItemState) => (s === 'ongoing' ? '#166534' : s === 'action' ? '#f59e0b' : '#16a34a')
  const dotBg = (s: ItemState) => (s === 'ongoing' ? '#dcfce7' : s === 'action' ? '#fef3c7' : '#dcfce7')

  const Row = ({ it }: { it: HubItem }) => (
    <button onClick={() => openItem(it)}
      className="w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl bg-white border border-[#e8eaee] active:scale-[0.98] transition-transform cursor-pointer text-start">
      <span className="relative shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-[18px]" style={{ background: dotBg(it.state) }}>
        {(it.state === 'searching' || it.state === 'ongoing') && <span className="absolute inset-0 rounded-full border-2 animate-ping [animation-duration:2s]" style={{ borderColor: `${badgeColor(it.state)}80` }} />}
        {it.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[9.5px] font-bold uppercase tracking-[0.04em] leading-none" style={{ color: badgeColor(it.state) }}>
          {it.state === 'ongoing' ? t('cm.ongoingFabRiderLabel') : t(`dock.state.${it.state}`)}
        </span>
        <span className="block font-sans text-[13px] font-semibold text-[#0f172a] truncate leading-tight mt-0.5"><bdi>{it.label}</bdi></span>
      </span>
      {it.countdownTarget != null && <Countdown target={it.countdownTarget} now={now} label={t('dock.departed') || 'Departed'} />}
      {it.state === 'action' && it.countdownTarget == null && <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b] shrink-0" />}
    </button>
  )

  const total = items.length
  const primary = items[0]

  return (
    <>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="fixed z-[70] bottom-[90px] right-4 md:bottom-6 md:right-6 print:hidden">
        <button
          onClick={() => (total === 1 ? openItem(primary) : setListOpen(true))}
          className="relative flex items-center gap-2 pl-3 pr-4 h-12 rounded-full text-white shadow-lg hover:scale-105 active:scale-95 transition-all max-w-[230px]"
          style={{ background: primary.state === 'ongoing' ? '#166534' : '#0f172a' }}>
          <span className="shrink-0 w-6 h-6 rounded-full bg-white/15 flex items-center justify-center text-[14px]">{primary.emoji}</span>
          <span className="min-w-0 text-start">
            <span className="block font-sans text-[10px] font-bold uppercase tracking-[0.05em] text-white/70 leading-none">
              {total > 1 ? t('dock.multipleLabel').replace('{n}', String(total)) : (primary.state === 'ongoing' ? t('cm.ongoingFabRiderLabel') : t(`dock.state.${primary.state}`))}
            </span>
            <span className="block font-sans text-[12px] font-bold truncate leading-tight mt-0.5">{primary.label}</span>
          </span>
          {total > 1 && (
            <span className="absolute -top-1.5 -end-1.5 min-w-[22px] h-[22px] px-1 rounded-full bg-[#f59e0b] text-[#0f172a] font-sans text-[11px] font-black flex items-center justify-center shadow-md ltr-num border-2 border-white">
              {total}
            </span>
          )}
        </button>
      </div>

      {listOpen && (
        <div className="fixed inset-0 bg-black/55 z-[100] flex items-end sm:items-center justify-center animate-in fade-in duration-200" onClick={() => setListOpen(false)}>
          <div dir={isUrdu ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}
            className="bg-[#f8fafc] w-full sm:max-w-[420px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[85vh] shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 duration-300 flex flex-col">
            <div className="px-5 pt-5 pb-3 flex items-center justify-between shrink-0">
              <p className="font-sans text-[16px] font-extrabold text-[#0f172a]">{t('dock.listTitle').replace('{n}', String(total))}</p>
              <button onClick={() => setListOpen(false)} aria-label="Close" className="w-8 h-8 rounded-full bg-[#e2e8f0] flex items-center justify-center cursor-pointer">
                <ChevronDown size={16} />
              </button>
            </div>
            <div className="px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-2 overflow-y-auto">
              {items.map((it) => <Row key={it.key} it={it} />)}
            </div>
          </div>
        </div>
      )}

      {renderSheet()}
    </>
  )
}
