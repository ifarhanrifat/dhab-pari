'use client'

// Real ask, 2026-10-27: "from where he will send the chat to his
// riders in group" — a driver's confirmed riders had no shared thread
// at all, only the 1:1 negotiation_threads (422) from before booking.
// This is the group equivalent: one thread per trip_offer_id, the
// driver plus every currently-confirmed rider on it, same send/read
// RPCs (send_trip_group_message / trip_group_chat_messages, 745) as
// every other message-table in this app.

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Send, Users } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Message { id: string; sender_role: 'driver' | 'rider'; sender_name: string; is_me: boolean; body: string; created_at: string }

export default function TripGroupChatPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const params = useParams()
  const tripOfferId = params.tripOfferId as string
  const supabase = createClient()

  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const reload = async () => {
    const { data, error } = await supabase.rpc('trip_group_chat_messages', { p_trip_offer_id: tripOfferId })
    if (!error) setMessages((data as Message[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { if (user) reload() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) return
    const iv = setInterval(reload, 4000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])

  const send = async () => {
    if (!text.trim()) return
    setBusy(true)
    const { error } = await supabase.rpc('send_trip_group_message', { p_trip_offer_id: tripOfferId, p_body: text.trim() })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setText('')
    reload()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#64748b] cursor-pointer w-fit">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('action.back')}
      </button>

      <div className="bg-gradient-to-r from-[#005A36] to-[#166534] rounded-2xl p-3.5 text-white flex items-center gap-2">
        <span className="shrink-0 w-9 h-9 rounded-full bg-white/15 flex items-center justify-center"><Users size={16} /></span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold">{t('cm.tripGroupChatHeading')}</p>
          <p className="text-[11px] text-white/80">{t('cm.tripGroupChatSubtitle')}</p>
        </div>
      </div>

      <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-2xl p-3 min-h-[320px] max-h-[55vh] overflow-y-auto flex flex-col gap-2">
        {messages.length === 0 && <p className="text-center text-[12.5px] text-[#94a3b8] py-10">{t('cm.noGroupMessagesYet')}</p>}
        {messages.map((m) => {
          const alignEnd = isUrdu ? !m.is_me : m.is_me
          return (
            <div key={m.id} className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[78%] px-3 py-2" style={{
                borderRadius: alignEnd ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                background: m.is_me ? '#166534' : '#fff',
                color: m.is_me ? '#fff' : '#1e293b',
                border: m.is_me ? 'none' : '1px solid #e5e2d0',
              }}>
                {!m.is_me && (
                  <p className="text-[10px] font-bold mb-0.5" style={{ color: m.sender_role === 'driver' ? '#166534' : '#64748b' }}>
                    {m.sender_name} {m.sender_role === 'driver' && `· ${t('cm.driverLabel')}`}
                  </p>
                )}
                <p className="text-[13px]">{m.body}</p>
                <p className="text-[9.5px] mt-0.5 opacity-70">{new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-1.5">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={t('vp.messagePlaceholder')} className="flex-1 border border-[#e2e8f0] rounded-full px-3.5 py-2 text-[13px]" />
        <button onClick={send} disabled={busy || !text.trim()} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-[#166534] text-white cursor-pointer disabled:opacity-50"><Send size={15} /></button>
      </div>
    </div>
  )
}
