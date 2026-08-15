'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Users, ArrowRight } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * The standing ask, on every page of every donor's portal.
 *
 * Deliberately not dismissible and with no per-user read flag. It is driven
 * entirely by pool_alerts(), which returns a pool only while its standing
 * commitments fall short of its monthly cost — so it disappears when enough
 * people have joined and not one moment before. A dismiss button would let a
 * donor make the shortfall invisible without making it smaller.
 *
 * It is measured against commitments, never against cash received, so a month
 * the committee paid for out of its own reserves still shows here. That is the
 * point: the month was covered, the gap was not.
 *
 * Styled as a quiet standing notice rather than an alarm. Something red and
 * urgent on every page for months stops being read within a week.
 */

interface Alert {
  pool_id: string
  code: string
  name: string
  name_ur: string | null
  donors_needed: number
  suggested_share: number
  required: number
  committed: number
  coverage_percent: number
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

// Each pool now lives on its own dedicated page (Kafalat, Wazifa, Sadqa) —
// there is no generic /portal/support to point at any more.
const ROUTE_FOR: Record<string, string> = {
  'POOL-KFL': '/portal/kafalat',
  'POOL-WZF': '/portal/wazifa',
  'POOL-SDQ': '/portal/esal-e-sawab',
}

export function PoolAppealBanner() {
  const { t, isUrdu } = useLocale()
  const [alerts, setAlerts] = useState<Alert[]>([])

  useEffect(() => {
    createClient().rpc('pool_alerts').then(({ data }) => setAlerts((data ?? []) as Alert[]))
  }, [])

  if (!alerts.length) return null

  return (
    <div className="border-b border-dp-outline-variant bg-dp-surface-container-low print:hidden">
      {alerts.map((a) => (
        <Link key={a.pool_id} href={ROUTE_FOR[a.code] ?? '/portal'}
          className="group flex items-center gap-3 px-6 md:px-10 py-2.5 hover:bg-white transition-colors">
          <Users size={16} className="text-dp-secondary shrink-0" />

          <p className="flex-1 min-w-0 font-sans text-[13px] text-dp-on-surface leading-snug">
            <span className="font-bold">
              {isUrdu && a.name_ur ? a.name_ur : a.name}
            </span>
            <span className="text-dp-on-surface-variant">
              {' — '}
              {t('pool.bannerNeeds')
                .replace('{n}', String(a.donors_needed))
                .replace('{amt}', fmt(a.suggested_share))}
            </span>
          </p>

          {/* How far along it is, so the ask reads as progress rather than a
              hole. A bar that has moved is a reason to join; a bar at zero
              that never moves is a reason to assume nobody else cares. */}
          <div className="hidden sm:block w-24 h-1.5 rounded-full bg-dp-outline-variant overflow-hidden shrink-0">
            <div className="h-full bg-dp-secondary rounded-full"
              style={{ width: `${Math.max(a.coverage_percent, 2)}%` }} />
          </div>
          <span className="hidden sm:inline font-heading text-[12px] font-bold text-dp-secondary shrink-0 tabular-nums">
            {a.coverage_percent}%
          </span>

          <ArrowRight size={14}
            className={`text-dp-secondary shrink-0 group-hover:translate-x-0.5 transition-transform ${isUrdu ? 'rotate-180' : ''}`} />
        </Link>
      ))}
    </div>
  )
}
