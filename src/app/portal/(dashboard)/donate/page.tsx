'use client'

import { Suspense, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useRouter, useSearchParams } from 'next/navigation'
import { HeartHandshake, CheckCircle, CheckSquare, Square } from 'lucide-react'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { PaymentAccountDetails } from '@/components/public/PaymentAccountDetails'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { SearchableField, type PickerItem } from '@/components/admin/SearchablePicker'
import { fetchDonationTargets, parseDonationTargetId, encodeProjectTarget } from '@/lib/donationTargets'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface DonationRow { id: string; amount_pkr: number; payment_status: string; is_verified: boolean }
interface PoolPending { id: string; source: 'pool'; amount_pkr: number; has_proof: boolean; particular: string }
interface PendingItem { key: string; kind: 'donor' | 'pool'; id: string; amount: number; label: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function PortalDonatePage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>}>
      <PortalDonatePageInner />
    </Suspense>
  )
}

// Logged-in donate flow — unlike /donate/submit (the anonymous, unauthenticated
// form), identity (name/father's name/WhatsApp) is already known from the
// session, so this only asks what the donor form genuinely can't infer:
// amount, project, method, receipt, anonymity preference.
//
// Also the second door into combined payments (My Giving is the first) — a
// donor who already has something pending sees it right here, right when
// they're about to send money anyway, and can fold it into the very same
// transfer instead of paying a second banking fee to settle it separately.
// Never forced: leaving every box unticked submits exactly the plain new
// donation this page always did.
function PortalDonatePageInner() {
  const { t, isUrdu, locale } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [targetItems, setTargetItems] = useState<PickerItem[]>([])
  const [amount, setAmount] = useState(0)
  // A raw ?project=<uuid> (the existing, still-used contract from the
  // project detail page / academy fee links) wins over the picker's own
  // default; otherwise the list's default (کمیٹی اکاؤنٹ Main) applies once
  // it has loaded.
  const projectParam = searchParams.get('project')
  const [targetId, setTargetId] = useState(projectParam ? encodeProjectTarget(projectParam) : '')
  const [method, setMethod] = useState('bank')
  const [isAnonymous, setIsAnonymous] = useState(false)
  const [international, setInternational] = useState(false)
  const [receiptPath, setReceiptPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const [pendingItems, setPendingItems] = useState<PendingItem[]>([])
  const [selectedPending, setSelectedPending] = useState<Set<string>>(new Set())
  const [pendingLoaded, setPendingLoaded] = useState(false)

  // Their profile's own donor_type is the best first guess — an overseas
  // donor doesn't need to re-declare it every time — but it stays editable
  // here in case they're travelling, or the profile is just out of date.
  useEffect(() => {
    if (user?.donor_type === 'overseas') { setInternational(true); setMethod('bank') }
  }, [user])

  useEffect(() => {
    const supabase = createClient()
    fetchDonationTargets(supabase, locale).then(({ items, defaultTargetId }) => {
      setTargetItems(items)
      setTargetId((current) => current || defaultTargetId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    Promise.all([
      supabase.from('donors').select('id, amount_pkr, payment_status, is_verified').eq('portal_user_id', user.id).eq('payment_status', 'pledged'),
      supabase.rpc('my_pool_pending_payments'),
    ]).then(([donationsRes, poolRes]) => {
      const pledges = (donationsRes.data ?? []) as DonationRow[]
      const poolNeedsPay = ((poolRes.data ?? []) as PoolPending[]).filter((p) => !p.has_proof)
      setPendingItems([
        ...pledges.map((p): PendingItem => ({ key: `donor:${p.id}`, kind: 'donor', id: p.id, amount: p.amount_pkr, label: 'General giving' })),
        ...poolNeedsPay.map((p): PendingItem => ({ key: `pool:${p.id}`, kind: 'pool', id: p.id, amount: p.amount_pkr, label: p.particular })),
      ])
      setPendingLoaded(true)
    })
  }, [user])

  const togglePending = (key: string) => {
    const next = new Set(selectedPending)
    if (next.has(key)) next.delete(key); else next.add(key)
    setSelectedPending(next)
  }

  const selectedPendingItems = pendingItems.filter((i) => selectedPending.has(i.key))
  const pendingTotal = selectedPendingItems.reduce((s, i) => s + i.amount, 0)
  const grandTotal = pendingTotal + (amount || 0)

  const submit = async () => {
    if (!user) return
    if (grandTotal <= 0 || !receiptPath) { toast.error('Enter a valid amount and upload your payment slip'); return }
    setSaving(true)
    const supabase = createClient()
    const { projectId, fundType } = parseDonationTargetId(targetId)

    if (selectedPendingItems.length === 0) {
      // Unchanged path — exactly what this page always did when nothing
      // pending is involved.
      const { error } = await supabase.from('donors').insert({
        name: user.display_name || user.username || user.full_name, name_ur: user.name_ur, phone: user.mobile, whatsapp_number: user.whatsapp_number,
        father_husband_name: user.father_husband_name, donor_type: user.donor_type ?? 'villager',
        amount_pkr: amount, date: new Date().toISOString().split('T')[0],
        payment_method: method, project_id: projectId, fund_type: fundType, is_anonymous: isAnonymous,
        payment_proof_url: receiptPath, is_verified: false, submitted_via: 'public',
        // Missing here since this page was first built — a standalone donation
        // (nothing pending to bundle it with) never linked back to the donor's
        // own portal account, so it couldn't appear in their own "Paid,
        // Awaiting Confirmation" list on /portal/statement until an admin
        // confirmed it (at which point the ledger, keyed by phone/name
        // instead, picked it up anyway — the donor just never saw the
        // reassurance in between). submit_combined_pledge_payment (migration
        // 256) already sets this correctly; this path never did.
        portal_user_id: user.id,
      })
      setSaving(false)
      if (error) { toast.error(friendlyError(error)); return }
      setSubmitted(true)
      return
    }

    const donorIds = selectedPendingItems.filter((i) => i.kind === 'donor').map((i) => i.id)
    const poolIds = selectedPendingItems.filter((i) => i.kind === 'pool').map((i) => i.id)
    const { error } = await supabase.rpc('submit_combined_pledge_payment', {
      p_donor_ids: donorIds, p_pool_payment_ids: poolIds, p_proof_url: receiptPath, p_method: method,
      p_new_amount: amount > 0 ? amount : null, p_new_project_id: amount > 0 ? projectId : null,
      p_new_is_anonymous: isAnonymous, p_new_fund_type: amount > 0 ? fundType : 'general',
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    setSubmitted(true)
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  if (submitted) {
    return (
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white border border-dp-outline-variant rounded-lg p-12 text-center max-w-md mx-auto">
        <CheckCircle size={48} className="text-dp-secondary mx-auto mb-4" />
        <h2 className="font-heading text-[22px] font-bold text-dp-primary mb-2">{t('p.thankYou')}</h2>
        <p className="text-dp-on-surface-variant font-sans text-[14px] mb-6">
          {t('p.donationAnnouncedNote')}
        </p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => { setSubmitted(false); setAmount(0); setReceiptPath(''); setSelectedPending(new Set()) }} className="px-5 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-surface-container">{t('p.donateAgain')}</button>
          <button onClick={() => router.push('/portal/statement')} className="px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary">{t('p.viewMyStatement')}</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HeartHandshake size={22} className="text-dp-secondary" /> {t('p.makeDonation')} <PortalHelp pageKey="donate" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.donatingAs')} {user?.full_name} · <span className="ltr-num">{user?.mobile}</span></p>
      </div>

      {/* ── Also settle these? ───────────────────────────────────────────
          Shown only when something is actually pending — a donor with
          nothing owed sees the plain donation form exactly as before.
          Entirely optional: every checkbox left unticked submits just the
          new gift below, same as this page always did. */}
      {pendingLoaded && pendingItems.length > 0 && (
        <div className="bg-white rounded-lg border border-amber-200 overflow-hidden mb-4 max-w-md">
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="px-5 py-3 border-b border-amber-200 bg-amber-50">
            <span className="font-sans text-[14px] font-bold text-amber-800">{t('p.alsoSettle')}</span>
            <p className="font-sans text-[12px] text-amber-800 mt-0.5">{t('p.alsoSettleHint')}</p>
          </div>
          {pendingItems.map((item) => (
            <button key={item.key} onClick={() => togglePending(item.key)}
              className="w-full flex items-center justify-between gap-3 px-5 py-3 border-b border-dp-outline-variant last:border-b-0 text-start cursor-pointer hover:bg-dp-surface-container-low/60 transition-all">
              <div className="flex items-center gap-3 min-w-0">
                {selectedPending.has(item.key) ? <CheckSquare size={17} className="text-dp-secondary shrink-0" /> : <Square size={17} className="text-dp-on-surface-variant shrink-0" />}
                <p dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[13.5px] text-dp-on-surface truncate">{item.label === 'General giving' ? t('p.generalGiving') : item.label}</p>
              </div>
              <p className="font-sans text-[13.5px] font-bold shrink-0">{fmt(item.amount)}</p>
            </button>
          ))}
        </div>
      )}

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md space-y-4">
        <div dir={isUrdu ? 'rtl' : 'ltr'}>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
          <input type="number" min={0} value={amount || ''} onChange={(e) => setAmount(+e.target.value)} className="input-field" />
          {selectedPendingItems.length > 0 && (
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('p.leaveZeroIfOnlySettling')}</p>
          )}
        </div>
        <div dir={isUrdu ? 'rtl' : 'ltr'}>
          <SearchableField
            label={t('dt.selectDonationTarget')} value={targetId} onChange={setTargetId}
            items={targetItems} pickerTitle={t('dt.selectDonationTarget')}
            searchPlaceholder={t('dt.searchAccounts')} compact
          />
        </div>
        <label dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-start gap-2.5 cursor-pointer font-sans text-[13.5px] text-dp-on-surface">
          <input type="checkbox" checked={international}
            onChange={(e) => { setInternational(e.target.checked); if (e.target.checked) setMethod('bank') }}
            className="accent-dp-secondary mt-0.5" />
          {t('p.sendingFromAbroad')}
        </label>
        <div dir={isUrdu ? 'rtl' : 'ltr'}>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
          <select value={method} disabled={international} onChange={(e) => setMethod(e.target.value)} className="input-field disabled:opacity-60">
            <option value="bank">{t('w.bankTransfer')}</option>
            {!international && <option value="cash">{t('w.cash')}</option>}
          </select>
          <PaymentAccountDetails system="donors_projects" method={method} international={international} />
        </div>
        <DonationReceiptUpload onUpload={setReceiptPath} />
        <label dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} className="accent-dp-secondary" />
          <span className="font-sans text-[14px]">{t('p.keepAnonymous')}</span>
        </label>

        {selectedPendingItems.length > 0 && (
          <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 flex items-center justify-between">
            <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{t('p.totalToSend')}</p>
            <p className="font-heading text-[19px] font-bold text-dp-secondary">{fmt(grandTotal)}</p>
          </div>
        )}

        <button onClick={submit} disabled={saving || grandTotal <= 0} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          {saving ? t('p.submitting') : t('p.submitDonation')}
        </button>
      </div>
    </div>
  )
}
