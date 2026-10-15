'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle } from 'lucide-react'
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
// actually accepts. A real bug this first fix still had: it picked that
// sign from the `rtl` (isUrdu) flag instead of asking the container
// itself. On the public site this container happens to sit under a
// dir="rtl" ancestor, so its *computed* direction is rtl and the
// Urdu-writes-negative guess happened to be right. On every portal/admin
// page it does not -- the exact same component's computed direction is
// ltr there -- so the Urdu belt wrote negative scrollLeft the whole
// time, every single frame silently clamped back to 0: frozen at the
// start, never visibly broken by an error, just never moving (confirmed
// live: public scrolled fine, portal/admin sat at scrollLeft 0 for 5
// straight seconds). Reading getComputedStyle(container).direction once
// up front and writing whichever sign that container actually accepts
// fixes it regardless of which ancestor context it's rendered in.
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
    const negative = getComputedStyle(container).direction === 'rtl'
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

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data: ap } = await supabase.rpc(source === 'portal' ? 'my_appeals' : 'public_appeals')
    setAppeals((ap ?? []) as Appeal[])

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

  if (messages.length === 0 && appeals.length === 0) return null

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
        <div ref={messageTicker.containerRef} className="bg-dp-primary-container text-white text-[13px] font-sans font-semibold tracking-[0.05em] leading-[20px] h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[60] border-b border-dp-on-primary-container/20">
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

          <div ref={appealTicker.containerRef} className="flex-1 min-w-0 overflow-hidden">
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
    </>
  )
}
