'use client'

// Real ask, 2026-11-04 — step 3 (ride-sharing/ride_dispatch) and the
// Adda half of step 2 of the inline-chat work (step 1 was hourly/
// rental/equipment's 1:1 negotiation thread). Routes already have
// their own real, reachable chat (RouteGroupPanel.tsx) — not touched
// here. trip_group_messages (745) already backs a real group chat
// (one driver, N currently-booked riders) for one-off ride-sharing
// trips and ride_dispatch acceptances (both create a vehicle_trip_offers
// row); migration 799 generalized the same table to also back Adda
// queue bookings. One panel, two thin RPC wrappers — the message shape
// (sender_name/is_me) is identical for both.

import { useEffect, useRef, useState } from 'react'
import { X, Send, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export type GroupChatRefType = 'trip' | 'adda'
interface Message { id: string; sender_role: 'driver' | 'rider'; sender_name: string; is_me: boolean; body: string; created_at: string }

const RPC: Record<GroupChatRefType, { list: string; send: string; param: string }> = {
  trip: { list: 'trip_group_chat_messages', send: 'send_trip_group_message', param: 'p_trip_offer_id' },
  adda: { list: 'adda_group_chat_messages', send: 'send_adda_group_message', param: 'p_adda_queue_entry_id' },
}

export function GroupChatPanel({ refType, refId, title, onClose }: { refType: GroupChatRefType; refId: string; title?: string | null; onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const rpc = RPC[refType]
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const reload = async () => {
    const { data } = await supabase.rpc(rpc.list, { [rpc.param]: refId })
    setMessages((data ?? []) as Message[])
    setLoading(false)
  }

  useEffect(() => { reload() }, [refType, refId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const iv = setInterval(reload, 4000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refType, refId])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])

  const sendText = async () => {
    if (!text.trim()) return
    setBusy(true)
    const { error } = await supabase.rpc(rpc.send, { [rpc.param]: refId, p_body: text.trim() })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setText('')
    reload()
  }

  return (
    <div className="fixed inset-0 bg-black/55 z-[110] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-[400px] rounded-t-[28px] sm:rounded-[28px] overflow-hidden max-h-[85vh] shadow-2xl animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-4 duration-300 flex flex-col">

        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-[#f1f5f9] shrink-0">
          <p className="font-sans text-[14.5px] font-bold text-[#0f172a] truncate"><bdi>{title || t('vp.chatBtn')}</bdi></p>
          <button onClick={onClose} aria-label="Close" className="shrink-0 w-8 h-8 rounded-full bg-[#f1f5f9] flex items-center justify-center cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-10"><Loader2 size={20} className="animate-spin text-[#94a3b8]" /></div>
        ) : (
          <>
            <div className="flex-1 px-4 py-3 overflow-y-auto flex flex-col gap-2 min-h-[260px]">
              {messages.length === 0 && <p className="text-center text-[12.5px] text-[#94a3b8] py-6">{t('vp.noMessagesYetHint')}</p>}
              {messages.map((m) => {
                const alignEnd = isUrdu ? !m.is_me : m.is_me
                return (
                  <div key={m.id} className={`flex flex-col ${alignEnd ? 'items-end' : 'items-start'}`}>
                    {!m.is_me && <p className="text-[10.5px] font-semibold text-[#64748b] px-1 mb-0.5"><bdi>{m.sender_name}</bdi></p>}
                    <div className="max-w-[78%] px-3 py-2" style={{
                      borderRadius: alignEnd ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                      background: m.is_me ? '#166534' : '#fff',
                      color: m.is_me ? '#fff' : '#1e293b',
                      border: m.is_me ? 'none' : '1px solid #e5e2d0',
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
              <div className="flex items-center gap-1.5">
                <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendText()}
                  placeholder={t('vp.messagePlaceholder')} className="flex-1 border border-[#e2e8f0] rounded-full px-3.5 py-2 text-[13px]" />
                <button onClick={sendText} disabled={busy || !text.trim()} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-[#166534] text-white cursor-pointer disabled:opacity-50">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
