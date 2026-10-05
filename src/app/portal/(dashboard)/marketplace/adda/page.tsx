'use client'

// Rider-facing adda board — the live turn-based departure queue for the
// two (or more, in future) fixed stands, not a scheduled route. A
// direction toggle between the adda and its pair stand doubles as the
// "select destination / departure" control the whole feature only ever
// needed exactly two stands for. Booking reuses the two mechanisms the
// rest of the marketplace already has: a fixed-fare seat (book_adda_seat,
// mirrors place_ride_booking) or a ride-request fare proposal
// (propose_trip_fare, migration 400, completely untouched).

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, MapPin, Phone, Timer, Trophy, Users, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarketplaceBottomNav } from '@/components/portal/MarketplaceBottomNav'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Adda { id: string; name: string; name_ur: string | null; lat: number | null; lng: number | null; turn_minutes: number }
interface AddaBoardEntry {
  entry_id: string; status: string; position: number
  turn_started_at: string | null; turn_expires_at: string | null
  seats_total: number; seats_available: number; fare_mode: string; fixed_fare_per_seat_pkr: number | null; trip_offer_id: string | null
  vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; vehicle_number: string | null
}
interface AddaBoard { adda: Adda; pair_adda: Adda | null; entries: AddaBoardEntry[] }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function AddaBoardPage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>}>
      <AddaBoardPageInner />
    </Suspense>
  )
}

function AddaBoardPageInner() {
  const { t, isUrdu } = useLocale()
  const { user } = usePortalUser()
  const supabase = createClient()
  const searchParams = useSearchParams()
  // Deep-linked from the "Going Home" nearby page — jump straight to
  // whichever adda the rider was actually near, instead of always
  // defaulting to the alphabetically-first one.
  const preselectAddaId = searchParams.get('adda')

  const [addas, setAddas] = useState<Adda[]>([])
  const [activeAddaId, setActiveAddaId] = useState<string | null>(null)
  const [board, setBoard] = useState<AddaBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [bookingSeats, setBookingSeats] = useState<Record<string, number>>({})
  const [requestFare, setRequestFare] = useState<Record<string, number>>({})
  const [actionId, setActionId] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('addas').select('id, name, name_ur, lat, lng, turn_minutes').eq('is_active', true).order('name').then(({ data }) => {
      setAddas(data ?? [])
      const preselected = preselectAddaId && data?.some((a) => a.id === preselectAddaId) ? preselectAddaId : null
      if (preselected) setActiveAddaId(preselected)
      else if (data && data.length > 0) setActiveAddaId(data[0].id)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadBoard = async (addaId: string) => {
    const { data } = await supabase.rpc('adda_board', { p_adda_id: addaId })
    if (data) setBoard(data)
  }
  useEffect(() => { if (activeAddaId) loadBoard(activeAddaId) }, [activeAddaId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeAddaId) return
    const iv = setInterval(() => loadBoard(activeAddaId), 15000)
    return () => clearInterval(iv)
  }, [activeAddaId])
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  const secondsLeft = (expiresAt: string | null) => expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000)) : null
  const fmtCountdown = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

  const bookFixed = async (entry: AddaBoardEntry) => {
    const seats = bookingSeats[entry.entry_id] || 1
    setActionId(entry.entry_id)
    const { error } = await supabase.rpc('book_adda_seat', { p_entry_id: entry.entry_id, p_seats: seats, p_method: 'direct', p_proof_url: null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.seatBookedToast'))
    if (activeAddaId) loadBoard(activeAddaId)
  }
  const proposeRequest = async (entry: AddaBoardEntry) => {
    if (!entry.trip_offer_id) return
    const seats = bookingSeats[entry.entry_id] || 1
    const fare = requestFare[entry.entry_id]
    if (!fare) { toast.error(t('af.enterFareFirst')); return }
    setActionId(entry.entry_id)
    const { error } = await supabase.rpc('propose_trip_fare', { p_trip_offer_id: entry.trip_offer_id, p_seats_requested: seats, p_proposed_fare_per_seat_pkr: fare })
    setActionId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('af.fareProposedToast'))
  }

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>
  if (addas.length === 0) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('af.noAddasYet')}</div>

  const current = board?.entries.find((e) => e.status === 'current')
  const waiting = board?.entries.filter((e) => e.status === 'waiting').sort((a, b) => a.position - b.position) ?? []
  const currentSecs = current ? secondsLeft(current.turn_expires_at) : null

  // Every active adda gets a pin now, not just the current one and its
  // pair — the tab row below lets a rider jump to any of them, so the
  // map should show where they all are, not just the two the old
  // pair-direction toggle knew about.
  const pins = addas
    .filter((a) => a.lat != null && a.lng != null)
    .map((a) => ({
      lat: a.lat!, lng: a.lng!,
      label: isUrdu && a.name_ur ? a.name_ur : a.name,
      color: a.id === activeAddaId ? '#16a34a' : '#7c3aed',
    }))

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <Link href="/portal/marketplace" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3"><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.backToMarketplace')}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-1 flex items-center gap-2">{t('af.addaBoardPageTitle')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('af.addaBoardHint')}</p>

      {/* Every active adda, not just the current one's paired stand —
          replaces the old single swap-direction button, which could only
          ever jump between two specific addas regardless of how many
          exist. Scales to any number of stands without a second switcher. */}
      {addas.length > 1 && (
        <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
          {addas.map((a) => {
            const active = a.id === activeAddaId
            return (
              <button key={a.id} onClick={() => setActiveAddaId(a.id)}
                className={`shrink-0 px-3.5 py-2 rounded-full font-sans text-[12.5px] font-bold cursor-pointer transition-colors ${active ? 'bg-dp-secondary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface hover:bg-dp-surface-container'}`}>
                🚏 {isUrdu && a.name_ur ? a.name_ur : a.name}
              </button>
            )
          })}
        </div>
      )}

      {pins.length > 0 && <LeafletMap pins={pins} height={220} className="mb-4 rounded-lg" />}

      <div className="mb-2">
        {current ? (
          <div className="bg-dp-secondary-container/30 border border-dp-secondary/30 rounded-lg p-3.5 mb-3">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-sans text-[13.5px] font-bold text-dp-secondary"><Trophy size={14} /> {t('af.nextToLeaveLabel')}</span>
              {currentSecs != null && <span className="inline-flex items-center gap-1 font-sans text-[13px] font-bold text-dp-secondary ltr-num"><Timer size={13} /> {fmtCountdown(currentSecs)}</span>}
            </div>
            <p className="font-sans text-[14px] font-bold text-dp-on-surface mt-1.5">{current.owner_name}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant">{current.vehicle_type}{current.vehicle_number ? ` · ${current.vehicle_number}` : ''}</p>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><Users size={12} /> {current.seats_available}/{current.seats_total} {t('mk.seatsLabel')} {t('af.stillFree')}</p>
            {current.owner_mobile && <a href={`tel:${current.owner_mobile}`} className="inline-flex items-center gap-1 font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline mt-1 ltr-num" dir="ltr"><Phone size={12} /> {current.owner_mobile}</a>}

            {current.seats_available > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t border-dp-outline-variant/40">
                <input type="number" min={1} max={current.seats_available} value={bookingSeats[current.entry_id] ?? 1}
                  onChange={(e) => setBookingSeats((s) => ({ ...s, [current.entry_id]: +e.target.value }))} className="input-field !w-16 !py-1.5" />
                {current.fare_mode === 'fixed' ? (
                  <button onClick={() => bookFixed(current)} disabled={actionId === current.entry_id}
                    className="flex items-center gap-1 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
                    {actionId === current.entry_id ? <Loader2 size={13} className="animate-spin" /> : null} {t('af.bookSeatBtn')} — {fmt(current.fixed_fare_per_seat_pkr ?? 0)}/{t('mk.seatsLabel')}
                  </button>
                ) : (
                  <>
                    <input type="number" value={requestFare[current.entry_id] ?? ''} onChange={(e) => setRequestFare((s) => ({ ...s, [current.entry_id]: +e.target.value }))} placeholder={t('cm.counterPlaceholder')} className="input-field !w-24 !py-1.5" />
                    <button onClick={() => proposeRequest(current)} disabled={actionId === current.entry_id}
                      className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('af.proposeFareBtn')}</button>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-center py-6 text-dp-on-surface-variant font-sans text-[13.5px]">{t('af.noCurrentVehicle')}</p>
        )}

        {waiting.length > 0 && (
          <>
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2 flex items-center gap-1.5"><MapPin size={12} /> {t('af.waitingListHeading').replace('{n}', String(waiting.length))}</p>
            <div className="space-y-1.5">
              {waiting.map((e) => (
                <div key={e.entry_id} className="flex items-center justify-between gap-2 bg-white border border-dp-outline-variant rounded-lg px-3 py-2">
                  <span className="font-sans text-[12.5px] text-dp-on-surface truncate">#{e.position} {e.owner_name} · {e.vehicle_type}{e.vehicle_number ? ` · ${e.vehicle_number}` : ''}</span>
                  <span className="shrink-0 font-sans text-[11.5px] font-bold text-dp-on-surface-variant">{e.fare_mode === 'fixed' ? fmt(e.fixed_fare_per_seat_pkr ?? 0) : t('af.rideRequestMode')}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <MarketplaceBottomNav />
    </div>
  )
}
