'use client'

import { useEffect, useState } from 'react'
import { Download, RotateCcw, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { APK_DOWNLOAD_URL, APK_VERSION } from '@/lib/appDownload'

// Real ask, 2026-09-25: the existing Download App prompt (DownloadAppBanner)
// is just a static "get the app" pitch -- it has no way to know whether the
// person reading it already has the app installed, let alone whether that
// install is out of date. That's only knowable from INSIDE the running
// native app itself: a website in a browser has no access to installed-
// package info at all, but Capacitor's own @capacitor/app plugin can report
// the currently-running app's own build number back to itself. This
// component only ever does anything when it's running inside that native
// shell (see the isNativePlatform() guard below) -- a browser visit, iOS
// included, never sees it.
//
// "An alert in the middle of the app" -- mounted globally in layout.tsx (not
// tied to one page), a real centered modal rather than the thin dismissible
// banner, so it actually interrupts. Dismissible for the current app
// session (not persisted) so it isn't a hard lock-out, but reappears on the
// next cold start until the person actually updates -- there's no reliable
// server-side signal for "they updated," only "this specific running build
// is old."
export function AppUpdateRequiredModal() {
  const { t, isUrdu } = useLocale()
  const [outdated, setOutdated] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { Capacitor } = await import('@capacitor/core')
      if (!Capacitor.isNativePlatform()) return
      try {
        const { App } = await import('@capacitor/app')
        const info = await App.getInfo()
        // `build` is the Android versionCode as a string (see AppInfo's own
        // docs) -- the exact same number scheme APK_VERSION already tracks
        // in appDownload.ts, bumped together with every real release.
        const installedBuild = Number(info.build)
        if (!cancelled && Number.isFinite(installedBuild) && installedBuild < APK_VERSION) {
          setOutdated(true)
        }
      } catch {
        // Plugin unavailable or the call failed -- say nothing rather than
        // nag someone we can't actually confirm is out of date.
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (!outdated || dismissed) return null

  return (
    <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4" dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 relative" style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
        <button onClick={() => setDismissed(true)} aria-label="Dismiss" className="absolute top-4 end-4 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer">
          <X size={18} />
        </button>
        <div className="w-11 h-11 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mb-4">
          <RotateCcw size={20} />
        </div>
        <h2 className="font-heading text-[19px] font-bold text-dp-primary mb-2">{t('y.updateRequired')}</h2>
        <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed mb-4">{t('y.updateRequiredBody')}</p>
        <ol className="space-y-1.5 font-sans text-[13px] text-dp-on-surface-variant list-decimal ps-5 mb-5">
          <li>{t('y.uninstallStep')}</li>
          <li>{t('y.downloadInstallStep')}</li>
        </ol>
        <div className="flex items-center gap-2">
          <a
            href={APK_DOWNLOAD_URL}
            download
            className="flex-1 flex items-center justify-center gap-1.5 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all"
          >
            <Download size={15} /> {t('y.downloadLatestVersion')}
          </a>
          <button
            onClick={() => setDismissed(true)}
            className="shrink-0 px-3 py-2.5 text-dp-on-surface-variant hover:text-dp-on-surface font-sans text-[12.5px] font-semibold cursor-pointer"
          >
            {t('y.remindMeLater')}
          </button>
        </div>
      </div>
    </div>
  )
}
