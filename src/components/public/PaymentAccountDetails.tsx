'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Copy, Landmark } from 'lucide-react'
import { toast } from 'sonner'
import { getPaymentAccount, type PaymentAccount } from '@/lib/paymentAccounts'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * "Send it yourself, any of these ways" — but with the real number right
 * there to copy, instead of a donor having to note it down from a screen
 * and retype it into JazzCash/Easypaisa/their banking app by hand.
 *
 * Two completely separate account sets exist (migration 253) — donor/
 * project giving and water-bill payments never share a number — so this
 * always takes an explicit `system` rather than guessing from context,
 * and only ever shows that one system's accounts.
 *
 * donors_projects gets its own richer card: one real bank account, no
 * JazzCash/Easypaisa (the donor-facing pages don't offer those as
 * choices anymore — nothing to render here for them). Every field shows
 * (bank, beneficiary, branch, branch code) so a donor can verify they
 * have the right account, but only the number they'd actually type into
 * their own bank's transfer screen gets a copy button — the account
 * number for a villager, the IBAN for someone sending from abroad, never
 * both, since showing the "wrong" one only invites a mistaken transfer.
 * water_supply is untouched — same plain multi-method list as before.
 */

function Field({ label, value }: { label: string; value: string }) {
  const { isUrdu } = useLocale()
  if (!value) return null
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[12px] text-dp-on-surface-variant shrink-0">{label}</span>
      <span className="font-sans text-[13px] font-semibold text-dp-on-surface text-end">{value}</span>
    </div>
  )
}

function CopyBlock({ label, value }: { label: string; value: string }) {
  const { t, isUrdu } = useLocale()
  const copy = async () => {
    await navigator.clipboard.writeText(value.replace(/\s+/g, ''))
    toast.success(t('p.copied'))
  }
  return (
    <div className="bg-white border-2 border-dp-secondary rounded-lg px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-secondary mb-0.5">{label}</p>
        <p className="font-mono text-[16px] font-bold text-dp-on-surface tracking-wide break-all">{value}</p>
      </div>
      <button onClick={copy} title={t('p.copy')} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-dp-secondary text-white rounded-lg hover:bg-dp-primary transition-colors cursor-pointer">
        <Copy size={14} />
        <span className="font-sans text-[12px] font-semibold hidden sm:inline">{t('p.copy')}</span>
      </button>
    </div>
  )
}

function OldField({ label, value }: { label: string; value: string }) {
  const { t, isUrdu } = useLocale()
  if (!value) return null
  const copy = async () => {
    await navigator.clipboard.writeText(value.replace(/\s+/g, ''))
    toast.success(t('p.copied'))
  }
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <p dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[10.5px] font-bold uppercase tracking-wide text-dp-on-surface-variant">{label}</p>
        <p className="font-mono text-[13.5px] font-semibold text-dp-on-surface truncate">{value}</p>
      </div>
      <button onClick={copy} title={t('p.copy')} className="shrink-0 p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
        <Copy size={14} />
      </button>
    </div>
  )
}

export function PaymentAccountDetails({
  system, method, international = false,
}: { system: 'donors_projects' | 'water_supply'; method: string; international?: boolean }) {
  const { t } = useLocale()
  const [account, setAccount] = useState<PaymentAccount | null>(null)

  useEffect(() => {
    getPaymentAccount(createClient(), system).then(setAccount)
  }, [system])

  if (!account || method === 'cash') return null

  if (system === 'donors_projects') {
    return (
      <div className="bg-dp-surface-container-low border border-dp-outline-variant rounded-xl p-4 mt-2">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-dp-secondary-container text-dp-on-secondary-container shrink-0">
            <Landmark size={16} />
          </span>
          <p className="font-sans text-[13.5px] font-bold text-dp-primary">{t('p.bankTransferHeading')}</p>
        </div>
        <div className="space-y-0.5 mb-3">
          <Field label={t('p.bankLabel')} value={account.bankName} />
          <Field label={t('p.accountTitle')} value={account.bankAccountTitle} />
          <Field label={t('p.branch')} value={account.bankBranch} />
          <Field label={t('p.branchCode')} value={account.bankBranchCode} />
        </div>
        {international ? (
          <CopyBlock label={t('p.iban')} value={account.bankIban} />
        ) : (
          <CopyBlock label={t('p.accountNumber')} value={account.bankAccountNumber} />
        )}
      </div>
    )
  }

  // water_supply — unchanged: the original plain multi-method list.
  const showBank = method === 'bank' || international
  return (
    <div className="bg-dp-surface-container-low rounded-lg px-4 py-2.5 mt-2 divide-y divide-dp-outline-variant/60">
      {method === 'jazzcash' && !international && (
        <>
          <OldField label={t('p.jazzcashNumber')} value={account.jazzcashNumber} />
          <OldField label={t('p.accountTitle')} value={account.jazzcashName} />
        </>
      )}
      {method === 'easypaisa' && !international && (
        <>
          <OldField label={t('p.easypaisaNumber')} value={account.easypaisaNumber} />
          <OldField label={t('p.accountTitle')} value={account.easypaisaName} />
        </>
      )}
      {showBank && (
        <>
          <OldField label={t('p.bankLabel')} value={account.bankName} />
          <OldField label={t('p.accountTitle')} value={account.bankAccountTitle} />
          <OldField label={t('p.accountNumber')} value={account.bankAccountNumber} />
          <OldField label={international ? t('p.ibanInternational') : t('p.iban')} value={account.bankIban} />
          <OldField label={t('p.branch')} value={account.bankBranch} />
          <OldField label={t('p.branchCode')} value={account.bankBranchCode} />
        </>
      )}
    </div>
  )
}
