'use client'

// Admin audit view — every mentor↔student conversation, fully readable.
// This is the other half of the "not actually private" promise shown to
// users in the chat itself (RLS already grants admin/super_admin read on
// mentor_conversations/mentor_messages, migration 324 — this page is just
// the UI for it).
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MessageCircle, Search, ShieldCheck } from 'lucide-react'

interface ConversationRow {
  id: string; student_portal_user_id: string; mentor_portal_user_id: string
  status: string; last_message_at: string; created_at: string
  student_name?: string; mentor_name?: string
}
interface MessageRow { id: string; sender_portal_user_id: string; content: string; created_at: string }

export default function AdminMentorChatsPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [conversations, setConversations] = useState<ConversationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ConversationRow | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('mentor_conversations').select('*').order('last_message_at', { ascending: false })
      const convs = (data ?? []) as ConversationRow[]
      if (convs.length) {
        const ids = Array.from(new Set(convs.flatMap((c) => [c.student_portal_user_id, c.mentor_portal_user_id])))
        const { data: names } = await supabase.from('portal_users').select('id, full_name').in('id', ids)
        const nameMap = Object.fromEntries((names ?? []).map((n) => [n.id, n.full_name]))
        convs.forEach((c) => { c.student_name = nameMap[c.student_portal_user_id]; c.mentor_name = nameMap[c.mentor_portal_user_id] })
      }
      setConversations(convs)
      setLoading(false)
    }
    load()
  }, [supabase])

  const openConversation = async (c: ConversationRow) => {
    setSelected(c)
    setLoadingMessages(true)
    const { data } = await supabase.from('mentor_messages').select('id, sender_portal_user_id, content, created_at').eq('conversation_id', c.id).order('created_at')
    setMessages((data ?? []) as MessageRow[])
    setLoadingMessages(false)
  }

  const filtered = conversations.filter((c) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (c.student_name ?? '').toLowerCase().includes(q) || (c.mentor_name ?? '').toLowerCase().includes(q)
  })

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
          <MessageCircle size={26} className="text-dp-secondary" /> {t('mc.title')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed flex items-center gap-1.5">
          <ShieldCheck size={14} className="text-dp-secondary shrink-0" /> {t('mc.blurb')}
        </p>
      </div>

      <div className="grid lg:grid-cols-[340px_1fr] gap-4">
        <div>
          <div className="relative mb-3">
            <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-dp-on-surface-variant" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('mc.searchPlaceholder')} className="input-field ps-9" />
          </div>
          {loading && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[13px]">{t('action.loading')}</p>}
          {!loading && filtered.length === 0 && <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[13px]">{t('mc.noConversations')}</p>}
          <div className="space-y-2 max-h-[70vh] overflow-y-auto">
            {filtered.map((c) => (
              <button key={c.id} onClick={() => openConversation(c)}
                className={`w-full text-start px-4 py-3 rounded-lg border transition-all cursor-pointer ${selected?.id === c.id ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant bg-white hover:border-dp-secondary/50'}`}>
                <p className="font-sans text-[13px] font-bold text-dp-on-surface">{c.student_name} <span className="text-dp-on-surface-variant font-normal">↔</span> {c.mentor_name}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-0.5">{new Date(c.last_message_at).toLocaleString()} {c.status === 'closed' && `· ${t('mc.closed')}`}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 min-h-[400px]">
          {!selected ? (
            <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[13px]">{t('mc.selectConversation')}</p>
          ) : loadingMessages ? (
            <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[13px]">{t('action.loading')}</p>
          ) : (
            <div className="space-y-2.5">
              {messages.length === 0 && <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[13px]">{t('mc.noMessages')}</p>}
              {messages.map((m) => {
                const isStudent = m.sender_portal_user_id === selected.student_portal_user_id
                return (
                  <div key={m.id} className={`flex ${isStudent ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[70%] px-3.5 py-2 rounded-lg font-sans text-[13px] leading-relaxed ${isStudent ? 'bg-dp-surface-container-low text-dp-on-surface' : 'bg-dp-secondary/10 text-dp-on-surface'}`}>
                      <p className="text-[10px] font-bold text-dp-on-surface-variant mb-0.5">{isStudent ? selected.student_name : selected.mentor_name}</p>
                      {m.content}
                      <p className="text-[9.5px] text-dp-on-surface-variant mt-1">{new Date(m.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
