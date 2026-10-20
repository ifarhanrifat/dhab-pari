'use client'

// The permanent route group — chat + live location + member roster,
// shared by both the driver and every rider who's ever booked this
// route (auto-joined on first booking via place_ride_booking, or by
// tapping Join here). One group, not a fresh one per day's run — a
// real, explicit ask, since riders of a regular commute recognize each
// other and want one ongoing place to coordinate, not a new thread
// every single day.
//
// Deliberately reuses useLiveLocation (src/hooks/useLiveLocation.ts)
// rather than a hand-rolled watchPosition loop — it already has the
// native-background-geolocation + screen-wake-lock handling the
// bilateral trip-location page needed, and there's no reason this
// group's own sharing should be any less reliable than that one.

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Send, Radio, Users, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useLiveLocation } from '@/hooks/useLiveLocation'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Participant { portal_user_id: string; name: string; sharing_location: boolean }
interface Message { id: string; sender_portal_user_id: string; sender_name: string; is_own: boolean; body: string; created_at: string }
interface LiveLoc { portal_user_id: string; name: string; is_own: boolean; lat: number; lng: number; updated_at: string }
interface Detail { is_owner: boolean; is_member: boolean; sharing_location: boolean; participants: Participant[]; messages: Message[]; live_locations: LiveLoc[] }

export function RouteGroupPanel({ routeId, onClose }: { routeId: string; onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [sharingBusy, setSharingBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    const { data } = await supabase.rpc('route_group_detail', { p_route_id: routeId })
    const d = data as Detail | null
    if (d) { setDetail(d); setSharing(d.sharing_location) }
    setLoading(false)
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 12000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [detail?.messages.length])

  const { error: geoError } = useLiveLocation({
    enabled: sharing,
    minIntervalMs: 12000,
    backgroundTitle: t('cm.liveShareNotifTitle'),
    backgroundMessage: t('cm.liveShareNotifBody'),
    onFix: async ({ lat, lng }) => {
      const { error } = await supabase.rpc('ping_route_location', { p_route_id: routeId, p_lat: lat, p_lng: lng })
      if (error) setSharing(false)
    },
  })

  const join = async () => {
    setJoining(true)
    const { error } = await supabase.rpc('join_route_group', { p_route_id: routeId })
    setJoining(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    load()
  }

  const leave = async () => {
    setLeaving(true)
    const { error } = await supabase.rpc('leave_route_group', { p_route_id: routeId })
    setLeaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setSharing(false)
    load()
  }

  const toggleSharing = async () => {
    setSharingBusy(true)
    const { error } = await supabase.rpc('set_route_location_sharing', { p_route_id: routeId, p_on: !sharing })
    setSharingBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setSharing(!sharing)
  }

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setSending(true)
    const { error } = await supabase.rpc('send_route_message', { p_route_id: routeId, p_body: body })
    setSending(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setText('')
    load()
  }

  return (
    <MobilityBottomSheet title={t('mv.routeGroupHeading')} onClose={onClose}>
      {loading ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : !detail?.is_member ? (
        <div className="flex flex-col items-center gap-2.5 py-4 text-center">
          <Users size={28} className="text-[#166534]" />
          <p className="font-sans text-[13px] text-[#64748b]">{t('mv.joinGroupHint')}</p>
          <button onClick={join} disabled={joining} className="w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
            {joining ? t('action.saving') : t('mv.joinGroupBtn')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] flex items-center gap-1"><Users size={12} /> {t('mv.membersLabel')} ({detail.participants.length})</p>
            <button onClick={leave} disabled={leaving} className="flex items-center gap-1 font-sans text-[11px] font-semibold text-[#b91c1c] cursor-pointer disabled:opacity-50">
              <LogOut size={11} /> {t('mv.leaveGroupBtn')}
            </button>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {detail.participants.map((p) => (
              <span key={p.portal_user_id} className="flex items-center gap-1 px-2 py-1 rounded-full bg-[#F9F9F6] border border-[#e5e2d0] font-sans text-[11px] text-[#334155]">
                {p.sharing_location && <Radio size={9} className="text-[#166534] animate-pulse" />} {p.name}
              </span>
            ))}
          </div>

          <button type="button" onClick={toggleSharing} disabled={sharingBusy}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer transition-all disabled:opacity-50 w-fit ${sharing ? 'bg-[#166534] text-white' : 'border border-[#e5e2d0] text-[#64748b]'}`}>
            <Radio size={12} className={sharing ? 'animate-pulse' : ''} /> {t('mv.shareMyLocationLabel')}
          </button>
          {sharing && geoError && <p className="font-sans text-[11px] text-amber-700">{geoError}</p>}

          {detail.live_locations.length > 0 && (
            <LeafletMap
              pins={detail.live_locations.map((l) => ({ lat: l.lat, lng: l.lng, label: l.name, color: l.is_own ? '#D4AF37' : '#166534', emoji: '🚗' }))}
              height={150} className="rounded-xl"
            />
          )}

          <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-2xl p-3 min-h-[220px] max-h-[40vh] overflow-y-auto flex flex-col gap-2">
            {detail.messages.length === 0 && <p className="text-center text-[11.5px] text-[#94a3b8] italic py-4">{t('mv.noMessagesYet')}</p>}
            {detail.messages.map((m) => {
              const alignEnd = isUrdu ? !m.is_own : m.is_own
              return (
                <div key={m.id} className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[78%] px-3 py-2" style={{
                    borderRadius: alignEnd ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                    background: m.is_own ? '#166534' : '#fff', color: m.is_own ? '#fff' : '#1e293b',
                    border: m.is_own ? 'none' : '1px solid #e5e2d0',
                  }}>
                    {!m.is_own && <p className="text-[9.5px] font-bold opacity-70 mb-0.5">{m.sender_name}</p>}
                    <p className="text-[13px]">{m.body}</p>
                    <p className="text-[9.5px] mt-0.5 opacity-70">{new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-center gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send() }}
              placeholder={t('mn.typeMessage')} className="flex-1 dp2-input" />
            <button onClick={send} disabled={sending || !text.trim()} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-[#166534] text-white cursor-pointer disabled:opacity-50"><Send size={15} /></button>
          </div>
        </div>
      )}
    </MobilityBottomSheet>
  )
}
