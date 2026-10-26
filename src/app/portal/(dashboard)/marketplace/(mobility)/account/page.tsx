'use client'

// Account screen of the new design (v.rAcct) — a mobility-scoped
// snapshot, not a fork of the real shared /portal/profile page (that
// one is portal-wide: donors, water consumers and mentorship
// participants all use it too, with sections that have nothing to do
// with mobility — forking it would mean two places to edit the same
// account). This page is read-only/static content plus one clearly
// labeled link out to the real editing surface.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, LogOut, CreditCard, Users, Bus, Wrench, Landmark, MessageCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { SITE } from '@/lib/constants'

const ROLE_KEYS = ['rider', 'driver', 'owner', 'committee'] as const
const ROLE_ICON: Record<(typeof ROLE_KEYS)[number], typeof Users> = { rider: Users, driver: Bus, owner: Wrench, committee: Landmark }
const ROLE_TINT: Record<(typeof ROLE_KEYS)[number], string> = { rider: '#dcfce7', driver: '#e0f2fe', owner: '#fde68a', committee: '#f3e8ff' }

export default function MobilityAccountPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()
  const [open, setOpen] = useState<(typeof ROLE_KEYS)[number] | null>('rider')

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/portal/login')
    router.refresh()
  }

  if (userLoading || !user) return <div className="text-center py-12"><LoadingDots /></div>

  const initial = (user.full_name || '?').trim().charAt(0).toUpperCase()

  return (
    <div className="flex flex-col gap-3.5">
      <div className="bg-gradient-to-r from-[#005A36] to-[#166534] rounded-2xl p-3.5 flex items-center gap-3 text-white">
        <span className="shrink-0 w-11 h-11 rounded-full bg-[#83f5c6] text-[#00372c] flex items-center justify-center font-extrabold text-[17px]">{initial}</span>
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold truncate">{user.full_name}</p>
          <p className="text-[11.5px] text-white/80 truncate ltr-num">{user.mobile}</p>
        </div>
        <span className="shrink-0 bg-[#D4AF37] text-[#0f172a] text-[9.5px] font-bold px-2 py-1 rounded-full">✓ {t('mb.verifiedBadge')}</span>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-bold text-[#005A36] px-1">{t('mb.howItWorksHeading')}</h2>
        {ROLE_KEYS.map((role) => {
          const isOpen = open === role
          const RoleIcon = ROLE_ICON[role]
          return (
            <div key={role} className="bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden">
              <button onClick={() => setOpen(isOpen ? null : role)} className="w-full flex items-center gap-2.5 p-3 cursor-pointer text-start">
                <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: ROLE_TINT[role] }}><RoleIcon size={16} className="text-[#1e293b]/70" /></span>
                <span className="flex-1 min-w-0 text-[13.5px] font-bold text-[#005A36]">{t(`mb.role.${role}.title`)}</span>
                {isOpen ? <ChevronDown size={16} className="text-[#64748b]" /> : <ChevronRight size={16} className={`text-[#64748b] ${isUrdu ? 'rotate-180' : ''}`} />}
              </button>
              {isOpen && (
                <div className="px-3 pb-3 flex flex-col gap-2">
                  {[1, 2, 3, 4, 5].map((n) => {
                    const step = t(`mb.role.${role}.step${n}`)
                    if (!step || step === `mb.role.${role}.step${n}`) return null
                    return (
                      <div key={n} className="flex items-start gap-2">
                        <span className="shrink-0 w-[18px] h-[18px] rounded-full bg-[#166534] text-white flex items-center justify-center text-[9.5px] font-extrabold mt-0.5">{n}</span>
                        <p className="text-[12px] text-[#334155] leading-[1.6]">{step}</p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </section>

      <section className="bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden">
        <div className="px-3 py-2.5 text-[13px] font-bold text-[#005A36] border-b border-[#f1f5f9] flex items-center gap-1.5"><CreditCard size={14} /> {t('mb.paymentMethodsHeading')}</div>
        <div className="px-3 py-2 flex items-center justify-between gap-2 border-b border-[#f8fafc]"><span className="text-[12.5px] text-[#334155]">💵 {t('mb.payCash')}</span><span className="text-[11.5px] text-[#64748b]">{t('mb.payAlways')}</span></div>
        <div className="px-3 py-2 flex items-center justify-between gap-2 border-b border-[#f8fafc]"><span className="text-[12.5px] text-[#334155]">📱 {t('mb.payJazzCash')}</span><span className="text-[11.5px] text-[#64748b] ltr-num">{SITE.jazzcash}</span></div>
        <div className="px-3 py-2 flex items-center justify-between gap-2"><span className="text-[12.5px] text-[#334155]">📲 {t('mb.payEasypaisa')}</span><span className="text-[11.5px] text-[#64748b] ltr-num">{SITE.easypaisa}</span></div>
      </section>

      <a href={SITE.whatsappLink} target="_blank" rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 bg-[#166534] text-white rounded-2xl py-3 font-bold text-[13.5px]">
        <MessageCircle size={15} /> {t('mb.committeeHelplineBtn')}
      </a>

      <button onClick={handleLogout} className="flex items-center justify-center gap-2 bg-white border border-[#fecaca] text-[#b91c1c] rounded-2xl py-3 font-bold text-[13.5px] cursor-pointer">
        <LogOut size={15} /> {t('nav.logout')}
      </button>
    </div>
  )
}
