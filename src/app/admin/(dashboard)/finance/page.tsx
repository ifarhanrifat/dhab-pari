'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// This used to be a two-card picker ("Water Supply" / "Donors & Projects")
// that every visitor saw regardless of which books their account actually
// covers — an extra click before the real workspace, and a dead end for
// someone with only one system's access if they picked the other card. The
// workspace itself (/admin/finance/[system]) now carries its own in-page
// system tabs (same access-gated pattern as All Transactions), so this route
// only needs to land the visitor on their default system.
export default function FinanceIndexRedirect() {
  const router = useRouter()
  const access = useSystemAccess()
  const { t } = useLocale()

  useEffect(() => {
    if (access.loading) return
    router.replace(`/admin/finance/${access.defaultSystem}`)
  }, [access.loading, access.defaultSystem, router])

  return <div className="text-center py-16 font-sans text-[14px] text-dp-on-surface-variant">{t('action.loading')}</div>
}
