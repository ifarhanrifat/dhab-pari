'use client'

// Adda check-in & turn — its own screen, matching the design zip (this
// used to be a section embedded on the driver dashboard, moved out per
// direct instruction). Also adds "THE QUEUE" — the zip's full ordered
// list of every vehicle waiting at this adda, which the embedded version
// never rendered (it only ever showed "you're at position N" plus the
// current server's own countdown).
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Home screen's quick link.

import { useEffect, useState } from 'react'
import { MapPin, Signpost, LogOut, SkipForward, Timer, Trophy, Pencil, ListOrdered } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getCurrentPositionOnce, classifyLocationError, type LocationErrorReason } from '@/hooks/useLiveLocation'
import { LocationSettingsModal } from '@/components/portal/LocationSettingsModal'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Adda { id: string; name: string; name_ur: string | null; pair_adda_id: string | null; fixed_fare_per_seat_pkr: number | null }
interface AddaBoardEntry {
  entry_id: string; status: string; position: number
  turn_started_at: string | null; turn_expires_at: string | null
  seats_total: number; seats_available: number; fare_mode: string; fixed_fare_per_seat_pkr: number | null
  vehicle_id: string; owner_name: string
}
interface AddaBoard { adda: Adda; pair_adda: Adda | null; entries: AddaBoardEntry[] }

const inputCls = 'dp2-input'

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleAddaPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<{ id: string; is_online: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [rideEligible, setRideEligible] = useState(true)

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

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, is_online').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) {
        await reloadAdda(data.id)
        const [{ data: sc }, { data: offers }] = await Promise.all([
          supabase.from('service_classes').select('id, ride_eligible').eq('is_active', true),
          supabase.from('vehicle_service_offers').select('service_class_id').eq('vehicle_id', data.id).eq('is_active', true),
        ])
        const mine = new Set((offers ?? []).map((o) => o.service_class_id))
        const myClasses = (sc ?? []).filter((c) => mine.has(c.id))
        setRideEligible(myClasses.length === 0 || myClasses.some((c) => c.ride_eligible))
      }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const secondsLeft = (expiresAt: string | null) => expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000)) : null
  const fmtCountdown = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

  const doAddaCheckIn = async () => {
    if (!vehicle || !checkInAddaId) { toast.error(t('af.pickAddaFirst')); return }
    setAddaActionLoading(true)
    setCheckingLocation(true)
    let lat: number | null = null; let lng: number | null = null
    try {
      const pos = await getCurrentPositionOnce()
      lat = pos.lat; lng = pos.lng
    } catch (err) {
      const reason = classifyLocationError(err)
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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return null

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Signpost size={19} /> {t('af.atTheAddaHeading')}</h1>

      {!myEntry && !rideEligible ? (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3.5">
          <p className="font-sans text-[13px] text-amber-800">{t('vp.rideNotAllowedMessage')}</p>
        </div>
      ) : !myEntry && !vehicle.is_online ? (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
          <p className="font-sans text-[13px] text-[#64748b]">{t('vp.goOnlineToCheckInHint')}</p>
        </div>
      ) : !myEntry ? (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
          <p className="font-sans text-[12.5px] text-[#64748b] mb-2.5">{t('af.checkInHint')}</p>
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-1.5">
              <select value={checkInAddaId} onChange={(e) => setCheckInAddaId(e.target.value)} className={inputCls}>
                <option value="">{t('af.pickAddaOption')}</option>
                {addas.map((a) => <option key={a.id} value={a.id}>{isUrdu && a.name_ur ? a.name_ur : a.name}</option>)}
              </select>
              <select value={checkInFareMode} onChange={(e) => setCheckInFareMode(e.target.value)} className={inputCls}>
                <option value="fixed">{t('af.fixedFareOption')}</option>
                <option value="request">{t('af.rideRequestOption')}</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <input type="number" value={checkInSeats || ''} onChange={(e) => setCheckInSeats(+e.target.value)} placeholder={t('af.seatsAvailablePlaceholder')} className={`${inputCls} flex-1 min-w-0`} />
              <button onClick={doAddaCheckIn} disabled={addaActionLoading || checkingLocation} className="shrink-0 whitespace-nowrap px-3 py-2.5 bg-[#166534] text-white rounded-xl font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
                {checkingLocation ? t('af.confirmingLocationBtn') : t('af.checkInBtn')}
              </button>
            </div>
          </div>
          {checkInFareMode === 'fixed' && checkInAddaId && (() => {
            const picked = addas.find((a) => a.id === checkInAddaId)
            return picked?.fixed_fare_per_seat_pkr != null
              ? <p className="font-sans text-[12px] text-[#166534] font-semibold mt-2">{t('af.systemFareShownHint').replace('{amount}', fmt(picked.fixed_fare_per_seat_pkr))}</p>
              : <p className="font-sans text-[12px] text-amber-700 mt-2">{t('af.noSystemFareYet')}</p>
          })()}
          <label className="flex items-center gap-2 cursor-pointer mt-2.5">
            <input type="checkbox" checked={checkInShareLocation} onChange={(e) => setCheckInShareLocation(e.target.checked)} className="accent-[#166534]" />
            <span className="font-sans text-[12.5px] text-[#64748b]">{t('af.shareLocationOnDepartLabel')}</span>
          </label>
        </div>
      ) : (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
          <p className="font-sans text-[13.5px] font-bold text-[#1e293b] flex items-center gap-1.5"><MapPin size={13} className="text-[#166534]" /> {isUrdu && myEntry.adda_name_ur ? myEntry.adda_name_ur : myEntry.adda_name}</p>
          {!editingSeats ? (
            <p className="font-sans text-[12px] text-[#64748b] mt-1 flex items-center gap-1.5">
              <span className="ltr-num">{myEntry.seats_available}/{myEntry.seats_total}</span> {t('af.seatsFreeLabel')}
              <button onClick={openEditSeats} disabled={addaActionLoading} className="inline-flex items-center gap-0.5 text-[#166534] font-semibold cursor-pointer disabled:opacity-50"><Pencil size={11} /> {t('af.editSeatsBtn')}</button>
            </p>
          ) : (
            <div className="flex items-center gap-1.5 mt-1.5">
              <input type="number" min={1} value={seatsEditValue || ''} onChange={(e) => setSeatsEditValue(+e.target.value)} className="w-20 border border-[#e5e2d0] rounded-lg p-1 text-[13px]" />
              <button onClick={doUpdateSeats} disabled={addaActionLoading} className="px-2.5 py-1 bg-[#166534] text-white rounded-lg text-[12px] font-sans font-semibold cursor-pointer disabled:opacity-50">{t('af.saveSeatsBtn')}</button>
              <button onClick={() => setEditingSeats(false)} disabled={addaActionLoading} className="px-2.5 py-1 border border-[#e5e2d0] rounded-lg text-[12px] font-sans font-semibold cursor-pointer disabled:opacity-50">{t('action.cancel')}</button>
            </div>
          )}
          {myEntry.status === 'current' ? (
            <div className="bg-[#166534]/10 rounded-xl p-2.5 mt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 font-sans text-[13px] font-bold text-[#166534]"><Trophy size={13} /> {t('af.yourTurnLabel')}</span>
                {secondsLeft(myEntry.turn_expires_at) != null && <span className="inline-flex items-center gap-1 font-sans text-[13px] font-bold text-[#166534] ltr-num"><Timer size={13} /> {fmtCountdown(secondsLeft(myEntry.turn_expires_at)!)}</span>}
              </div>
              <div className="flex items-center gap-1.5 mt-2.5">
                <button onClick={doAddaDeparted} disabled={addaActionLoading} className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-[12.5px] font-sans font-semibold cursor-pointer bg-[#166534] text-white disabled:opacity-50"><LogOut size={12} /> {t('af.departedBtn')}</button>
                <button onClick={doAddaPass} disabled={addaActionLoading} className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-[12.5px] font-sans font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b] disabled:opacity-50"><SkipForward size={12} /> {t('af.passBtn')}</button>
              </div>
            </div>
          ) : (
            <div className="mt-2">
              <p className="font-sans text-[12.5px] text-[#64748b]">{t('af.waitingAtPositionLabel').replace('{n}', String(myEntry.position))}</p>
              {myBoard && (() => {
                const current = myBoard.entries.find((e) => e.status === 'current')
                const waiting = myBoard.entries.filter((e) => e.status === 'waiting').sort((a, b) => a.position - b.position)
                const secs = current ? secondsLeft(current.turn_expires_at) : null
                const canClaim = waiting[0]?.entry_id === myEntry.entry_id && (!current || secs === 0)
                return (
                  <>
                    {current && secs != null && <p className="font-sans text-[12px] text-[#64748b] mt-1">{t('af.currentVehicleTimeLeft').replace('{name}', current.owner_name).replace('{time}', fmtCountdown(secs))}</p>}
                    {canClaim && (
                      <button onClick={doAddaClaim} disabled={addaActionLoading} className="mt-2 px-3 py-1.5 rounded-xl text-[12.5px] font-sans font-semibold cursor-pointer bg-amber-600 text-white disabled:opacity-50">{t('af.claimBtn')}</button>
                    )}
                  </>
                )
              })()}
              <button onClick={doAddaLeave} disabled={addaActionLoading} className="mt-2 ms-2 font-sans text-[12px] text-[#64748b] cursor-pointer">{t('af.leaveQueueBtn')}</button>
            </div>
          )}
        </div>
      )}

      {/* THE QUEUE — full ordered list of every vehicle waiting at this
          adda, matching the zip's own adda screen exactly. Not shown
          anywhere before this: the embedded version only ever surfaced
          "you're at position N" plus the current server's own countdown. */}
      {myEntry && myBoard && (
        <div>
          <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2 flex items-center gap-1.5"><ListOrdered size={13} /> {t('af.theQueueHeading')}</p>
          {myBoard.entries.length === 0 ? (
            <p className="font-sans text-[13px] text-[#94a3b8]">{t('af.queueEmptyLabel')}</p>
          ) : (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl divide-y divide-[#f1f5f9]">
              {[...myBoard.entries].sort((a, b) => a.position - b.position).map((e) => (
                <div key={e.entry_id} className="flex items-center gap-3 p-3" style={e.entry_id === myEntry.entry_id ? { background: '#166534' + '14' } : undefined}>
                  <span className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-[#F9F9F6] text-[#1e293b] text-[12px] font-bold ltr-num">{e.position}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate flex items-center gap-1.5">
                      {e.owner_name}
                      {e.entry_id === myEntry.entry_id && <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-[#166534] text-white text-[10px] font-bold">{t('af.youChip')}</span>}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] font-bold uppercase px-2 py-0.5 rounded-full" style={e.status === 'current' ? { background: '#d1fae5', color: '#047857' } : { background: '#F9F9F6', color: '#64748b' }}>{e.status === 'current' ? t('af.yourTurnLabel') : t('mk.active')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {locationModalReason && <LocationSettingsModal reason={locationModalReason} onClose={() => setLocationModalReason(null)} />}
    </div>
  )
}
