'use client'

// The "home-screen banner shown whenever a user gets online" placement
// (migration 671) — a paid, platform-sold ad slot, separate from the
// free ticker belts in AnnouncementBar. Shown once per portal session
// (dismiss is a per-viewer convenience via sessionStorage, not
// authoritative — it reappears next session/device, same spirit as
// DownloadAppBanner's own dismiss-for-this-view-only behaviour).

import { useEffect, useState } from 'react'
import { Megaphone, X, Phone } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface BannerIlan {
  id: string
  title_ur: string
  title_en: string | null
  body_ur: string
  body_en: string | null
  contact_mobile: string | null
}

export function IlanBanner() {
  const { t, isUrdu } = useLocale()
  const [ilan, setIlan] = useState<BannerIlan | null>(null)
  const [show, setShow] = useState(true)

  useEffect(() => {
    let dismissed = false
    try { dismissed = sessionStorage.getItem('ilanBannerDismissed') === '1' } catch { /* ignore */ }
    if (dismissed) { setShow(false); return }

    const supabase = createClient()
    // Real gap found live, 2026-10-20: this had no status/is_paused/
    // date-range filter at all — a pending or rejected banner ilan (or
    // one whose own run already ended) could show here, unlike every
    // other ilan placement in this app, which all check these fields.
    supabase
      .from('commercial_ilans')
      .select('id, title_ur, title_en, body_ur, body_en, contact_mobile')
      .eq('placement', 'banner')
      .eq('status', 'approved')
      .eq('is_paused', false)
      .lte('starts_at', new Date().toISOString())
      .gt('ends_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setIlan(data))
  }, [])

  const dismiss = () => {
    setShow(false)
    try { sessionStorage.setItem('ilanBannerDismissed', '1') } catch { /* ignore */ }
  }

  if (!show || !ilan) return null

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-start gap-3 bg-[#1a1f2e] rounded-lg px-4 py-3 mb-6 flex-wrap">
      <div className="shrink-0 w-9 h-9 rounded-full bg-white/10 text-white flex items-center justify-center"><Megaphone size={16} /></div>
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.08em] text-white/50">{t('il.bannerSponsoredLabel')}</p>
        <p className="font-sans text-[13.5px] font-bold text-white mt-0.5">{isUrdu ? ilan.title_ur : (ilan.title_en || ilan.title_ur)}</p>
        <p className="font-sans text-[12px] text-white/70 mt-0.5">{isUrdu ? ilan.body_ur : (ilan.body_en || ilan.body_ur)}</p>
      </div>
      {ilan.contact_mobile && (
        <a href={`tel:${ilan.contact_mobile}`} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg font-sans text-[12.5px] font-bold cursor-pointer bg-white/10 text-white hover:bg-white/20 transition-colors">
          <Phone size={13} /> {ilan.contact_mobile}
        </a>
      )}
      <button onClick={dismiss} className="shrink-0 text-white/60 hover:text-white cursor-pointer p-1"><X size={14} /></button>
    </div>
  )
}
