'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, Megaphone } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface TickerMessage {
  id: string
  message: string
  message_ur: string | null
}

interface Appeal {
  id: string
  kind: string
  severity: string
  body_en: string
  body_ur: string
  contact_number: string | null
}

interface PaidIlan {
  id: string
  title_ur: string
  body_ur: string
  contact_mobile: string | null
}

const SEPARATOR = '    ——    '

// Real bug, confirmed live on-device via CDP against the production
// WebView (not just Chrome, which never showed it): a CSS `transform`
// animation on a wide (~15,000px, the real Urdu belt's full width) element
// painted completely blank in this Android WebView the whole time it was
// actively animating -- freezing the transform, or shrinking the track to
// a few hundred px, both made the text reappear, isolating it to "wide +
// actively-transform-animating" specifically. English never hit this
// because its much shorter message set never produced a wide enough
// track. Replaced the transform/keyframe animation with one driven by
// `scrollLeft` instead -- a different paint path this WebView doesn't
// have the same bug on -- confirmed fixed with a side-by-side screenshot
// of the exact same production page, same element, before/after.
//
// scrollLeft also needed its own fix once direction:rtl entered the
// picture: Chromium clamps scrollLeft to <= 0 on an RTL-direction
// overflow container and silently drops any positive value (confirmed
// directly on the real element -- -500 held, +500 reset to 0), so the
// sign of the per-frame write has to match whichever one the container
// actually accepts. Two bugs chased this one, in order:
// (1) picking the sign from the `rtl` (isUrdu) flag while the container
//     itself had no explicit `dir` attribute -- so its *computed*
//     direction came from whatever ancestor happened to set dir="rtl",
//     which the public site's wrapper did but portal/admin's didn't,
//     silently clamping every Urdu frame back to 0 there (frozen, no
//     error, confirmed live). Fixed by reading getComputedStyle instead
//     of trusting the flag.
// (2) that "fix" made direction depend on ambient ancestor context
//     instead of the ticker's own content language -- correct for not
//     freezing, but on any page with no rtl ancestor at all (true of
//     every portal/admin page, mobility shell included), computed
//     direction is always 'ltr' regardless of locale, so the belt always
//     scrolled the LTR way even in Urdu: real bug, reported live
//     ("running right to left for Urdu, that's wrong"). The ticker
//     should never depend on ambient context -- it now sets `dir`
//     explicitly on its own container (see the JSX below) from the same
//     `rtl` flag passed in here, making that flag authoritative again,
//     this time for real: the container's computed direction is
//     whatever we just declared, not a guess about some ancestor.
function useScrollTicker(text: string, rtl: boolean) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // The track renders two back-to-back copies of the same text for a
    // seamless loop -- scrollWidth is both copies, halve it for the real
    // content width one lap actually needs to cover.
    const contentWidth = container.scrollWidth / 2
    if (contentWidth <= 0) return
    const negative = rtl
    const PIXELS_PER_SECOND = 90
    let pos = 0
    let raf = 0
    let last = performance.now()
    function step(now: number) {
      const dt = (now - last) / 1000
      last = now
      if (!pausedRef.current) {
        pos = (pos + PIXELS_PER_SECOND * dt) % contentWidth
        container!.scrollLeft = negative ? -pos : pos
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [text, rtl])

  // Same real ask as the old CSS :hover rule this replaces -- pause to
  // read on a device that actually has a mouse, never latch paused from a
  // touch tap (no mouseleave on touch to ever clear it).
  useEffect(() => {
    const container = containerRef.current
    if (!container || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    const onEnter = () => { pausedRef.current = true }
    const onLeave = () => { pausedRef.current = false }
    container.addEventListener('mouseenter', onEnter)
    container.addEventListener('mouseleave', onLeave)
    return () => {
      container.removeEventListener('mouseenter', onEnter)
      container.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  return { containerRef }
}

// One word in front of the text so a reader knows in half a second whether to
// stop. Urdu first, because that is what most people here read first.
const SEVERITY_LABEL: Record<string, string> = {
  emergency: 'ہنگامی اپیل  ·  EMERGENCY',
  important: 'اہم اعلان  ·  IMPORTANT',
  appeal: 'اپیل  ·  APPEAL',
}

/**
 * Two belts stacked across the top of the site, real ask 2026-10-01:
 *
 * 1. The calm belt — ordinary news, plus (549) a new Chanda campaign
 *    launching, plus donation thank-yous. Always runs, on every one of
 *    the three surfaces (public/portal/admin) — it used to be public-
 *    only.
 * 2. The alert belt underneath it — appeals only (Help Requests, Death
 *    Announcements, blood, weather, routine appeals), red for
 *    severity='emergency', yellow-with-black-text for everything else.
 *    This used to REPLACE the calm belt entirely while live; now it
 *    renders alongside it instead, since a calm "free medical camp
 *    Tuesday" message and "blood needed" alert are both worth seeing at
 *    once, not one hiding the other.
 *
 * Both sources are re-read every two minutes, so an appeal or a news item
 * posted while someone has the page open reaches them without a reload.
 */
export function AnnouncementBar({ source = 'public' }: { source?: 'public' | 'portal' | 'admin' }) {
  const { t, isUrdu } = useLocale()
  const [messages, setMessages] = useState<TickerMessage[]>([])
  const [appeals, setAppeals] = useState<Appeal[]>([])
  const [paidIlans, setPaidIlans] = useState<PaidIlan[]>([])

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data: ap } = await supabase.rpc(source === 'portal' ? 'my_appeals' : 'public_appeals')
    setAppeals((ap ?? []) as Appeal[])

    // Paid ticker-placement commercial ilans (migration 671) — run by
    // the platform team, unrelated to the free belts above. RLS already
    // restricts this to currently-live, approved, unpaused campaigns
    // targeted at this viewer's own tenant.
    const { data: ci } = await supabase
      .from('commercial_ilans')
      .select('id, title_ur, body_ur, contact_mobile')
      .eq('placement', 'ticker')
      .order('created_at', { ascending: false })
    setPaidIlans((ci ?? []) as PaidIlan[])

    // Real ask, 2026-10-01: the calm belt now runs on every surface, not
    // just the public site — portal and admin get it too. Appeal-sourced
    // rows (is_appeal_mirror) are excluded here since they now have their
    // own belt below this one instead (see migration 549).
    await supabase.rpc('expire_ticker_messages')
    const { data } = await supabase
      .from('news_ticker')
      .select('id, message, message_ur')
      .eq('is_active', true)
      .eq('is_appeal_mirror', false)
      .order('display_order')
    if (data) setMessages(data)
  }, [source])

  useEffect(() => {
    load()
    const id = setInterval(load, 120000)
    return () => clearInterval(id)
  }, [load])

  const label = (a: Appeal) => SEVERITY_LABEL[a.severity] ?? SEVERITY_LABEL.appeal
  const track = appeals
    .map((a) => `${label(a)}  ●  ${a.body_ur}  ●  ${a.body_en}`)
    .join(SEPARATOR)
  // Urdu-only, no English concatenated in — message_ur is what a
  // publisher/admin actually writes for a manually-authored entry; an
  // auto-generated donation thank-you now stores the same Urdu text in
  // both columns (migration 375), so falling back to .message when
  // .message_ur is unset still only ever shows Urdu, never English.
  const tickerText = messages.map((m) => m.message_ur || m.message).join(SEPARATOR)
  const appealTicker = useScrollTicker(track, isUrdu)
  const messageTicker = useScrollTicker(tickerText, isUrdu)

  const paidTrack = paidIlans.map((p) => `${p.title_ur}  ●  ${p.body_ur}${p.contact_mobile ? `  ●  ${p.contact_mobile}` : ''}`).join(SEPARATOR)
  const paidTicker = useScrollTicker(paidTrack, isUrdu)

  if (messages.length === 0 && appeals.length === 0 && paidIlans.length === 0) return null

  // Real ask, 2026-10-01: "for emergency that new belt will display in
  // red background, while for the other ilans... yellow with Black
  // fonts" — one colour for the whole belt, picked by the single most
  // urgent thing currently live in it, not per-message inside one
  // continuous scroll.
  const hasEmergency = appeals.some((a) => a.severity === 'emergency')
  const alertBeltClass = hasEmergency ? 'bg-dp-error text-white' : 'bg-amber-400 text-black'
  const badgeClass = hasEmergency ? 'bg-black/20' : 'bg-black/10'

  return (
    <>
      {messages.length > 0 && (
        <div ref={messageTicker.containerRef} dir={isUrdu ? 'rtl' : 'ltr'} className="bg-dp-primary-container text-white text-[13px] font-sans font-semibold tracking-[0.05em] leading-[20px] h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[60] border-b border-dp-on-primary-container/20">
          <div className="ticker-track">
            <span className="px-4">{tickerText}</span>
            <span className="px-4">{SEPARATOR}{tickerText}</span>
          </div>
        </div>
      )}

      {appeals.length > 0 && (
        <div className={`${alertBeltClass} h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[59] print:hidden`}>
          {/* Static badge outside the scroll, so the warning never scrolls away
              even mid-message. */}
          <span className={`shrink-0 flex items-center gap-1.5 h-full px-3 ${badgeClass} font-sans text-[12px] font-bold tracking-[0.06em]`}>
            <AlertTriangle size={14} className="shrink-0" />
            <span className="hidden sm:inline">{t('y.urgent')}</span>
          </span>

          <div ref={appealTicker.containerRef} dir={isUrdu ? 'rtl' : 'ltr'} className="flex-1 min-w-0 overflow-hidden">
            <div className="ticker-track text-[13px] font-sans font-bold tracking-[0.03em]">
              <span className="px-4">{track}</span>
              <span className="px-4">{SEPARATOR}{track}</span>
            </div>
          </div>

          {appeals[0].contact_number && (
            <a
              href={`tel:${(appeals[0].contact_number ?? '').replace(/[^0-9]/g, '').replace(/^0/, '92')}`}
              className={`shrink-0 hidden md:flex items-center h-full px-3 ${badgeClass} hover:brightness-95 transition-colors font-sans text-[12.5px] font-bold`}
            >
              {appeals[0].contact_number}
            </a>
          )}
        </div>
      )}

      {paidIlans.length > 0 && (
        <div className="bg-[#1a1f2e] text-white h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[57] print:hidden">
          <span className="shrink-0 flex items-center gap-1.5 h-full px-3 bg-white/10 font-sans text-[12px] font-bold tracking-[0.06em]">
            <Megaphone size={14} className="shrink-0" /> <span className="hidden sm:inline">{t('il.sponsoredLabel')}</span>
          </span>
          <div ref={paidTicker.containerRef} dir={isUrdu ? 'rtl' : 'ltr'} className="flex-1 min-w-0 overflow-hidden">
            <div className="ticker-track text-[13px] font-sans font-semibold tracking-[0.03em]">
              <span className="px-4">{paidTrack}</span>
              <span className="px-4">{SEPARATOR}{paidTrack}</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
