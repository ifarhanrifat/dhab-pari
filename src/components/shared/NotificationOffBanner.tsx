'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { BellOff, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { useDismissedHint } from '@/hooks/useDismissedHint'

// Replaces the old PushPermissionBanner, 2026-10-02. Real ask: that banner
// re-asked on every single page load forever with no way to make it stop
// ("this is not professional... make it like a professional way once for
// all"). This one is a quiet nudge, not a repeated interruption: it only
// says notifications are off and points at Settings, where the actual
// Enable button now lives (one deliberate place to turn it on, not a
// floating prompt on every page) -- and it can be permanently dismissed
// with a checkbox (migration 562's generic dismissed_hints mechanism),
// unlike the old banner which only ever hid itself for the current page
// load.
export function NotificationOffBanner({
  owner, settingsHref,
}: {
  owner: { adminUserId?: string; portalUserId?: string } | null
  settingsHref: string
}) {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const { permission } = usePushNotifications(owner)
  const { dismissed, dismissForever } = useDismissedHint('notifications_off', owner)
  const [neverShowAgain, setNeverShowAgain] = useState(false)
  // A plain, non-persisted hide for "closed without checking the box" --
  // comes back next page load, same as before, but at least leaves now.
  const [hiddenThisVisit, setHiddenThisVisit] = useState(false)

  if (!owner || (!owner.adminUserId && !owner.portalUserId)) return null
  if (permission === 'granted' || permission === 'unsupported') return null
  if (dismissed !== false) return null
  if (hiddenThisVisit) return null
  // Never shown on top of the settings page itself -- that's where the
  // real Enable control lives, the nudge has done its job getting here.
  if (pathname === settingsHref) return null

  const close = () => {
    if (neverShowAgain) dismissForever()
    else setHiddenThisVisit(true)
  }

  return (
    // Fixed, not inline -- this is mounted inside NotificationBell /
    // PortalNotificationBell, which sit as siblings of the actual content
    // column in both dashboard layouts, not inside it. Bottom-fixed,
    // full-width, matching every other floating notice already in this
    // codebase (the old install/push banners, the WhatsApp bubble).
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="fixed inset-x-0 bottom-0 z-[90] bg-amber-50 border-t border-amber-200 px-4 py-2.5 print:hidden">
      <div className="max-w-[1400px] mx-auto flex items-center gap-3 flex-wrap">
        <BellOff size={16} className="text-amber-700 shrink-0" />
        <p className="font-sans text-[13px] text-amber-900 flex-1 min-w-[200px]">{t('g.notificationsOffNudge')}</p>
        <button
          onClick={() => router.push(settingsHref)}
          className="font-sans text-[12.5px] font-semibold text-amber-900 underline underline-offset-2 cursor-pointer shrink-0"
        >
          {t('g.goToSettings')}
        </button>
        <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
          <input type="checkbox" checked={neverShowAgain} onChange={(e) => setNeverShowAgain(e.target.checked)} className="accent-amber-700 w-3.5 h-3.5 cursor-pointer" />
          <span className="font-sans text-[11.5px] text-amber-800">{t('g.dontShowAgain')}</span>
        </label>
        <button onClick={close} aria-label={t('g.pushLater')} className="text-amber-700 hover:text-amber-900 shrink-0 cursor-pointer">
          <X size={15} />
        </button>
      </div>
    </div>
  )
}
