'use client'

import { Building2, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { T } from '@/components/i18n/T'
import type { PaymentAccount } from '@/lib/paymentAccounts'

/**
 * The one real way to pay, shown on the public /donate page. Unlike
 * PaymentAccountDetails (which picks account-number-OR-IBAN based on
 * whether the donor said they're sending from abroad), this page has no
 * such context to go on, so both are shown — a villager copies the
 * account number, an overseas donor copies the IBAN, same card.
 */
function CopyRow({ label, value }: { label: string; value: string }) {
  const { t, isUrdu } = useLocale()
  if (!value) return null
  const copy = async () => {
    await navigator.clipboard.writeText(value.replace(/\s+/g, ''))
    toast.success(t('p.copied'))
  }
  return (
    <div className="bg-white border-2 border-dp2-gold/40 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[12px] font-bold uppercase tracking-wide text-dp2-primary-dark mb-0.5">{label}</p>
        <p className="font-mono text-[17px] font-bold text-slate-800 tracking-wide break-all">{value}</p>
      </div>
      <button onClick={copy} title={t('p.copy')} className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-dp2-primary-dark text-white rounded-xl hover:brightness-110 transition-colors cursor-pointer">
        <Copy size={14} />
        <span className="font-sans text-[13px] font-semibold hidden sm:inline">{t('p.copy')}</span>
      </button>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  const { isUrdu } = useLocale()
  if (!value) return null
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[13px] text-slate-500 shrink-0">{label}</span>
      {/* Real bug, confirmed live on device: "Ismail Abid and Afsar Alam"
          rendered as "hail Abid and Afsar Alam", clipped off the LEFT
          edge — min-w-0 here is a different flex row than the one fixed
          in PublicChrome2 (that fix only reaches its own direct children,
          not every nested flex container down the tree), and this value
          span had no width constraint or wrap protection of its own at
          all. min-w-0 lets the row actually respect its container's
          width instead of growing to fit the text unbroken; break-words
          is what then lets a long name/address wrap onto a second line
          inside that constrained width rather than overflow it. */}
      <span className="font-sans text-[14px] font-semibold text-slate-800 text-end min-w-0 break-words">{value}</span>
    </div>
  )
}

export function BankAccountCard({ account }: { account: PaymentAccount }) {
  const { t, isUrdu } = useLocale()
  return (
    <div className="bg-white border-2 border-dp2-gold/40 p-8 flex flex-col items-center text-center rounded-2xl md:col-span-1">
      <div className="w-16 h-16 mb-6 flex items-center justify-center bg-dp2-surface rounded-xl">
        <Building2 size={32} className="text-dp2-primary-dark" />
      </div>
      <h3 className="font-sans text-[21px] font-semibold leading-[29px] mb-1">{account.bankName}</h3>
      <p className="text-slate-500 mb-4 font-sans text-[17px]">
        <T k="x.directWire" />
      </p>
      <div className="w-full space-y-0.5 mb-4 text-start">
        <Field label={t('p.accountTitle')} value={account.bankAccountTitle} />
        <Field label={t('p.branch')} value={account.bankBranch} />
        <Field label={t('p.branchCode')} value={account.bankBranchCode} />
      </div>
      <div className="w-full space-y-3">
        <CopyRow label={t('p.accountNumber')} value={account.bankAccountNumber} />
        <CopyRow label={t('p.iban')} value={account.bankIban} />
      </div>
      <p className={`mt-5 text-dp2-primary-dark text-[14px] font-sans font-bold tracking-[0.02em] ${isUrdu ? 'leading-[23px]' : 'leading-[21px]'}`}>
        {t('p.payOnlyNote')}
      </p>
    </div>
  )
}
