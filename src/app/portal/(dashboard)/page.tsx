'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { HeartHandshake, Droplets, MessageSquareWarning, MessageSquare, Repeat, Droplet } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function PortalDashboardPage() {
  const { t } = useLocale()
  const { user, loading } = usePortalUser()
  const [totalDonated, setTotalDonated] = useState(0)
  const [waterOutstanding, setWaterOutstanding] = useState(0)
  const [activeRecurring, setActiveRecurring] = useState(0)

  useEffect(() => {
    if (!user) return
    const supabase = createClient()

    if (user.donor_account_id) {
      supabase.from('ledger_entries').select('debit, credit').eq('account_id', user.donor_account_id).then(({ data }) => {
        const total = (data ?? []).reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0)
        setTotalDonated(total)
      })
    }
    if (user.consumer_id) {
      supabase.from('bills').select('amount_pkr, paid_amount, discount_amount').eq('consumer_id', user.consumer_id).neq('status', 'paid').then(({ data }) => {
        const outstanding = (data ?? []).reduce((s, b) => s + (Number(b.amount_pkr) - Number(b.paid_amount ?? 0) - Number(b.discount_amount ?? 0)), 0)
        setWaterOutstanding(outstanding)
      })
    }
    supabase.from('recurring_schedules').select('id', { count: 'exact', head: true })
      .eq('created_by_portal_user_id', user.id).eq('is_active', true).then(({ count }) => setActiveRecurring(count ?? 0))
  }, [user])

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const cards = [
    { href: '/portal/statement', icon: HeartHandshake, label: 'Total Donated', value: `Rs. ${fmt(totalDonated)}`, color: 'text-dp-secondary' },
    ...(user.consumer_id ? [{ href: '/portal/water', icon: Droplets, label: 'Water Bills Outstanding', value: `Rs. ${fmt(waterOutstanding)}`, color: waterOutstanding > 0 ? 'text-dp-error' : 'text-dp-secondary' }] : []),
    { href: '/portal/recurring', icon: Repeat, label: 'Active Recurring Donations', value: String(activeRecurring), color: 'text-dp-primary' },
  ]

  const links = [
    { href: '/portal/statement', label: 'My Giving Statement', icon: HeartHandshake },
    ...(user.consumer_id ? [{ href: '/portal/water', label: 'Water Bills & Payments', icon: Droplets }] : []),
    { href: '/portal/recurring', label: 'Manage Recurring Donations', icon: Repeat },
    { href: '/portal/suggestions', label: 'Suggestions', icon: MessageSquare },
    { href: '/portal/complaints', label: 'Complaints', icon: MessageSquareWarning },
    { href: '/portal/blood-donor', label: 'Blood Donor Registration', icon: Droplet },
  ]

  return (
    <>
      <div className="mb-8">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">Welcome, {user.full_name}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">
          {user.consumer_id ? `Consumer #${user.consumer_id}` : 'No linked water connection'} · Mobile {user.mobile}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="bg-white border border-dp-outline-variant rounded-lg p-5 hover:border-dp-secondary transition-all">
            <c.icon size={20} className={c.color} />
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant uppercase tracking-wide mt-3">{c.label}</p>
            <p className={`font-heading text-[22px] font-bold mt-1 ${c.color}`}>{c.value}</p>
          </Link>
        ))}
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="flex items-center gap-3 px-5 py-4 border-b border-dp-outline-variant last:border-b-0 hover:bg-dp-surface-container-low transition-all">
            <l.icon size={18} className="text-dp-secondary" />
            <span className="font-sans text-[14px] font-semibold text-dp-on-surface">{l.label}</span>
          </Link>
        ))}
      </div>
    </>
  )
}
