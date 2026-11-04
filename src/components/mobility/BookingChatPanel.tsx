'use client'

// Real ask, 2026-11-04: "we need to have a way from where we can chat
// with the passengers on the book... when we click will open the chat
// at the bottom... when both rider or driver will get message then
// the popup will appear on the same booking window." Negotiation
// threads (422/658) already exist for hourly/rental/equipment/shadi —
// a real thread, auto-created the moment a driver accepts — but the
// only way to reach it was ChatButton's router.push() to a whole
// separate page, exactly the "navigate away again and again" the ask
// is about. This renders the same thread inline, as a panel sliding up
// over whichever lifecycle sheet (driver) or waiting sheet (rider) is
// already open, so the booking context never leaves the screen.
//
// Deliberately simpler than the full /chat and /negotiations pages:
// those also handle the older fetch/share/pro free-price negotiation
// flow (offer/accept/decline). A kind='booking' thread never uses any
// of that — plain messaging about an already-priced job — so this
// only renders the message list + send box, same as those pages
// already do for isBooking threads.

import { useEffect, useRef, useState } from 'react'
import { X, Send, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export type BookingChatRefType = 'hourly_booking' | 'equipment_booking' | 'rental_booking' | 'shadi_vehicle_request'

interface ThreadInfo { id: string; status: string; is_mine_as_user: boolean; vehicle_owner_name: string }
interface Message { id: string; sender_role: 'user' | 'driver'; kind: 'text' | 'offer' | 'system'; body: string | null; amount_pkr: number | null; created_at: string }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export function BookingChatPanel({ refType, refId, otherPartyName, onClose }: {
  refType: BookingChatRefType; refId: string; otherPartyName?: string | null; onClose: () => void
}) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [threadId, setThreadId] = useState<string | null>(null)
  const [thread, setThread] = useState<ThreadInfo | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const reload = async (id: string) => {
    const { data } = await supabase.rpc('negotiation_thread_detail', { p_thread_id: id })
    if (data) { setThread(data.thread); setMessages(data.messages) }
    setLoading(false)
  }

  useEffect(() => {
    let live = true
    supabase.rpc('booking_thread_id', { p_ref_type: refType, p_ref_id: refId }).then(({ data }) => {
      if (!live) return
      if (!data) { setLoading(false); return }
      setThreadId(data)
      reload(data)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refType, refId])

  useEffect(() => {
    if (!threadId) return
    const iv = setInterval(() => reload(threadId), 4000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])

  const myRole = thread?.is_mine_as_user ? 'user' : 'driver'
  const isOpen = thread?.status === 'open'

  const sendText = async () => {
    if (!text.trim() || !threadId) return
    setBusy(true)
    const { error } = await supabase.rpc('send_negotiation_message', { p_thread_id: threadId, p_body: text.trim() })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setText('')
    reload(threadId)
  }

  return (
    <div className="fixed inset-0 bg-black/55 z-[110] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-[400px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[85vh] shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 duration-300 flex flex-col">

        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-[#f1f5f9] shrink-0">
          <p className="font-sans text-[14.5px] font-bold text-[#0f172a] truncate"><bdi>{otherPartyName || t('vp.chatBtn')}</bdi></p>
          <button onClick={onClose} aria-label="Close" className="shrink-0 w-8 h-8 rounded-full bg-[#f1f5f9] flex items-center justify-center cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-10"><Loader2 size={20} className="animate-spin text-[#94a3b8]" /></div>
        ) : !thread ? (
          <p className="flex-1 text-center py-10 text-[13.5px] text-[#64748b]">{t('vp.chatUnavailableHint')}</p>
        ) : (
          <>
            <div className="flex-1 px-4 py-3 overflow-y-auto flex flex-col gap-2 min-h-[260px]">
              {messages.length === 0 && <p className="text-center text-[12.5px] text-[#94a3b8] py-6">{t('vp.noMessagesYetHint')}</p>}
              {messages.map((m) => {
                if (m.kind === 'system') return <p key={m.id} className="text-center text-[11px] text-[#94a3b8] italic py-1">{m.body}{m.amount_pkr != null ? ` — Rs ${fmt(m.amount_pkr)}` : ''}</p>
                const mine = m.sender_role === myRole
                const alignEnd = isUrdu ? !mine : mine
                return (
                  <div key={m.id} className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
                    <div className="max-w-[78%] px-3 py-2" style={{
                      borderRadius: alignEnd ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                      background: mine ? '#166534' : '#fff',
                      color: mine ? '#fff' : '#1e293b',
                      border: mine ? 'none' : '1px solid #e5e2d0',
                    }}>
                      <p className="text-[13px]"><bdi>{m.body}</bdi></p>
                      <p className="text-[9.5px] mt-0.5 opacity-70">{new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 border-t border-[#f1f5f9] shrink-0">
              {isOpen ? (
                <div className="flex items-center gap-1.5">
                  <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendText()}
                    placeholder={t('vp.messagePlaceholder')} className="flex-1 border border-[#e2e8f0] rounded-full px-3.5 py-2 text-[13px]" />
                  <button onClick={sendText} disabled={busy || !text.trim()} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-[#166534] text-white cursor-pointer disabled:opacity-50">
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  </button>
                </div>
              ) : (
                <p className="text-center text-[12px] text-[#94a3b8] py-1">{t('vp.conversationClosedNote')}</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
