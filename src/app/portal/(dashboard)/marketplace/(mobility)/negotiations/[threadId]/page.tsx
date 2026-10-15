'use client'

// One chat/negotiate screen re-skinned in the new design — identical
// logic/RPCs to the page this replaces (negotiation_thread_detail,
// send_negotiation_message, propose_negotiation_offer, accept_negotiation,
// close_negotiation, negotiation_fare_band), only the visuals changed.

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Phone, Send, HandCoins, CheckCircle2, XCircle, Package, Users, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FareBandPicker, type FareBand } from '@/components/shared/FareBandPicker'

interface ThreadInfo {
  id: string; kind: string; status: string; item: string | null; qty: string | null
  budget_pkr: number | null; agreed_amount_pkr: number | null; created_at: string; is_mine_as_user: boolean
  vehicle_id: string; vehicle_owner_name: string; vehicle_owner_mobile: string | null
  vehicle_type: string; vehicle_number: string | null
}
interface Message { id: string; sender_role: 'user' | 'driver'; kind: 'text' | 'offer' | 'system'; body: string | null; amount_pkr: number | null; created_at: string }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
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
  const [fareBand, setFareBand] = useState<FareBand | null>(null)
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

  useEffect(() => {
    if (thread?.kind !== 'fetch' || fareBand) return
    supabase.rpc('negotiation_fare_band', { p_thread_id: threadId }).then(({ data }) => { if (data) setFareBand(data) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.kind])

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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!thread) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('vp.threadNotFound')}</div>

  const KindIcon = kindIcon[thread.kind as keyof typeof kindIcon] ?? Package
  const otherPartyLabel = myRole === 'user' ? thread.vehicle_owner_name : t('vp.youAreDriverLabel')
  const isOpen = thread.status === 'open'

  return (
    <div className="flex flex-col gap-3">
      <button onClick={() => router.push('/portal/marketplace/negotiations')} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#64748b] cursor-pointer w-fit">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.backToConversations')}
      </button>

      <div className="bg-gradient-to-r from-[#005A36] to-[#166534] rounded-2xl p-3.5 text-white">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13.5px] font-bold flex items-center gap-1.5"><KindIcon size={14} className="shrink-0" /> {thread.item}</p>
            <p className="text-[11.5px] text-white/80 mt-0.5">{otherPartyLabel} · {thread.vehicle_type}{thread.vehicle_number ? ` · ${thread.vehicle_number}` : ''}</p>
          </div>
          {thread.vehicle_owner_mobile && (
            <a href={`tel:${thread.vehicle_owner_mobile}`} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 transition-colors">
              <Phone size={15} />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {thread.budget_pkr != null && <span className="text-[11px] font-semibold text-white/80">{t('vp.openingBudgetLabel')}: <span className="ltr-num text-white">{fmt(thread.budget_pkr)}</span></span>}
          {thread.status === 'agreed' && <span className="inline-flex items-center gap-1 text-[#D4AF37] text-[11.5px] font-bold"><CheckCircle2 size={12} /> {t('vp.agreedStatusLabel')} <span className="ltr-num">{fmt(thread.agreed_amount_pkr ?? 0)}</span></span>}
          {thread.status === 'declined' && <span className="inline-flex items-center gap-1 text-red-200 text-[11.5px] font-bold"><XCircle size={12} /> {t('vp.declinedStatusLabel')}</span>}
          {thread.status === 'cancelled' && <span className="inline-flex items-center gap-1 text-white/70 text-[11.5px] font-bold"><XCircle size={12} /> {t('vp.cancelledStatusLabel')}</span>}
        </div>
      </div>

      <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-2xl p-3 min-h-[280px] max-h-[50vh] overflow-y-auto flex flex-col gap-2">
        {messages.map((m) => {
          if (m.kind === 'system') return <p key={m.id} className="text-center text-[11px] text-[#94a3b8] italic py-1">{m.body}{m.amount_pkr != null ? ` — Rs ${fmt(m.amount_pkr)}` : ''}</p>
          const mine = m.sender_role === myRole
          const alignEnd = isUrdu ? !mine : mine
          return (
            <div key={m.id} className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[78%] px-3 py-2" style={{
                borderRadius: alignEnd ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                background: m.kind === 'offer' ? (mine ? '#166534' : '#fff') : mine ? '#166534' : '#fff',
                color: mine ? '#fff' : '#1e293b',
                border: m.kind === 'offer' && !mine ? '2px solid #166534' : mine ? 'none' : '1px solid #e5e2d0',
              }}>
                {m.kind === 'offer' ? (
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[0.06em] flex items-center gap-1 opacity-80"><HandCoins size={10} /> {t('vp.offerLabelShort')}</p>
                    <p className="font-extrabold text-[18px] mt-0.5 ltr-num">{fmt(m.amount_pkr ?? 0)}</p>
                  </div>
                ) : (
                  <p className="text-[13px]">{m.body}</p>
                )}
                <p className="text-[9.5px] mt-0.5 opacity-70">{new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {isOpen ? (
        <div className="flex flex-col gap-2">
          {showOfferBox && (
            <div className="flex flex-col gap-1">
              {fareBand && <FareBandPicker band={fareBand} value={offerAmount === '' ? '' : Number(offerAmount)} onChange={(v) => setOfferAmount(String(v))} ownerLabel={t('cm.yourFareLabel')} />}
              <div className="flex items-center gap-1.5">
                <input type="number" value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} placeholder={t('vp.offerAmountPlaceholder')} className="flex-1 border border-[#e2e8f0] rounded-xl px-3 py-2 text-[13px]" autoFocus />
                <button onClick={sendOffer} disabled={busy} className="shrink-0 px-3 py-2 bg-[#166534] text-white rounded-xl text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">{t('vp.sendOfferBtn')}</button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendText()} placeholder={t('vp.messagePlaceholder')} className="flex-1 border border-[#e2e8f0] rounded-full px-3.5 py-2 text-[13px]" />
            <button onClick={() => setShowOfferBox((s) => !s)} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full border border-[#e5e2d0] text-[#166534] cursor-pointer" title={t('vp.proposeAmountBtn')}><HandCoins size={15} /></button>
            <button onClick={sendText} disabled={busy || !text.trim()} className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-[#166534] text-white cursor-pointer disabled:opacity-50"><Send size={15} /></button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => close(myRole === 'user' ? 'cancel' : 'decline')} disabled={busy} className="text-[12px] text-[#64748b] cursor-pointer disabled:opacity-50">{t('vp.endWithoutDealBtn')}</button>
            <button onClick={accept} disabled={busy} className="px-3.5 py-1.5 bg-[#D4AF37] text-[#0f172a] rounded-xl text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{t('vp.acceptLastOfferBtn')}</button>
          </div>
        </div>
      ) : (
        <p className="text-center text-[12.5px] text-[#94a3b8] py-2">{t('vp.conversationClosedNote')}</p>
      )}
    </div>
  )
}
