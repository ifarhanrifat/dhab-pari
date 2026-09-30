'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Gift, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageUpload } from '@/components/admin/ImageUpload'

interface Account {
  id: string; side: 'groom' | 'bride'; family_name: string; payment_method: string
  account_number: string; account_title: string | null; bank_name: string | null
}
interface Totals { side: string; status: string; total_amount: number; pledge_count: number }

const methodLabel: Record<string, string> = { easypaisa: 'Easypaisa', jazzcash: 'JazzCash', bank: 'Bank Transfer' }

// Phase 3, 2026-09-30. Public "who's given what" board for a wedding's
// Online Salami, same shape as a project's donor wall (donors_public) --
// no committee cash involved anywhere in this component, every rupee
// moves directly between a guest and the family's own account.
export function SalamiSection({ eventId }: { eventId: string }) {
  const { t } = useLocale()
  const router = useRouter()
  const { user } = usePortalUser()
  const [expanded, setExpanded] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [totals, setTotals] = useState<Totals[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [showForm, setShowForm] = useState<'groom' | 'bride' | null>(null)
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [receiptUrl, setReceiptUrl] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.from('event_salami_accounts_public').select('*').eq('event_id', eventId)
      .then(({ data }) => { setAccounts((data ?? []) as Account[]); setLoading(false) })
  }, [eventId])

  const loadTotals = async () => {
    const supabase = createClient()
    const { data } = await supabase.from('event_salami_totals').select('*').eq('event_id', eventId)
    setTotals((data ?? []) as Totals[])
    setLoaded(true)
  }

  const toggle = () => {
    if (!expanded && !loaded) loadTotals()
    setExpanded(!expanded)
  }

  const announce = async () => {
    if (!user) { router.push(`/portal/login?next=/events`); return }
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) { toast.error(t('sl.enterAmount')); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('announce_salami', {
      p_event_id: eventId, p_side: showForm, p_amount: amt, p_message: message.trim() || null,
      p_is_anonymous: anonymous, p_receipt_url: receiptUrl || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.announced'))
    setShowForm(null); setAmount(''); setMessage(''); setAnonymous(false); setReceiptUrl('')
    loadTotals()
  }

  const copyLink = (acc: Account) => {
    navigator.clipboard.writeText(`${acc.account_number}`)
    toast.success(t('sl.numberCopied'))
  }

  if (loading || accounts.length === 0) return null

  return (
    <div className="mt-4 border-t border-dp-outline-variant pt-4">
      <button onClick={toggle} className="flex items-center gap-2 text-dp-secondary font-sans text-[13.5px] font-bold cursor-pointer">
        <Gift size={16} /> {t('sl.title')} {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-4">
          <p className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 font-sans text-[12px]">{t('sl.disclaimer')}</p>

          {accounts.map((acc) => {
            const confirmedRow = totals.find((r) => r.side === acc.side && r.status === 'received')
            const pendingRow = totals.find((r) => r.side === acc.side && r.status === 'pending')
            const confirmedTotal = Number(confirmedRow?.total_amount ?? 0)
            const pendingTotal = Number(pendingRow?.total_amount ?? 0)
            const confirmedCount = confirmedRow?.pledge_count ?? 0
            const pendingCount = pendingRow?.pledge_count ?? 0
            return (
              <div key={acc.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                  <div>
                    <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`sl.side.${acc.side}`)}</span>
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface mt-1">{acc.family_name}</p>
                  </div>
                  <button onClick={() => setShowForm(acc.side)} className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">{t('sl.announceBtn')}</button>
                </div>
                <button onClick={() => copyLink(acc)} className="flex items-center gap-1.5 font-sans text-[12.5px] text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                  <Copy size={12} /> {methodLabel[acc.payment_method]}: <span className="ltr-num font-semibold">{acc.account_number}</span>{acc.account_title ? ` (${acc.account_title})` : ''}
                </button>
                {/* Totals only -- no per-giver list, real correction
                    2026-09-30: "we should not display the name list on
                    the salami page for village website". The real name
                    stays mandatory in the underlying data (it has to
                    match the family's own bank/Easypaisa statement) --
                    it's just never exposed on this public page. */}
                <div className="grid grid-cols-2 gap-3 mt-3 font-sans text-[12.5px]">
                  <div className="bg-emerald-50 rounded-lg p-2.5">
                    <p className="text-emerald-700 font-bold">{t('sl.confirmed')}: <span className="ltr-num">{confirmedTotal.toLocaleString()}</span></p>
                    <p className="text-emerald-600 text-[11px] mt-0.5">{confirmedCount} {t('sl.contributors')}</p>
                  </div>
                  <div className="bg-amber-50 rounded-lg p-2.5">
                    <p className="text-amber-700 font-bold">{t('sl.pending')}: <span className="ltr-num">{pendingTotal.toLocaleString()}</span></p>
                    <p className="text-amber-600 text-[11px] mt-0.5">{pendingCount} {t('sl.contributors')}</p>
                  </div>
                </div>
              </div>
            )
          })}
          {!loaded && <div className="text-center py-4"><LoadingDots /></div>}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-heading text-[18px] font-bold text-dp-primary mb-4">{t('sl.announceBtn')} — {t(`sl.side.${showForm}`)}</h3>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sl.amount')}</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="input-field mb-3" />
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('sl.message')}</label>
            <input value={message} onChange={(e) => setMessage(e.target.value)} className="input-field mb-3" />
            <label className="flex items-center gap-2 cursor-pointer mb-4"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="accent-dp-secondary" /><span className="font-sans text-[13px]">{t('sl.anonymous')}</span></label>
            <div className="mb-4">
              <ImageUpload bucket="salami_receipts" currentUrl={receiptUrl} onUpload={setReceiptUrl} label={t('sl.receiptOptional')} />
              <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1.5">{t('sl.receiptNote')}</p>
            </div>
            <button onClick={announce} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{saving ? t('p.saving') : t('sl.submit')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
