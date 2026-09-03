'use client'

// One chat/negotiate screen shared by all three request kinds — city-fetch
// ('fetch'), weekend-commuter seat requests ('share'), and pro/loading
// service charter ('pro') — exactly as the design spec instructs: the same
// negotiation mechanism, not three separate screens. Works identically
// whichever side of the conversation you are (villager or driver); RLS
// (is_party_to_negotiation) is what actually keeps this private, this page
// just renders whatever negotiation_thread_detail returns.

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Phone, Send, HandCoins, CheckCircle2, XCircle, Package, Users, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface ThreadInfo {
  id: string; kind: string; status: string; item: string | null; qty: string | null
  budget_pkr: number | null; agreed_amount_pkr: number | null; created_at: string; is_mine_as_user: boolean
  vehicle_id: string; vehicle_owner_name: string; vehicle_owner_mobile: string | null
  vehicle_type: string; vehicle_number: string | null
}
interface Message { id: string; sender_role: 'user' | 'driver'; kind: 'text' | 'offer' | 'system'; body: string | null; amount_pkr: number | null; created_at: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
const kindIcon = { fetch: Package, share: Users, pro: Truck } as const

export default function NegotiationThreadPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const params = useParams()
  const threadId = params.threadId as string
  const supabase = createClient()

  const [thread, setThread] = useState<ThreadInfo | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [offerAmount, setOfferAmount] = useState('')
  const [showOfferBox, setShowOfferBox] = useState(false)
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const myRole = thread?.is_mine_as_user ? 'user' : 'driver'

  const reload = async () => {
    const { data, error } = await supabase.rpc('negotiation_thread_detail', { p_thread_id: threadId })
    if (error) { setLoading(false); return }
    setThread(data.thread)
    setMessages(data.messages)
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

  const sendText = async () => {
    if (!text.trim()) return
    setBusy(true)
    const { error } = await supabase.rpc('send_negotiation_message', { p_thread_id: threadId, p_body: text.trim() })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setText('')
    reload()
  }
  const sendOffer = async () => {
    const amt = Number(offerAmount)
    if (!amt || amt <= 0) { toast.error(t('vp.enterAmountError')); return }
    setBusy(true)
    const { error } = await supabase.rpc('propose_negotiation_offer', { p_thread_id: threadId, p_amount_pkr: amt })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setOfferAmount(''); setShowOfferBox(false)
    reload()
  }
  const accept = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('accept_negotiation', { p_thread_id: threadId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.dealAgreedToast'))
    reload()
  }
  const close = async (action: 'decline' | 'cancel') => {
    if (!window.confirm(t('vp.endConversationConfirm'))) return
    setBusy(true)
    const { error } = await supabase.rpc('close_negotiation', { p_thread_id: threadId, p_action: action })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reload()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!thread) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('vp.threadNotFound')}</div>

  const KindIcon = kindIcon[thread.kind as keyof typeof kindIcon] ?? Package
  const otherPartyLabel = myRole === 'user' ? thread.vehicle_owner_name : t('vp.youAreDriverLabel')
  const isOpen = thread.status === 'open'

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto">
      <button onClick={() => router.push('/portal/marketplace/negotiations')} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:text-dp-secondary mb-3 cursor-pointer">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.backToConversations')}
      </button>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-sans text-[13.5px] font-bold text-dp-on-surface flex items-center gap-1.5"><KindIcon size={14} className="text-dp-secondary shrink-0" /> {thread.item}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{otherPartyLabel} · {thread.vehicle_type}{thread.vehicle_number ? ` · ${thread.vehicle_number}` : ''}</p>
          </div>
          {thread.vehicle_owner_mobile && (
            <a href={`tel:${thread.vehicle_owner_mobile}`} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-dp-secondary-container/50 text-dp-secondary hover:bg-dp-secondary hover:text-white transition-colors">
              <Phone size={15} />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          {thread.budget_pkr != null && <span className="font-sans text-[11.5px] font-semibold text-dp-on-surface-variant">{t('vp.openingBudgetLabel')}: <span className="ltr-num text-dp-on-surface">{fmt(thread.budget_pkr)}</span></span>}
          {thread.status === 'agreed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11.5px] font-bold"><CheckCircle2 size={12} /> {t('vp.agreedStatusLabel')} <span className="ltr-num">{fmt(thread.agreed_amount_pkr ?? 0)}</span></span>}
          {thread.status === 'declined' && <span className="inline-flex items-center gap-1 text-dp-error text-[11.5px] font-bold"><XCircle size={12} /> {t('vp.declinedStatusLabel')}</span>}
          {thread.status === 'cancelled' && <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[11.5px] font-bold"><XCircle size={12} /> {t('vp.cancelledStatusLabel')}</span>}
        </div>
      </div>

      <div className="bg-dp-surface-container/40 border border-dp-outline-variant rounded-lg p-3 mb-3 min-h-[280px] max-h-[50vh] overflow-y-auto space-y-2.5">
        {messages.map((m) => {
          if (m.kind === 'system') return <p key={m.id} className="text-center font-sans text-[11.5px] text-dp-on-surface-variant italic py-1">{m.body}{m.amount_pkr != null ? ` — Rs ${fmt(m.amount_pkr)}` : ''}</p>
          const mine = m.sender_role === myRole
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[78%] rounded-lg px-3 py-2 ${m.kind === 'offer' ? (mine ? 'bg-dp-primary text-white' : 'bg-amber-100 text-amber-900 border border-amber-300') : mine ? 'bg-dp-secondary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface'}`}>
                {m.kind === 'offer' ? (
                  <p className="font-sans text-[13.5px] font-bold flex items-center gap-1.5"><HandCoins size={13} /> {t('vp.offeredLabel')} <span className="ltr-num">{fmt(m.amount_pkr ?? 0)}</span></p>
                ) : (
                  <p className="font-sans text-[13.5px]">{m.body}</p>
                )}
                <p className={`font-sans text-[10px] mt-0.5 ${mine ? 'text-white/70' : 'text-dp-on-surface-variant'}`}>{new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {isOpen ? (
        <div className="space-y-2">
          {showOfferBox && (
            <div className="flex items-center gap-1.5">
              <input type="number" value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} placeholder={t('vp.offerAmountPlaceholder')} className="input-field !py-2 !text-[13px]" autoFocus />
              <button onClick={sendOffer} disabled={busy} className="px-3 py-2 bg-dp-primary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 shrink-0">{t('vp.sendOfferBtn')}</button>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendText()} placeholder={t('vp.messagePlaceholder')} className="input-field !py-2 !text-[13px]" />
            <button onClick={() => setShowOfferBox((s) => !s)} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container cursor-pointer" title={t('vp.proposeAmountBtn')}><HandCoins size={15} /></button>
            <button onClick={sendText} disabled={busy || !text.trim()} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-dp-secondary text-white hover:bg-dp-primary cursor-pointer disabled:opacity-50"><Send size={15} /></button>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={() => close(myRole === 'user' ? 'cancel' : 'decline')} disabled={busy} className="font-sans text-[12px] text-dp-on-surface-variant hover:text-dp-error cursor-pointer disabled:opacity-50">{t('vp.endWithoutDealBtn')}</button>
            <button onClick={accept} disabled={busy} className="px-3.5 py-1.5 bg-emerald-600 text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-emerald-700 disabled:opacity-50">{t('vp.acceptLastOfferBtn')}</button>
          </div>
        </div>
      ) : (
        <p className="text-center font-sans text-[12.5px] text-dp-on-surface-variant py-2">{t('vp.conversationClosedNote')}</p>
      )}
    </div>
  )
}
