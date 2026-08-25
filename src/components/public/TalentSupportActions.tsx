'use client'

// Client island for the public Talent Showcase card — everything the page
// itself can't do as a cached Server Component: knowing who's logged in,
// taking a pledge, or taking an "I can help" offer. Mirrors the pledge
// pattern projects/[id]/page.tsx already uses (donors row, is_verified
// false, payment_status 'pledged'), just pointed at talent_showcase_id
// instead of project_id, plus a second, non-monetary path for people who
// want to help with something other than money.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { HandHeart, Wallet, X, CheckCircle2, Award } from 'lucide-react'

function fmt(n: number) {
  return Math.round(n).toLocaleString()
}

interface Props {
  talentShowcaseId: string
  needsAmountPkr: number | null
  supportStatus: string
}

export function TalentSupportActions({ talentShowcaseId, needsAmountPkr, supportStatus }: Props) {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const [raised, setRaised] = useState(0)
  const [mode, setMode] = useState<'none' | 'pledge' | 'help'>('none')
  const [amount, setAmount] = useState('')
  const [helpMessage, setHelpMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [supporterNames, setSupporterNames] = useState<string[]>([])

  useEffect(() => {
    if (!needsAmountPkr) return
    createClient().rpc('talent_showcase_raised', { p_id: talentShowcaseId }).then(({ data }) => setRaised(Number(data ?? 0)))
  }, [talentShowcaseId, needsAmountPkr])

  // Credit for who helped — admin-curated (migration 344), shown once
  // there's at least one, regardless of exact support_status, so partial
  // help is credited just as visibly as a fully met need.
  useEffect(() => {
    createClient().from('talent_showcase_supporters_public').select('name').eq('talent_showcase_id', talentShowcaseId).order('created_at')
      .then(({ data }) => setSupporterNames((data ?? []).map((s) => s.name)))
  }, [talentShowcaseId])

  const requireLogin = async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { toast.error(t('talent.loginToSupport')); router.push(`/portal/login?next=/talent`); return null }
    const { data: pu } = await supabase.from('portal_users')
      .select('id, full_name, username, display_name, name_ur, mobile, whatsapp_number, donor_type')
      .eq('auth_user_id', user.id).maybeSingle()
    if (!pu) { toast.error(t('talent.loginToSupport')); router.push(`/portal/login?next=/talent`); return null }
    return pu
  }

  const submitPledge = async () => {
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) { toast.error(t('talent.invalidAmount')); return }
    setBusy(true)
    const pu = await requireLogin()
    if (!pu) { setBusy(false); return }
    const supabase = createClient()
    const { error } = await supabase.from('donors').insert({
      name: pu.display_name || pu.username || pu.full_name, name_ur: pu.name_ur, phone: pu.mobile, whatsapp_number: pu.whatsapp_number,
      donor_type: pu.donor_type ?? 'villager', amount_pkr: amt, date: new Date().toISOString().split('T')[0],
      payment_method: 'jazzcash', talent_showcase_id: talentShowcaseId, is_anonymous: false, is_verified: false, submitted_via: 'public',
      payment_status: 'pledged', portal_user_id: pu.id,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('talent.pledgeSuccess'))
    setMode('none')
    setAmount('')
    const { data } = await supabase.rpc('talent_showcase_raised', { p_id: talentShowcaseId })
    setRaised(Number(data ?? 0))
  }

  const submitHelp = async () => {
    if (!helpMessage.trim()) { toast.error(t('talent.helpMessageRequired')); return }
    setBusy(true)
    const pu = await requireLogin()
    if (!pu) { setBusy(false); return }
    const supabase = createClient()
    const { error } = await supabase.from('talent_showcase_help_offers').insert({
      talent_showcase_id: talentShowcaseId, portal_user_id: pu.id, message: helpMessage.trim(),
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('talent.helpSent'))
    setMode('none')
    setHelpMessage('')
  }

  if (supportStatus === 'fulfilled') {
    return (
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mt-3">
        <p className="inline-flex items-center gap-1.5 text-dp-secondary font-sans text-[12.5px] font-semibold">
          <CheckCircle2 size={14} /> {t('talent.needsMet')}
        </p>
        {supporterNames.length > 0 && (
          <p className="mt-1 flex items-start gap-1.5 font-sans text-[11.5px] text-dp-on-surface-variant">
            <Award size={13} className="text-dp-secondary shrink-0 mt-0.5" /> {t('talent.supportedByColon')} {supporterNames.join(isUrdu ? '، ' : ', ')}
          </p>
        )}
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="mt-3">
      {needsAmountPkr ? (
        <div className="mb-2.5">
          <div className="h-1.5 rounded-full bg-dp-surface-container-low overflow-hidden">
            <div className="h-full bg-dp-secondary rounded-full transition-all" style={{ width: `${Math.min(100, (raised / needsAmountPkr) * 100)}%` }} />
          </div>
          <div className="flex items-center justify-between mt-1 font-sans text-[11px] text-dp-on-surface-variant">
            <span>{t('talent.raisedColon')} Rs. {fmt(raised)}</span>
            <span>{t('talent.targetColon')} Rs. {fmt(needsAmountPkr)}</span>
          </div>
          {supportStatus === 'partially_supported' && (
            <p className="mt-1 font-sans text-[11px] text-amber-700 font-semibold">{t('talent.partiallySupported')}</p>
          )}
          {supporterNames.length > 0 && (
            <p className="mt-1 flex items-start gap-1.5 font-sans text-[11px] text-dp-on-surface-variant">
              <Award size={12} className="text-dp-secondary shrink-0 mt-0.5" /> {t('talent.supportedByColon')} {supporterNames.join(isUrdu ? '، ' : ', ')}
            </p>
          )}
        </div>
      ) : null}

      {mode === 'none' && (
        <div className="flex items-center gap-2 flex-wrap">
          {needsAmountPkr ? (
            <button onClick={() => setMode('pledge')} className="inline-flex items-center gap-1.5 bg-dp-secondary text-white px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
              <Wallet size={13} /> {t('talent.supportButton')}
            </button>
          ) : null}
          <button onClick={() => setMode('help')} className="inline-flex items-center gap-1.5 border border-dp-secondary text-dp-secondary px-3 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer hover:bg-dp-secondary/5 transition-all">
            <HandHeart size={13} /> {t('talent.helpButton')}
          </button>
        </div>
      )}

      {mode === 'pledge' && (
        <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <label className="font-sans text-[12px] font-semibold text-dp-on-surface-variant">{t('talent.pledgeAmountLabel')}</label>
            <button onClick={() => setMode('none')} className="text-dp-on-surface-variant cursor-pointer"><X size={14} /></button>
          </div>
          <input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} className="input-field" autoFocus />
          <button onClick={submitPledge} disabled={busy} className="w-full bg-dp-secondary text-white py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {busy ? t('action.saving') : t('talent.pledgeSubmit')}
          </button>
        </div>
      )}

      {mode === 'help' && (
        <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <label className="font-sans text-[12px] font-semibold text-dp-on-surface-variant">{t('talent.helpMessageLabel')}</label>
            <button onClick={() => setMode('none')} className="text-dp-on-surface-variant cursor-pointer"><X size={14} /></button>
          </div>
          <textarea value={helpMessage} onChange={(e) => setHelpMessage(e.target.value)} placeholder={t('talent.helpMessagePlaceholder')} rows={2} className="input-field resize-none" autoFocus />
          <button onClick={submitHelp} disabled={busy} className="w-full bg-dp-secondary text-white py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {busy ? t('action.saving') : t('talent.helpSubmit')}
          </button>
        </div>
      )}
    </div>
  )
}
