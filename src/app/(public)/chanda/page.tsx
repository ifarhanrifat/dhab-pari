'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Landmark, Copy } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'

interface Campaign {
  id: string; type: string; title: string; title_ur: string | null; description: string | null; description_ur: string | null
  target_amount: number | null; payment_method: string; account_number: string; account_title: string | null; bank_name: string | null
  cover_image_url: string | null
}
interface Pledge { id: string; campaign_id: string; giver_name: string; amount: number; status: string; created_at: string }

const methodLabel: Record<string, string> = { easypaisa: 'Easypaisa', jazzcash: 'JazzCash', bank: 'Bank Transfer' }

// Phase 3 of the "Village OS" feature set, 2026-10-01. Unlike wedding
// Salami (which shows totals only, 541), donor names ARE shown publicly
// here -- real ask -- matching the existing Projects donor-wall
// convention (donors_public).
export default function ChandaPage() {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const { user } = usePortalUser()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [pledges, setPledges] = useState<Pledge[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [receiptUrl, setReceiptUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const supabase = createClient()
    const [{ data: c }, { data: p }] = await Promise.all([
      supabase.from('chanda_campaigns_public').select('*').order('type'),
      supabase.from('chanda_pledges_public').select('*').order('amount', { ascending: false }),
    ])
    setCampaigns((c ?? []) as Campaign[]); setPledges((p ?? []) as Pledge[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const announce = async () => {
    if (!user) { router.push('/portal/login?next=/chanda'); return }
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) { toast.error(t('sl.enterAmount')); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('announce_chanda', {
      p_campaign_id: showForm, p_amount: amt, p_message: message.trim() || null, p_is_anonymous: anonymous, p_receipt_url: receiptUrl || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.announced'))
    setShowForm(null); setAmount(''); setMessage(''); setAnonymous(false); setReceiptUrl('')
    load()
  }

  const copyLink = () => { navigator.clipboard.writeText(window.location.href); toast.success(t('ch.linkCopiedShare')) }

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1.5">
        <div className="flex items-center gap-2.5">
          <Landmark size={26} className="text-dp-primary" />
          <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('ch.pageTitle')}</h1>
        </div>
        <button onClick={copyLink} className="flex items-center gap-2 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-surface-container-low transition-all cursor-pointer">
          <Copy size={14} /> {t('ch.shareLink')}
        </button>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8">{t('ch.pageIntro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : campaigns.length === 0 ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('ch.noneFound')}</p>
      ) : (
        <div className="space-y-5">
          {campaigns.map((c) => {
            const campaignPledges = pledges.filter((p) => p.campaign_id === c.id)
            const confirmed = campaignPledges.filter((p) => p.status === 'received')
            const pending = campaignPledges.filter((p) => p.status === 'pending')
            const confirmedTotal = confirmed.reduce((s, p) => s + Number(p.amount), 0)
            const progressPct = c.target_amount ? Math.min(100, Math.round((confirmedTotal / c.target_amount) * 100)) : 0
            return (
              <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
                {c.cover_image_url && (
                  <div className="relative w-full h-44">
                    <Image src={c.cover_image_url} alt={isUrdu && c.title_ur ? c.title_ur : c.title} fill sizes="(min-width: 900px) 900px, 100vw" className="object-cover" />
                  </div>
                )}
                <div className="p-5">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                  <div>
                    <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`ch.type.${c.type}`)}</span>
                    <p className="font-heading text-[18px] font-bold text-dp-on-surface mt-1">{isUrdu && c.title_ur ? c.title_ur : c.title}</p>
                  </div>
                  <button onClick={() => setShowForm(c.id)} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">{t('ch.donateBtn')}</button>
                </div>
                {/* The work this money is actually for, and its real cost — the two
                    things a donor needs before giving, shown up front rather than
                    buried after the payment details. */}
                {c.target_amount != null && (
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface mb-1.5">
                    {t('ch.costLabel')}: <span className="ltr-num">Rs {c.target_amount.toLocaleString()}</span>
                  </p>
                )}
                {(isUrdu ? c.description_ur : c.description) && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-2">{isUrdu ? c.description_ur : c.description}</p>}
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{methodLabel[c.payment_method]}: <span className="ltr-num font-semibold">{c.account_number}</span>{c.account_title ? ` (${c.account_title})` : ''}</p>

                {c.target_amount != null ? (
                  <div className="mb-3">
                    <div className="flex justify-between font-sans text-[13px] mb-1.5">
                      <span className="text-emerald-700 font-bold">{t('sl.confirmed')}: <span className="ltr-num">Rs {confirmedTotal.toLocaleString()}</span></span>
                      <span className="text-dp-on-surface-variant"><span className="ltr-num">Rs {c.target_amount.toLocaleString()}</span> {t('ch.target')}</span>
                    </div>
                    <div className="h-2.5 w-full bg-dp-surface-container-highest rounded-full overflow-hidden">
                      <div className="h-full bg-dp-secondary transition-all duration-1000" style={{ width: `${progressPct}%` }} />
                    </div>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 ltr-num">{progressPct}% {t('ch.raised')}</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-4 mb-3 font-sans text-[13px]">
                    <span className="text-emerald-700 font-bold">{t('sl.confirmed')}: <span className="ltr-num">Rs {confirmedTotal.toLocaleString()}</span></span>
                  </div>
                )}

                {campaignPledges.length > 0 && (
                  <div className="max-h-48 overflow-y-auto space-y-1.5 border-t border-dp-outline-variant pt-3">
                    {[...confirmed, ...pending].map((p) => (
                      <div key={p.id} className="flex items-center justify-between font-sans text-[12.5px]">
                        <span className="text-dp-on-surface">{p.giver_name}</span>
                        <span className={`ltr-num font-semibold ${p.status === 'received' ? 'text-emerald-700' : 'text-amber-700'}`}>Rs {Number(p.amount).toLocaleString()}{p.status === 'pending' ? ` (${t('sl.pending')})` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-heading text-[18px] font-bold text-dp-primary mb-4">{t('ch.donateBtn')}</h3>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sl.amount')}</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="input-field mb-3" />
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sl.message')}</label>
            <input value={message} onChange={(e) => setMessage(e.target.value)} className="input-field mb-3" />
            <label className="flex items-center gap-2 cursor-pointer mb-4"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('sl.anonymous')}</span></label>
            <div className="mb-4">
              <ImageUpload bucket="salami_receipts" currentUrl={receiptUrl} onUpload={setReceiptUrl} label={t('sl.receiptOptional')} />
            </div>
            <button onClick={announce} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('p.saving') : t('sl.submit')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
