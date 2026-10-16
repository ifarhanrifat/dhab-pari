'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
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
  project_id: string | null
}

interface PaidIlan {
  id: string
  title_ur: string
  body_ur: string
  contact_mobile: string | null
  vehicle_route_id: string | null
  vehicle_trip_offer_id: string | null
}

// Real ask, 2026-10-17: "can a click on those news and alerts and
// sponsored add click can be land to its actual place... this vehicle
// that created route will get the click navigate to that page where
// user can book ride?" A commercial ilan already carries its own real
// source (vehicle_route_id for a recurring route, vehicle_trip_offer_id
// for a one-off trip); an appeal's only structured destination is a
// linked project. News ticker items have no structured destination in
// the schema at all (plain text only) -- left unlinked rather than
// guessed at.
function appealLink(a: Appeal): string | null {
  return a.project_id ? `/projects/${a.project_id}` : null
}
function paidIlanLink(p: PaidIlan): string | null {
  if (p.vehicle_route_id) return `/portal/marketplace/route/${p.vehicle_route_id}`
  if (p.vehicle_trip_offer_id) return '/portal/marketplace/shared'
  return null
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
    // the platform team, unrelated to the free belts above.
    //
    // Real bug, 2026-10-17, confirmed on a real device: this relied on
    // RLS alone to decide what's live, assuming only approved/unpaused/
    // in-window rows could ever come back. That's true for an
    // anonymous visitor (commercial_ilans_display_public) — but
    // commercial_ilans_advertiser_read grants the ad's OWN owner full
    // read access to their own row regardless of status, so they can
    // check on their pending/rejected request from their own account.
    // That policy exists for a genuinely different reason (self-
    // service status checking) and was never meant to feed the public
    // belt — an advertiser logged into their own portal account was
    // seeing their own rejected ad still "running" here, invisible to
    // everyone else. The belt now states its own real criteria
    // explicitly instead of trusting whichever RLS policy happens to
    // let the request through.
    const { data: ci } = await supabase
      .from('commercial_ilans')
      .select('id, title_ur, body_ur, contact_mobile, vehicle_route_id, vehicle_trip_offer_id')
      .in('placement', ['ticker', 'auto_trip'])
      .eq('status', 'approved')
      .eq('is_paused', false)
      .lte('starts_at', new Date().toISOString())
      .gt('ends_at', new Date().toISOString())
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
    // Real bug, 2026-10-17: a committee rejecting/pausing an ilan took
    // effect instantly on the backend (confirmed live), but a phone's
    // browser/WebView throttles or fully suspends setInterval timers
    // while the tab is backgrounded — so returning to an already-open
    // tab could keep showing a since-stopped ad for a long time, well
    // past the 2-minute window, since the timer never actually fired
    // while backgrounded. Re-checking the moment the tab becomes
    // visible again covers exactly that "I changed something
    // elsewhere, then came back" case the blind interval alone misses.
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  const label = (a: Appeal) => SEVERITY_LABEL[a.severity] ?? SEVERITY_LABEL.appeal
  // Real ask, 2026-10-17: a standalone fixed phone-number badge (outside
  // the scroll) made no sense once a free appeal and a paid vehicle ad
  // could both be live in the same belt at once -- a reader had no way
  // to tell whose number the fixed badge actually belonged to. The
  // number now travels inline with its own appeal's own text instead
  // (same place a commercial ilan's contact_mobile already lives), never
  // ambiguous regardless of what else is sharing the scroll.
  const appealText = (a: Appeal) => `${label(a)}  ●  ${a.body_ur}  ●  ${a.body_en}${a.contact_number ? `  ●  ${a.contact_number}` : ''}`
  // Real ask, 2026-10-17: three stacked belts "looking very bad" once a
  // free appeal and a paid ilan were both live at once. Emergency keeps
  // its own dedicated red belt (never diluted by sharing scroll-time
  // with anything else); every non-emergency appeal and every paid
  // commercial ilan now share one yellow belt instead of each getting
  // its own strip. A paid item keeps a short "sponsored" tag inline so
  // it still reads as distinct from a real village appeal even while
  // sharing the scroll.
  const emergencyAppeals = appeals.filter((a) => a.severity === 'emergency')
  const calmAppeals = appeals.filter((a) => a.severity !== 'emergency')

  // Both plain strings purely so useScrollTicker's effect has something
  // to diff against when content changes — the actual visible belts
  // below are real JSX (renderEmergencyPass/renderYellowPass), not these
  // strings, so an item can be its own clickable link (2026-10-17: "can
  // a click... land to its actual place") and a paid item can carry its
  // own distinct pill styling.
  const emergencyTrack = emergencyAppeals.map(appealText).join(SEPARATOR)
  const emergencyTicker = useScrollTicker(emergencyTrack, isUrdu)
  const yellowTrack = [...calmAppeals.map(appealText), ...paidIlans.map((p) => `${p.title_ur}  ●  ${p.body_ur}`)].join(SEPARATOR)
  const yellowTicker = useScrollTicker(yellowTrack, isUrdu)

  const renderEmergencyPass = (keyPrefix: string) => (
    <span className="px-4">
      {emergencyAppeals.map((a, i) => {
        const href = appealLink(a)
        const content = appealText(a)
        return (
          <span key={`${keyPrefix}-${i}`}>
            {href ? <Link href={href} className="hover:underline">{content}</Link> : content}
            {i < emergencyAppeals.length - 1 ? SEPARATOR : ''}
          </span>
        )
      })}
    </span>
  )

  // Real ask, 2026-10-17: make a paid item in the shared belt look
  // "gorgeous" — its own pill, not just plain text indistinguishable
  // from a free appeal. One pass (one lap); rendered twice back-to-back
  // for the seamless loop, same as every other belt here.
  type YellowSlot = { kind: 'appeal'; appeal: Appeal } | { kind: 'paid'; ilan: PaidIlan }
  const yellowSlots: YellowSlot[] = [
    ...calmAppeals.map((appeal): YellowSlot => ({ kind: 'appeal', appeal })),
    ...paidIlans.map((ilan): YellowSlot => ({ kind: 'paid', ilan })),
  ]
  const renderYellowPass = (keyPrefix: string) => (
    <span className="px-4">
      {yellowSlots.map((slot, i) => {
        const href = slot.kind === 'appeal' ? appealLink(slot.appeal) : paidIlanLink(slot.ilan)
        const inner = slot.kind === 'appeal' ? (
          appealText(slot.appeal)
        ) : (
          <span className="inline-flex items-center gap-1.5 bg-gradient-to-r from-[#1a1f2e] to-[#2d3548] text-white px-3 py-1 rounded-full shadow-[0_1px_4px_rgba(0,0,0,.25)] border border-white/10 align-middle mx-0.5">
            <Megaphone size={11} className="shrink-0 text-amber-300" />
            <span className="text-[10px] font-black tracking-[0.08em] text-amber-300 shrink-0">{t('il.sponsoredLabel')}</span>
            <span className="opacity-40">●</span>
            <span>{slot.ilan.title_ur}  ●  {slot.ilan.body_ur}{slot.ilan.contact_mobile ? `  ●  ${slot.ilan.contact_mobile}` : ''}</span>
          </span>
        )
        return (
          <span key={`${keyPrefix}-${i}`}>
            {href ? <Link href={href} className="hover:underline">{inner}</Link> : inner}
            {i < yellowSlots.length - 1 ? SEPARATOR : ''}
          </span>
        )
      })}
    </span>
  )

  // Urdu-only, no English concatenated in — message_ur is what a
  // publisher/admin actually writes for a manually-authored entry; an
  // auto-generated donation thank-you now stores the same Urdu text in
  // both columns (migration 375), so falling back to .message when
  // .message_ur is unset still only ever shows Urdu, never English.
  const tickerText = messages.map((m) => m.message_ur || m.message).join(SEPARATOR)
  const messageTicker = useScrollTicker(tickerText, isUrdu)

  if (messages.length === 0 && appeals.length === 0 && paidIlans.length === 0) return null

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

      {emergencyAppeals.length > 0 && (
        // Explicit dir, not ambient — same reason the scrolling track
        // below already sets its own: the public site and the portal
        // don't share the same ambient direction context, which was
        // putting this badge on opposite physical sides of the two
        // surfaces for the same language. (2026-10-17)
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-dp-error text-white h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[59] print:hidden">
          {/* Static badge outside the scroll, so the warning never scrolls away
              even mid-message. */}
          <span className="shrink-0 flex items-center gap-1.5 h-full px-3 bg-black/20 font-sans text-[12px] font-bold tracking-[0.06em]">
            <AlertTriangle size={14} className="shrink-0" />
            <span className="hidden sm:inline">{t('y.urgent')}</span>
          </span>

          <div ref={emergencyTicker.containerRef} dir={isUrdu ? 'rtl' : 'ltr'} className="flex-1 min-w-0 overflow-hidden">
            <div className="ticker-track text-[13px] font-sans font-bold tracking-[0.03em]">
              {renderEmergencyPass('e1')}
              {renderEmergencyPass('e2')}
            </div>
          </div>
        </div>
      )}

      {(calmAppeals.length > 0 || paidIlans.length > 0) && (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-amber-400 text-black h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[58] print:hidden">
          <span className="shrink-0 flex items-center gap-1.5 h-full px-3 bg-black/10 font-sans text-[12px] font-bold tracking-[0.06em]">
            <Megaphone size={14} className="shrink-0" />
            <span className="hidden sm:inline">{t('il.announcementsLabel')}</span>
          </span>

          <div ref={yellowTicker.containerRef} dir={isUrdu ? 'rtl' : 'ltr'} className="flex-1 min-w-0 overflow-hidden">
            <div className="ticker-track text-[13px] font-sans font-bold tracking-[0.03em]">
              {renderYellowPass('p1')}
              {renderYellowPass('p2')}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
