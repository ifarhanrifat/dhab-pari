'use client'

import { Suspense, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useRouter, useSearchParams } from 'next/navigation'
import { HeartHandshake, CheckCircle } from 'lucide-react'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { PaymentAccountDetails } from '@/components/public/PaymentAccountDetails'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Project { id: string; title: string }

export default function PortalDonatePage() {
  const { t } = useLocale()
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>}>
      <PortalDonatePageInner />
    </Suspense>
  )
}

// Logged-in donate flow — unlike /donate/submit (the anonymous, unauthenticated
// form), identity (name/father's name/WhatsApp) is already known from the
// session, so this only asks what the donor form genuinely can't infer:
// amount, project, method, receipt, anonymity preference.
function PortalDonatePageInner() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [projects, setProjects] = useState<Project[]>([])
  const [amount, setAmount] = useState(0)
  const [projectId, setProjectId] = useState(searchParams.get('project') ?? '')
  const [method, setMethod] = useState('jazzcash')
  const [isAnonymous, setIsAnonymous] = useState(false)
  const [international, setInternational] = useState(false)
  const [receiptPath, setReceiptPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // Their profile's own donor_type is the best first guess — an overseas
  // donor doesn't need to re-declare it every time — but it stays editable
  // here in case they're travelling, or the profile is just out of date.
  useEffect(() => {
    if (user?.donor_type === 'overseas') { setInternational(true); setMethod('bank') }
  }, [user])

  useEffect(() => {
    const supabase = createClient()
    supabase.from('projects').select('id, title').neq('status', 'upcoming').order('title').then(({ data }) => setProjects(data ?? []))
  }, [])

  const submit = async () => {
    if (!user) return
    if (!amount || amount <= 0 || !receiptPath) { toast.error('Enter a valid amount and upload your payment slip'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('donors').insert({
      name: user.full_name, name_ur: user.name_ur, phone: user.mobile, whatsapp_number: user.whatsapp_number,
      father_husband_name: user.father_husband_name, donor_type: user.donor_type ?? 'villager',
      amount_pkr: amount, date: new Date().toISOString().split('T')[0],
      payment_method: method, project_id: projectId || null, is_anonymous: isAnonymous,
      payment_proof_url: receiptPath, is_verified: false, submitted_via: 'public',
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    setSubmitted(true)
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  if (submitted) {
    return (
      <div className="bg-white border border-dp-outline-variant rounded-lg p-12 text-center max-w-md mx-auto">
        <CheckCircle size={48} className="text-dp-secondary mx-auto mb-4" />
        <h2 className="font-heading text-[22px] font-bold text-dp-primary mb-2">{t('p.thankYou')}</h2>
        <p className="text-dp-on-surface-variant font-sans text-[14px] mb-6">
          Your donation will appear as &quot;Announced&quot; until our accountant verifies it against the payment record. You&apos;ll be notified once verified.
        </p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => { setSubmitted(false); setAmount(0); setReceiptPath('') }} className="px-5 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-surface-container">{t('p.donateAgain')}</button>
          <button onClick={() => router.push('/portal/statement')} className="px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary">{t('p.viewMyStatement')}</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><HeartHandshake size={22} className="text-dp-secondary" /> {t('p.makeDonation')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Donating as {user?.full_name} · {user?.mobile}</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md space-y-4">
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
          <input type="number" min={1} value={amount || ''} onChange={(e) => setAmount(+e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.project')}</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input-field">
            <option value="">{t('w.generalFund')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>
        <label className="flex items-start gap-2.5 cursor-pointer font-sans text-[13.5px] text-dp-on-surface">
          <input type="checkbox" checked={international}
            onChange={(e) => { setInternational(e.target.checked); if (e.target.checked) setMethod('bank') }}
            className="accent-dp-secondary mt-0.5" />
          {t('p.sendingFromAbroad')}
        </label>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
          <select value={method} disabled={international} onChange={(e) => setMethod(e.target.value)} className="input-field disabled:opacity-60">
            {!international && <option value="jazzcash">{t('w.jazzcash')}</option>}
            {!international && <option value="easypaisa">{t('w.easypaisa')}</option>}
            <option value="bank">{t('w.bankTransfer')}</option>
            {!international && <option value="cash">{t('w.cash')}</option>}
          </select>
          <PaymentAccountDetails system="donors_projects" method={method} international={international} />
        </div>
        <DonationReceiptUpload onUpload={setReceiptPath} />
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} className="accent-dp-secondary" />
          <span className="font-sans text-[14px]">{t('p.keepAnonymous')}</span>
        </label>
        <button onClick={submit} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          {saving ? 'Submitting...' : 'Submit Donation'}
        </button>
      </div>
    </>
  )
}
