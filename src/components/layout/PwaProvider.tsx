'use client'

import { useEffect, useState } from 'react'
import { Download, X, Share } from 'lucide-react'

// Chrome/Edge/Android fire this so the site can show its own install button.
// Not in TypeScript's DOM lib yet, hence the local shape.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'dp_install_dismissed'

export function PwaProvider() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [dismissed, setDismissed] = useState(true) // assume dismissed until localStorage is read (avoids a flash)

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      // Registered after load so it never competes with the first paint.
      const onLoad = () => navigator.serviceWorker.register('/sw.js').catch(() => {})
      if (document.readyState === 'complete') onLoad()
      else window.addEventListener('load', onLoad)
      return () => window.removeEventListener('load', onLoad)
    }
  }, [])

  useEffect(() => {
    // Already installed and running standalone — nothing to prompt.
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (isStandalone) return

    if (localStorage.getItem(DISMISS_KEY) === '1') return
    setDismissed(false)

    const handler = (e: Event) => {
      e.preventDefault() // stop Chrome's own mini-infobar; we show our own button
      setDeferred(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)

    // iOS Safari never fires beforeinstallprompt — there is no programmatic
    // install at all, the user must use Share → Add to Home Screen. So detect
    // iOS Safari and explain that instead of showing a button that can't work.
    const ua = window.navigator.userAgent
    const isIos = /iPad|iPhone|iPod/.test(ua)
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
    if (isIos && isSafari) setShowIosHint(true)

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
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
          <p className="font-sans text-[14px] font-bold leading-[20px]">Install Dhab Pari</p>
          {showIosHint ? (
            <p className="font-sans text-[12.5px] text-white/75 leading-[18px] mt-1">
              Tap <Share size={12} className="inline align-[-1px]" /> Share, then{' '}
              <span className="font-semibold text-white">Add to Home Screen</span>.
            </p>
          ) : (
            <>
              <p className="font-sans text-[12.5px] text-white/75 leading-[18px] mt-1">
                Add it to your home screen for quick access to bills and donations.
              </p>
              <button
                onClick={install}
                className="mt-2.5 inline-flex items-center gap-1.5 bg-[#1D9E75] hover:bg-[#17835f] text-white px-3.5 py-1.5 rounded-lg font-sans text-[13px] font-semibold transition-all active:scale-95 cursor-pointer"
              >
                <Download size={14} /> Install
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
