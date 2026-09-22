'use client'

// A one-line prompt on the portal dashboard — the page every portal user
// (driver, rider, donor) actually lands on repeatedly — pointing to the
// native Android app.
//
// Rizwan reported not seeing this at all and asked for it visible
// unconditionally ("make it visible for any condition") — this used to be
// hidden on iOS, inside the native app itself, and permanently per-device
// once dismissed once (localStorage), any of which could explain that
// report. All three gates are removed on his explicit request: it now
// always renders, on every platform, every visit, dismiss or not. The X
// button still lets someone close it for the current page view, but that
// no longer persists — it reappears on the next load/navigation, same as
// every other visit.
import { useState } from 'react'
import { Download, X, Smartphone } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { APK_DOWNLOAD_URL } from '@/lib/appDownload'

export function DownloadAppBanner() {
  const { t, isUrdu } = useLocale()
  const [show, setShow] = useState(true)

  if (!show) return null

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-center gap-3 bg-dp-secondary-container/40 border border-dp-secondary/25 rounded-lg px-4 py-3 mb-6">
      <div className="shrink-0 w-9 h-9 rounded-full bg-dp-secondary text-white flex items-center justify-center"><Smartphone size={17} /></div>
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{t('p.downloadAppTitle')}</p>
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('p.downloadAppHint')}</p>
      </div>
      <a href={APK_DOWNLOAD_URL} download className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg font-sans text-[12.5px] font-bold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary transition-colors">
        <Download size={13} /> {t('p.downloadAppBtn')}
      </a>
      <button onClick={() => setShow(false)} className="shrink-0 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1"><X size={14} /></button>
    </div>
  )
}
