'use client'

// Shown once on the Welcome page, right after signup — closes the "silent
// wrong auto-link" gap the plain phone match alone can't: donor_account_id
// gets set automatically at signup (match_donor_account_by_phone, migration
// 357), but nobody ever confirmed it was actually them. This is that
// confirmation, not a second matching pass — the real matching robustness
// (normalizing "+923001234567"/"03001234567"/"0300-1234567" etc. to the
// same number) already happened server-side; this component just surfaces
// the result and gets a real yes/no from the person it's about.
//
// Four states, one component:
//  1. Auto-linked, not yet confirmed -> show the total, ask them to agree.
//  2. No link, but the number turns out to already be claimed by someone
//     else's login -> tell them plainly, point at the committee.
//  3. No link, no match at all -> ask if they've ever donated (cash counts)
//     so a legacy donor with no phone on file isn't left to guess whether
//     there's anything worth asking about.
//  4. Already confirmed -> render nothing.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { HeartHandshake, CheckCircle2, XCircle, PhoneCall, MessageCircleQuestion } from 'lucide-react'
import type { PortalUser } from '@/hooks/usePortalUser'

interface Match {
  account_id: string; donor_account_no: string | null
  name: string; name_ur: string | null
  total_contributed: number; already_claimed: boolean
}

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function DonorLinkVerification({ user, onLinked }: { user: PortalUser; onLinked: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()

  const [checking, setChecking] = useState(true)
  const [total, setTotal] = useState(0)
  const [accountLabel, setAccountLabel] = useState<{ name: string; accountNo: string }>({ name: '', accountNo: '' })
  const [claimedElsewhere, setClaimedElsewhere] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // Sub-flows, all mutually exclusive
  const [showDispute, setShowDispute] = useState(false)
  const [disputeNote, setDisputeNote] = useState('')
  const [showRematch, setShowRematch] = useState(false)
  const [rematchPhone, setRematchPhone] = useState('')
  const [askedBefore, setAskedBefore] = useState<'yes' | 'no' | null>(null)
  const [detailText, setDetailText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    (async () => {
      if (user.donor_account_id) {
        const [{ data: legs }, { data: acct }] = await Promise.all([
          supabase.from('ledger_entries').select('debit, credit').eq('account_id', user.donor_account_id),
          supabase.from('accounts').select('name, name_ur, donor_account_no').eq('id', user.donor_account_id).maybeSingle(),
        ])
        setTotal((legs ?? []).reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0))
        if (acct) setAccountLabel({ name: (isUrdu && acct.name_ur) || acct.name, accountNo: acct.donor_account_no ?? '' })
      } else {
        // Not just a read-only check — an account that was created or
        // matched AFTER this login already existed (this app was deployed
        // without this flow yet, or the donor's own account was only
        // added/corrected later) would otherwise sit unmatched forever,
        // since signup is the only other place a link normally happens.
        // portal_rematch_donor_by_phone links it immediately if it's a
        // real, unclaimed match — refreshing the parent then re-renders
        // this component straight into the confirm state below.
        const { data } = await supabase.rpc('portal_rematch_donor_by_phone', { p_phone: user.mobile }).maybeSingle<Match>()
        if (data?.account_id) {
          if (data.already_claimed) setClaimedElsewhere(true)
          else { onLinked(); return }
        }
      }
      setChecking(false)
    })()
    // Re-runs when donor_account_id changes — specifically the moment the
    // "else" branch above links one and calls onLinked(), so this fetches
    // the now-real total/account label instead of leaving the confirm
    // card below showing Rs. 0.00 from before the link existed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.donor_account_id])

  const confirm = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('portal_confirm_donor_link')
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.donorLinkConfirmedToast'))
    onLinked()
  }

  const dispute = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('portal_dispute_donor_link', { p_reason: disputeNote.trim() || null })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.donorLinkDisputedToast'))
    setShowDispute(false)
    onLinked()
  }

  const rematch = async () => {
    if (!rematchPhone.trim()) return
    setBusy(true)
    const { data, error } = await supabase.rpc('portal_rematch_donor_by_phone', { p_phone: rematchPhone.trim() }).maybeSingle<Match>()
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    if (!data?.account_id) { toast.info(t('p.donorLinkNoMatchToast')); return }
    if (data.already_claimed) { setShowRematch(false); setClaimedElsewhere(true); return }
    setShowRematch(false)
    onLinked()
  }

  // No RPC needed here — same direct-insert pattern the portal Complaints
  // page itself already uses (RLS lets a portal user insert their own row).
  const submitLinkRequest = async () => {
    if (!detailText.trim()) return
    setBusy(true)
    const { error } = await supabase.from('complaints').insert({
      system: 'donors_projects', portal_user_id: user.id, complainant_name: user.full_name,
      phone: user.whatsapp_number ?? user.mobile, source: 'website',
      complaint_text: `Donor account link request — member says they've donated before (cash or online) but no matching account was found automatically. Details from member: ${detailText.trim()}`,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.donorLinkFormSentToast'))
    setAskedBefore(null); setDetailText('')
    setDismissed(true)
  }

  if (checking || dismissed) return null
  if (user.donor_account_id && user.donor_link_confirmed_at) return null

  const Card = ({ children }: { children: React.ReactNode }) => (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white rounded-lg border border-dp-outline-variant p-6 md:p-8 w-full max-w-md mb-5">
      {children}
    </div>
  )

  // State 1 — auto-linked, awaiting confirmation.
  if (user.donor_account_id && !user.donor_link_confirmed_at) {
    const body = t('p.donorLinkBody')
      .replace('{amount}', fmt(total))
      .replace('{accountNo}', accountLabel.accountNo)
      .replace('{name}', accountLabel.name)
    return (
      <Card>
        <h2 className="font-sans text-[15px] font-bold text-dp-primary mb-2 flex items-center gap-1.5"><HeartHandshake size={16} /> {t('p.donorLinkTitle')}</h2>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant leading-relaxed">{body}</p>
        <p className="font-heading text-[26px] font-bold text-dp-primary mt-2">Rs. {fmt(total)}</p>

        {!showDispute ? (
          <div className="flex flex-col gap-2 mt-4">
            <button onClick={confirm} disabled={busy} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold text-[14px] cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 flex items-center justify-center gap-1.5">
              <CheckCircle2 size={15} /> {t('p.donorLinkYes')}
            </button>
            <button onClick={() => setShowRematch(true)} disabled={busy} className="w-full border border-dp-outline-variant text-dp-on-surface py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:bg-dp-surface-container-low transition-all flex items-center justify-center gap-1.5">
              <PhoneCall size={14} /> {t('p.donorLinkTryAnother')}
            </button>
            <button onClick={() => setShowDispute(true)} disabled={busy} className="w-full text-dp-error py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-error/5 transition-all flex items-center justify-center gap-1.5">
              <XCircle size={13} /> {t('p.donorLinkNotMe')}
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.donorLinkDisputeNote')}</label>
            <textarea value={disputeNote} onChange={(e) => setDisputeNote(e.target.value)} rows={3} className="input-field" />
            <div className="flex gap-2 mt-3">
              <button onClick={() => setShowDispute(false)} className="flex-1 border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:bg-dp-surface-container-low transition-all">{t('p.donorLinkCancel')}</button>
              <button onClick={dispute} disabled={busy} className="flex-1 bg-dp-error text-white py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:opacity-90 transition-all disabled:opacity-50">{t('p.donorLinkDisputeSubmit')}</button>
            </div>
          </div>
        )}

        {showRematch && (
          <div className="mt-4 pt-4 border-t border-dp-outline-variant">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.donorLinkEnterPhone')}</label>
            <input type="tel" value={rematchPhone} onChange={(e) => setRematchPhone(e.target.value)} placeholder="03XX-XXXXXXX" className="input-field" />
            <button onClick={rematch} disabled={busy} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 mt-3">
              {t('p.donorLinkRematchSubmit')}
            </button>
          </div>
        )}
      </Card>
    )
  }

  // State 2 — this number already belongs to a different portal login.
  if (claimedElsewhere) {
    return (
      <Card>
        <h2 className="font-sans text-[15px] font-bold text-dp-error mb-2 flex items-center gap-1.5"><XCircle size={16} /> {t('p.donorLinkClaimedTitle')}</h2>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant leading-relaxed">{t('p.donorLinkClaimedBody')}</p>
        <button onClick={() => setDismissed(true)} className="w-full border border-dp-outline-variant text-dp-on-surface py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:bg-dp-surface-container-low transition-all mt-4">
          {t('p.donorLinkContactCommittee')}
        </button>
      </Card>
    )
  }

  // State 3 — no match at all; ask, for the legacy-cash-donor case where
  // there was never a phone number on file to match against in the first
  // place.
  return (
    <Card>
      {askedBefore !== 'yes' ? (
        <>
          <h2 className="font-sans text-[15px] font-bold text-dp-primary mb-2 flex items-center gap-1.5"><MessageCircleQuestion size={16} /> {t('p.donorLinkAskTitle')}</h2>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant leading-relaxed">{t('p.donorLinkAskBody')}</p>
          <div className="flex gap-2 mt-4">
            <button onClick={() => setDismissed(true)} className="flex-1 border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:bg-dp-surface-container-low transition-all">{t('p.donorLinkAskNo')}</button>
            <button onClick={() => setAskedBefore('yes')} className="flex-1 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:bg-dp-primary transition-all">{t('p.donorLinkAskYes')}</button>
          </div>
        </>
      ) : (
        <>
          <h2 className="font-sans text-[15px] font-bold text-dp-primary mb-2">{t('p.donorLinkFormTitle')}</h2>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed mb-2">{t('p.donorLinkFormHint')}</p>
          <textarea value={detailText} onChange={(e) => setDetailText(e.target.value)} rows={4} placeholder={t('p.donorLinkFormPlaceholder')} className="input-field" />
          <button onClick={submitLinkRequest} disabled={busy || !detailText.trim()} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold text-[13.5px] cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 mt-3">
            {t('p.donorLinkFormSubmit')}
          </button>
        </>
      )}
    </Card>
  )
}
