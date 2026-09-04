'use client'

import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { usePushNotifications } from '@/hooks/usePushNotifications'

// Reminds someone to actually turn notifications on — shown by both
// NotificationBell and PortalNotificationBell, which already know the
// current adminUserId/portalUserId. Two states worth showing:
//   - never asked yet: a friendly "Enable" prompt
//   - asked and said no: the browser will never show its own permission
//     dialog again, so the only way back is the device's own Settings —
//     this explains where, per platform, since JS can't do it for them.
// Dismissing only hides it for THIS page load (no persisted dismiss) —
// it's deliberately a reminder that comes back, not a one-time nag,
// per explicit request.
export function PushPermissionBanner({ owner }: { owner: { adminUserId?: string; portalUserId?: string } | null }) {
  const { t, isUrdu } = useLocale()
  const { permission, subscribe, subscribing, isStandalone, isIos } = usePushNotifications(owner)
  const [dismissed, setDismissed] = useState(false)

  // A little delay so this never fights the install-prompt banner (or
  // anything else) for the very first paint — both are informational, not
  // blocking, and staggering them reads calmer than two banners popping in
  // at once.
  const [ready, setReady] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setReady(true), 1500); return () => clearTimeout(timer) }, [])

  if (!ready || dismissed || !owner || (!owner.adminUserId && !owner.portalUserId)) return null
  if (permission === 'unsupported' || permission === 'granted') return null
  // iOS only supports push once installed to the home screen — asking for
  // permission before that is silently pointless, so wait for the install
  // banner to do its job first instead of showing two contradictory asks.
  if (isIos && !isStandalone) return null

  const enable = async () => {
    const ok = await subscribe()
    if (ok) toast.success(t('g.pushEnabledToast'))
    else if (Notification.permission !== 'denied') toast.error(t('g.pushFailedToast'))
    // If the result IS 'denied', the component re-renders into the denied
    // branch below on its own (permission state comes from the hook).
  }

  const deniedBody = isIos ? t('g.pushDeniedBodyIos') : /Android/.test(navigator.userAgent) ? t('g.pushDeniedBodyAndroid') : t('g.pushDeniedBodyDesktop')

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="fixed inset-x-3 bottom-3 md:inset-x-auto md:right-6 md:bottom-6 md:w-[360px] z-[85] print:hidden">
      <div className="bg-white border border-dp-outline-variant rounded-xl shadow-2xl p-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-dp-secondary/10 flex items-center justify-center shrink-0">
          <Bell size={16} className="text-dp-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{permission === 'denied' ? t('g.pushDeniedTitle') : t('g.pushEnableTitle')}</p>
          {/* leading-[17px] (~1.4x) is fine for the English copy this was
              tuned for, but too tight for Nastaliq — its sloped baseline and
              deep descenders need closer to 1.6-1.8x or wrapped lines
              visually collide. This banner is fixed-position and stays on
              screen until dismissed, so it's exactly the kind of thing
              worth getting right rather than leaving to the sitewide
              .leading-* class overrides, which only catch the three named
              Tailwind utilities (tight/snug/none), not arbitrary [Npx]
              values like this one. */}
          <p className={`font-sans text-[12px] text-dp-on-surface-variant mt-1 ${isUrdu ? 'leading-[22px]' : 'leading-[17px]'}`}>{permission === 'denied' ? deniedBody : t('g.pushEnableBody')}</p>
          {permission !== 'denied' && (
            <button onClick={enable} disabled={subscribing} className="mt-2.5 bg-dp-secondary text-white px-3.5 py-1.5 rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {t('g.pushEnableButton')}
            </button>
          )}
        </div>
        <button onClick={() => setDismissed(true)} aria-label={t('g.pushLater')} className="text-dp-on-surface-variant hover:text-dp-on-surface shrink-0 cursor-pointer">
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
