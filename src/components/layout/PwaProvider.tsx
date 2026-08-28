'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Download, X, Share } from 'lucide-react'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Chrome/Edge/Android fire this so the site can show its own install button.
// Not in TypeScript's DOM lib yet, hence the local shape.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'dp_install_dismissed'
// iOS has no install button at all — this banner's iOS branch is a
// villager's *only* path to finding out Add to Home Screen exists. A
// permanent one-tap dismiss (like the Android button gets, where Chrome's
// own menu is still a fallback) would mean one curious tap of the ✕ loses
// that guidance forever. Instead it comes back after two weeks.
const IOS_DISMISS_KEY = 'dp_ios_hint_dismissed_at'
const IOS_RESURFACE_MS = 14 * 24 * 60 * 60 * 1000

export function PwaProvider() {
  const { t } = useLocale()
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [iosNeedsSafari, setIosNeedsSafari] = useState(false)
  const [isIos, setIsIos] = useState(false)
  const [dismissed, setDismissed] = useState(true) // assume dismissed until localStorage is read (avoids a flash)
  const pathname = usePathname()

  // Never float this over a form someone is trying to fill in. On the admin
  // login it sat directly on top of the password field and the Sign In
  // button. Staff/portal auth screens are working surfaces, not places to
  // advertise the app — the service worker below still registers everywhere.
  const suppressed = pathname?.startsWith('/admin') || pathname?.startsWith('/portal/login')
    || pathname?.startsWith('/portal/signup')

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    // A service worker has no business running against a dev server. It used to
    // register everywhere, and its cache-first rule for /_next/static/ — safe in
    // production, where those filenames are content-hashed and immutable — served
    // dead HMR chunks in dev after every recompile. The resulting ChunkLoadError
    // made Next reload the page, which hit the same dead chunk, which reloaded
    // again: an endless refresh loop with nothing ever rendering.
    //
    // So: register only in production, and in dev actively tear down any worker
    // a previous run installed. Without that teardown a browser that already has
    // the old worker keeps looping no matter what this file says, because the
    // installed worker — not this code — is what answers the fetch.
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .then(() => (typeof caches !== 'undefined' ? caches.keys() : Promise.resolve([])))
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch(() => {})
      return
    }

    // Registered after load so it never competes with the first paint.
    const onLoad = () => navigator.serviceWorker.register('/sw.js').catch(() => {})
    if (document.readyState === 'complete') onLoad()
    else window.addEventListener('load', onLoad)
    return () => window.removeEventListener('load', onLoad)
  }, [])

  useEffect(() => {
    // Already installed and running standalone — nothing to prompt.
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (isStandalone) return

    // iOS never fires beforeinstallprompt — there is no programmatic install
    // at all, the user must use Share → Add to Home Screen. Worse, only
    // *Safari* can install: Chrome/Firefox/Edge on iOS are all Safari's engine
    // in a different wrapper and cannot add to the home screen. This first
    // showed the hint only to iOS Safari, so someone browsing in Chrome on an
    // iPhone saw nothing at all and had no idea why. Now every iOS browser
    // gets a hint — and non-Safari ones are told to switch to Safari.
    const ua = window.navigator.userAgent
    const iosDetected = /iPad|iPhone|iPod/.test(ua) ||
      // iPadOS 13+ reports itself as desktop Safari; touch points give it away.
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    setIsIos(iosDetected)

    // Two different dismiss rules: Android's install-button case has
    // Chrome's own menu as a permanent fallback, so a one-tap dismiss can
    // stay permanent. iOS has nothing else — dismissing loses the only
    // guidance this site ever gives, so it resurfaces after two weeks
    // instead of vanishing for good.
    if (iosDetected) {
      const dismissedAt = Number(localStorage.getItem(IOS_DISMISS_KEY) ?? 0)
      if (dismissedAt && Date.now() - dismissedAt < IOS_RESURFACE_MS) return
    } else {
      if (localStorage.getItem(DISMISS_KEY) === '1') return
    }
    setDismissed(false)

    const handler = (e: Event) => {
      e.preventDefault() // stop Chrome's own mini-infobar; we show our own button
      setDeferred(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)

    const isIosNonSafari = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
    if (iosDetected) {
      setShowIosHint(true)
      setIosNeedsSafari(isIosNonSafari)
    }

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const dismiss = () => {
    if (isIos) localStorage.setItem(IOS_DISMISS_KEY, String(Date.now()))
    else localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
    setDeferred(null)
    setShowIosHint(false)
  }

  const install = async () => {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice
    // Either way the prompt is spent — Chrome won't re-fire it this session.
    dismiss()
  }

  if (suppressed) return null
  if (dismissed) return null
  if (!deferred && !showIosHint) return null

  return (
    // bottom-36 on mobile clears BOTH the bottom nav and the floating WhatsApp
    // bubble (which sits at bottom-20 right-4) — at bottom-20 this banner
    // covered the chat button completely.
    <div className="fixed inset-x-3 bottom-36 md:inset-x-auto md:right-6 md:bottom-24 md:w-[360px] z-[80] print:hidden">
      <div className="bg-dp-primary text-white rounded-xl shadow-2xl border border-white/10 p-4 flex items-start gap-3">
        <img src="/icons/icon-192.png" alt="" className="w-10 h-10 rounded-lg shrink-0 bg-white" />
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[14px] font-bold leading-[20px]">Install {SITE.name}</p>
          {showIosHint ? (
            <>
              {iosNeedsSafari && (
                <p className="font-sans text-[12.5px] text-white/75 leading-[18px] mt-1">
                  {t('y.iosSwitchSafari')}
                </p>
              )}
              <ol className="mt-1.5 space-y-1 font-sans text-[12.5px] text-white/90 leading-[18px] list-decimal ps-4">
                <li>{t('y.iosStep1')} <Share size={12} className="inline align-[-1px] ms-0.5" /></li>
                <li>{t('y.iosStep2')}</li>
                <li>{t('y.iosStep3')}</li>
              </ol>
            </>
          ) : (
            <>
              <p className="font-sans text-[12.5px] text-white/75 leading-[18px] mt-1">
                Add it to your home screen for quick access to bills and donations.
              </p>
              <button
                onClick={install}
                className="mt-2.5 inline-flex items-center gap-1.5 bg-[#1D9E75] hover:bg-[#17835f] text-white px-3.5 py-1.5 rounded-lg font-sans text-[13px] font-semibold transition-all active:scale-95 cursor-pointer"
              >
                <Download size={14} /> {t('y.install')}
              </button>
            </>
          )}
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="text-white/50 hover:text-white shrink-0 cursor-pointer">
          <X size={18} />
        </button>
      </div>
    </div>
  )
}
