'use client'

import Link from 'next/link'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { T } from '@/components/i18n/T'
import type { PaymentAccount } from '@/lib/paymentAccounts'

/**
 * The home page's "Donate Now" sidebar card used to show a fake JazzCash
 * number and a placeholder HBL account (SITE constants, never the real
 * data in site_settings) — a donor copying either would send money nowhere.
 * Same real UBL account the /donate page and donation forms now use,
 * just themed for this card's dark green background.
 */
function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useLocale()
  if (!value) return null
  const copy = async () => {
    await navigator.clipboard.writeText(value.replace(/\s+/g, ''))
    toast.success(t('p.copied'))
  }
  return (
    <div className="bg-white/10 p-3 rounded border border-white/20">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <p className="text-[10px] uppercase font-bold opacity-60 font-sans">{label}</p>
        <button onClick={copy} title={t('p.copy')} className="shrink-0 text-white/80 hover:text-white cursor-pointer">
          <Copy size={13} />
        </button>
      </div>
      <p className="font-mono text-[16px] font-semibold break-all">{value}</p>
    </div>
  )
}

export function HomeDonateCard({ account }: { account: PaymentAccount }) {
  const { t } = useLocale()
  return (
    <div className="bg-dp-secondary text-white rounded-lg p-6 relative overflow-hidden">
      <div className="relative z-10">
        <h3 className="text-[20px] font-sans font-semibold leading-[28px] mb-2"><T k="home.donateNow" /></h3>
        <p className="text-[14px] font-sans font-semibold tracking-[0.05em] opacity-90 mb-6">
          <T k="home.donateBlurb" />
        </p>
        <div className="bg-white/10 p-3 rounded border border-white/20 mb-4">
          <p className="text-[10px] uppercase font-bold opacity-60 font-sans">{t('p.bankLabel')}</p>
          <p className="font-sans text-[15px] font-bold">{account.bankName}</p>
          <p className="text-[11px] mt-1 font-sans opacity-80">{account.bankAccountTitle}</p>
        </div>
        <div className="space-y-4">
          <CopyRow label={t('p.accountNumber')} value={account.bankAccountNumber} />
          <CopyRow label={t('p.iban')} value={account.bankIban} />
        </div>
        <p className="text-[11.5px] font-sans font-semibold opacity-90 mt-4 leading-snug">
          {t('p.payOnlyNote')}
        </p>
        <Link
          href="/donate"
          className="block w-full mt-6 py-3 bg-white text-dp-secondary rounded-lg text-center font-bold font-sans hover:bg-dp-secondary-container transition-all"
        >
          <T k="home.submitReceipt" />
        </Link>
      </div>
      <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-white/10 rounded-full blur-2xl" />
    </div>
  )
}
