'use client'

import Link from 'next/link'
import { Lock } from 'lucide-react'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type SystemTab = 'water_supply' | 'donors_projects'

const LABEL: Record<SystemTab, string> = {
  water_supply: 'Water Supply',
  donors_projects: 'Donors & Projects',
}

/**
 * Refuses a page belonging to an accounting system this user cannot access.
 *
 * These routes take the system from the URL (/admin/finance/water_supply/…),
 * so hiding the menu item is not enough — the address is guessable and gets
 * shared between staff. Without this, a donor accountant opening a water
 * supply link saw the full workspace chrome with every panel empty, which
 * reads as "the system is broken" rather than "this is not yours".
 *
 * This is not the security boundary. Every RPC behind these pages already
 * calls can_access_system(), and RLS blocks the tables underneath — the data
 * was never reachable. This exists so the refusal is legible instead of
 * looking like a fault, and so nobody wastes an afternoon debugging an empty
 * screen that is working exactly as intended.
 */
export function SystemGuard({ system, children }: { system: SystemTab; children: React.ReactNode }) {
  const { t } = useLocale()
  const access = useSystemAccess()

  if (access.loading) {
    return <div className="text-center py-16 font-sans text-[14px] text-dp-on-surface-variant">{t('y.loadingDots')}</div>
  }

  const allowed = system === 'water_supply' ? access.canWaterSupply : access.canDonorsProjects
  if (allowed) return <>{children}</>

  const other: SystemTab = system === 'water_supply' ? 'donors_projects' : 'water_supply'
  const hasOther = other === 'water_supply' ? access.canWaterSupply : access.canDonorsProjects

  return (
    <div className="max-w-md mx-auto text-center py-20">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-dp-surface-container text-dp-on-surface-variant mb-4">
        <Lock size={24} />
      </div>
      <h1 className="font-heading text-[22px] font-bold text-dp-primary mb-2">
        {LABEL[system]} is not part of your account
      </h1>
      <p className="font-sans text-[14px] text-dp-on-surface-variant leading-relaxed mb-6">
        Your login covers a different set of books. Ask an administrator if you need access
        to {LABEL[system]}.
      </p>
      {hasOther ? (
        <Link
          href={`/admin/finance/${other}`}
          className="inline-block px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all"
        >
          Go to {LABEL[other]}
        </Link>
      ) : (
        <Link
          href="/admin"
          className="inline-block px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all"
        >
          {t('g.backToDashboard')}
        </Link>
      )}
    </div>
  )
}
