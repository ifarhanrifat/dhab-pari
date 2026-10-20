'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Copy, HeartHandshake } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { T } from '@/components/i18n/T'
import { SearchableField } from '@/components/admin/SearchablePicker'
import { fetchDonationTargets, parseDonationTargetId } from '@/lib/donationTargets'
import type { PaymentAccount } from '@/lib/paymentAccounts'
import type { PickerItem } from '@/components/admin/SearchablePicker'

/**
 * The home page's "Donate Now" sidebar card used to show a fake JazzCash
 * number and a placeholder HBL account (SITE constants, never the real
 * data in site_settings) — a donor copying either would send money nowhere.
 * Same real UBL account the /donate page and donation forms now use,
 * just themed for this card's dark green background.
 *
 * The button used to link to /donate — the public honor-wall page, not
 * a submission form at all. Same routing DonateCTAButton already uses
 * elsewhere: a signed-in portal user goes straight to their own
 * prefilled /portal/donate flow; everyone else goes to the anonymous
 * /donate/submit form.
 *
 * Real ask, 2026-10-20: an anonymous visitor donating straight from the
 * homepage had no way to say WHICH project their money is for — only
 * the logged-in /portal/donate flow had the project picker. The
 * account itself never changes per project (confirmed: one single
 * donors_projects account serves every project and fund, see
 * paymentAccounts.ts/getPaymentAccount) — only which project the
 * donation gets attributed to does, via the exact same
 * fetchDonationTargets()/SearchableField combo /donate/submit and
 * /portal/donate already both use, so a project picked here just
 * carries through as the same `?project=` param /donate/submit's own
 * picker already reads.
 */
function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useLocale()
  if (!value) return null
  const copy = async () => {
    await navigator.clipboard.writeText(value.replace(/\s+/g, ''))
    toast.success(t('p.copied'))
  }
  return (
    <div className="bg-white/10 p-3 rounded-lg border border-white/15">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <p className="text-[10px] uppercase font-bold opacity-60 font-sans tracking-wide">{label}</p>
        <button onClick={copy} title={t('p.copy')} className="shrink-0 text-white/80 hover:text-white cursor-pointer">
          <Copy size={13} />
        </button>
      </div>
      <p className="font-mono text-[16px] font-semibold break-all">{value}</p>
    </div>
  )
}

export function HomeDonateCard({ account }: { account: PaymentAccount }) {
  const { t, isUrdu, locale } = useLocale()
  const [href, setHref] = useState('/donate/submit')
  const [items, setItems] = useState<PickerItem[]>([])
  const [targetId, setTargetId] = useState('')

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle()
      if (data) setHref('/portal/donate')
    })
    fetchDonationTargets(supabase, locale).then(({ items: rows, defaultTargetId }) => {
      setItems(rows)
      setTargetId(defaultTargetId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])

  const { projectId } = parseDonationTargetId(targetId)
  const finalHref = projectId ? `${href}?project=${projectId}` : href

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="relative bg-gradient-to-br from-dp-secondary to-dp-primary text-white rounded-lg p-6 border border-dp-secondary-container/20 overflow-hidden">
      {/* Same corner-glow depth as the Committee Announcement card next
          to it — opposite corner, same opacity/blur — so the two read
          as one deliberate pair instead of two differently-treated cards. */}
      <div className="absolute -bottom-10 -start-10 w-36 h-36 bg-white/5 rounded-full blur-2xl pointer-events-none" />
      <div className="relative">
        <div className="inline-flex items-center gap-1.5 bg-white/15 rounded-full ps-2 pe-3 py-1 mb-3">
          <span className="bg-white/20 rounded-full p-1"><HeartHandshake size={12} /></span>
          <span className="text-[12px] font-sans font-extrabold uppercase tracking-wide whitespace-nowrap"><T k="home.donateNow" /></span>
        </div>
        <p className="text-[13.5px] font-sans leading-relaxed opacity-95 mb-4">
          <T k="home.donateBlurb" />
        </p>

        <label className="block text-[10px] uppercase font-bold opacity-60 font-sans tracking-wide mb-1.5">{t('dt.selectDonationTarget')}</label>
        <SearchableField
          value={targetId} onChange={setTargetId} items={items}
          pickerTitle={t('dt.selectDonationTarget')} searchPlaceholder={t('dt.searchAccounts')} compact
        />

        <div className="bg-white/10 p-3 rounded-lg border border-white/15 mt-4 mb-4">
          <p className="text-[10px] uppercase font-bold opacity-60 font-sans tracking-wide">{t('p.bankLabel')}</p>
          <p className="font-sans text-[15px] font-bold">{account.bankName}</p>
          <p className="text-[11px] mt-1 font-sans opacity-80">{account.bankAccountTitle}</p>
        </div>
        <div className="space-y-3">
          <CopyRow label={t('p.accountNumber')} value={account.bankAccountNumber} />
          <CopyRow label={t('p.iban')} value={account.bankIban} />
        </div>
        <p className="text-[11.5px] font-sans font-semibold opacity-90 mt-4 leading-snug">
          {t('p.payOnlyNote')}
        </p>
        <Link
          href={finalHref}
          className="block w-full mt-6 py-3 bg-white text-dp-secondary rounded-lg text-center font-bold font-sans hover:bg-dp-secondary-container transition-all"
        >
          <T k="home.submitReceipt" />
        </Link>
      </div>
    </div>
  )
}
