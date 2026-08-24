'use client'

// The chat thread itself. Two things this page exists to get right:
//   1. The pinned Urdu/English notice at the top is not decoration — every
//      message here is readable by admin, and the sender needs to know that
//      before they type anything, not find out later.
//   2. A phone/WhatsApp/email pattern is blocked before it ever leaves the
//      browser (the database trigger is the real enforcement — this is just
//      so the sender gets an instant, specific reason instead of a generic
//      failed-request error after a round trip).
import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ArrowLeft, ShieldAlert, Send, Ban } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'

const CONTACT_INFO_PATTERN = /(\+?92|0)[\s-]?3\d{2}[\s-]?\d{7}|(\d[\s-]?){10,}|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|wa\.me\/|whatsapp\.com/i

interface Message { id: string; conversation_id: string; sender_portal_user_id: string; content: string; created_at: string }
interface Conversation {
  id: string; student_portal_user_id: string; mentor_portal_user_id: string; status: string
  student_name: string; mentor_name: string
}

export default function MentorChatThreadPage() {
  const { t, isUrdu } = useLocale()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [otherName, setOtherName] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [confirmBlock, setConfirmBlock] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    const { data: conv } = await supabase.from('mentor_conversations_with_names').select('*').eq('id', id).single()
    setConversation(conv)
    if (conv && user) {
      setOtherName((conv.student_portal_user_id === user.id ? conv.mentor_name : conv.student_name) ?? '')
    }
    const { data: msgs } = await supabase.from('mentor_messages').select('*').eq('conversation_id', id).order('created_at')
    setMessages((msgs ?? []) as Message[])
    setLoading(false)
    await supabase.rpc('mark_mentor_conversation_read', { p_conversation_id: id })
  }

  useEffect(() => { if (!userLoading && user) load() }, [userLoading, user, id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const channel = supabase.channel(`mentor_chat_${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mentor_messages', filter: `conversation_id=eq.${id}` }, (payload) => {
        setMessages((prev) => [...prev, payload.new as Message])
        supabase.rpc('mark_mentor_conversation_read', { p_conversation_id: id })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [id, supabase])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const send = async () => {
    const content = text.trim()
    if (!content) return
    if (CONTACT_INFO_PATTERN.test(content)) {
      toast.error(t('mn.noContactInfo'))
      return
    }
    setSending(true)
    const { error } = await supabase.from('mentor_messages').insert({ conversation_id: id, sender_portal_user_id: user!.id, content })
    setSending(false)
    if (error) {
      toast.error(error.message.includes('not allowed') ? t('mn.noContactInfo') : friendlyError(error))
      return
    }
    setText('')
    load()
  }

  const doBlock = async () => {
    if (!conversation || !user) return
    const otherId = conversation.student_portal_user_id === user.id ? conversation.mentor_portal_user_id : conversation.student_portal_user_id
    const { error } = await supabase.rpc('block_mentor_chat_partner', { p_other_portal_user_id: otherId })
    setConfirmBlock(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mn.blocked'))
    router.push('/portal/mentors')
  }

  if (userLoading || loading || !user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!conversation) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('mn.notFound')}</div>

  const isClosed = conversation.status === 'closed'

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex flex-col h-[calc(100vh-140px)] max-h-[800px]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <button onClick={() => router.push('/portal/mentors')} className="p-2 hover:bg-dp-surface-container-low rounded-lg cursor-pointer"><ArrowLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></button>
          <h1 className="font-heading text-[18px] font-bold text-dp-primary">{otherName || t('mn.chat')}</h1>
        </div>
        {!isClosed && (
          <button onClick={() => setConfirmBlock(true)} className="flex items-center gap-1.5 text-dp-error text-[12.5px] font-sans font-semibold hover:underline cursor-pointer">
            <Ban size={13} /> {t('mn.blockUser')}
          </button>
        )}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 mb-3 flex items-start gap-2">
        <ShieldAlert size={15} className="text-amber-700 shrink-0 mt-0.5" />
        <p className="font-sans text-[12px] text-amber-900 leading-relaxed">{t('mn.notPrivateNotice')}</p>
      </div>

      <div className="flex-1 overflow-y-auto bg-dp-surface-container-low rounded-lg p-4 space-y-2.5">
        {messages.length === 0 && <p className="text-center font-sans text-[13px] text-dp-on-surface-variant py-8">{t('mn.sayHello')}</p>}
        {messages.map((m) => {
          const mine = m.sender_portal_user_id === user.id
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] px-3.5 py-2 rounded-lg font-sans text-[13.5px] leading-relaxed ${mine ? 'bg-dp-secondary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface'}`}>
                {m.content}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {isClosed ? (
        <p className="text-center font-sans text-[13px] text-dp-on-surface-variant py-3">{t('mn.conversationClosed')}</p>
      ) : (
        <div className="flex items-center gap-2 mt-3">
          <input
            value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send() }}
            placeholder={t('mn.typeMessage')}
            className="input-field flex-1"
          />
          <button onClick={send} disabled={sending || !text.trim()} className="bg-dp-secondary text-white p-3 rounded-lg cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            <Send size={16} className={isUrdu ? 'rotate-180' : ''} />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmBlock}
        title={t('mn.blockUser')}
        message={t('mn.blockConfirmMessage')}
        confirmLabel={t('mn.blockUser')}
        onConfirm={doBlock}
        onCancel={() => setConfirmBlock(false)}
      />
    </div>
  )
}
