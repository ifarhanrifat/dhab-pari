'use client'

// 2026-11-21: the redemption half of 946's unified staff invite — a
// brand-new person (no account on dhab pari yet) who got a 6-digit
// code by phone needs somewhere to sign up and redeem it. A driver's
// own invite redeems inline on the vehicle-registration form (they
// have a form to fill either way); a non-driver role has no such form
// to land on, so this is a small dedicated page instead, same code-box
// pattern as that one.

import { useState } from 'react'
import Link from 'next/link'
import { UserCheck, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

export default function FleetJoinPage() {
  const { t, isUrdu } = useLocale()
  const { loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [code, setCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [result, setResult] = useState<{ fleet_name: string; role: string } | null>(null)

  const redeem = async () => {
    if (!code.trim()) return
    setRedeeming(true)
    const { data, error } = await supabase.rpc('redeem_fleet_staff_invite', { p_code: code.trim() })
    setRedeeming(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const r = data as { fleet_name: string; role: string }
    setResult(r)
    setCode('')
    toast.success(t('mv.staffInviteRedeemedToast').replace('{fleet}', r.fleet_name))
  }

  if (userLoading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3 max-w-md mx-auto">
      <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><UserCheck size={17} /> {t('mv.joinFleetHeading')}</h1>
      <p className="font-sans text-[12px] text-[#64748b]">{t('mv.joinFleetHint')}</p>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <div className="flex gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('mv.enterCodePlaceholder')} maxLength={6}
            className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[16px] ltr-num tracking-widest text-center" />
          <button onClick={redeem} disabled={redeeming || !code.trim()} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
            {redeeming ? t('action.loading') : t('mv.joinBtn')}
          </button>
        </div>
      </div>

      {result && (
        <div className="bg-[#F0FDF4] border border-[#bbf7d0] rounded-2xl p-4 flex flex-col gap-2">
          <p className="font-sans text-[13px] font-bold text-[#166534]">
            {t('mv.joinedFleetAsRoleHint').replace('{fleet}', result.fleet_name).replace('{role}', t(`mv.role.${result.role}`))}
          </p>
          <Link href="/portal/fleet" className="inline-flex items-center gap-1 font-sans text-[12.5px] font-semibold text-[#166534]">
            {t('mv.goToFleetDashboardBtn')} <ArrowRight size={13} className={isUrdu ? 'rotate-180' : ''} />
          </Link>
        </div>
      )}
    </div>
  )
}
