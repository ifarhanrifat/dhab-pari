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

// The CSS animation used a fixed 55s regardless of how much text was
// actually in the track — fine for a handful of messages, but the belt's
// real length varies a lot (an idle day vs. a flood of backdated imports
// all posting a "thank you" at once), and a much longer track covering
// the same fixed 55s reads as sprinting past. Measures the real rendered
// width and picks a duration for a constant, always-readable scroll speed
// instead, clamped so a single short message never whips by and a huge
// track never crawls for minutes.
function useTickerDuration(text: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [duration, setDuration] = useState(55)
  useEffect(() => {
    if (!ref.current) return
    // The track renders two back-to-back copies of the same text for a
    // seamless loop — its scrollWidth is both copies, halve it for the
    // real content width the animation actually needs to cover.
    const width = ref.current.scrollWidth / 2
    const PIXELS_PER_SECOND = 90
    setDuration(Math.min(180, Math.max(20, width / PIXELS_PER_SECOND)))
  }, [text])
  return { ref, duration }
}

// One word in front of the text so a reader knows in half a second whether to
// stop. Urdu first, because that is what most people here read first.
const SEVERITY_LABEL: Record<string, string> = {
  emergency: 'ہنگامی اپیل  ·  EMERGENCY',
  important: 'اہم اعلان  ·  IMPORTANT',
  appeal: 'اپیل  ·  APPEAL',
}

/**
 * The belt across the top of the site.
 *
 * Normally it is the green announcement ticker. While an appeal is live it
 * becomes the appeal instead — red, white text, same scroll — because that is
 * the only way an emergency actually reads as one. The earlier attempt put the
 * appeal *into* the green ticker as one more message, where it became the
 * eighth item in a two-minute loop in the same colour as "free medical camp
 * every Tuesday", and was correct in the database while being invisible on the
 * page.
 *
 * Both sources are re-read every two minutes, so an appeal posted while
 * someone has the page open reaches them without a reload.
 */
export function AnnouncementBar({ source = 'public' }: { source?: 'public' | 'portal' }) {
  const { t } = useLocale()
  const [messages, setMessages] = useState<TickerMessage[]>([])
  const [appeals, setAppeals] = useState<Appeal[]>([])

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data: ap } = await supabase.rpc(source === 'portal' ? 'my_appeals' : 'public_appeals')
    setAppeals((ap ?? []) as Appeal[])

    // The portal has no news ticker of its own — only appeals belong there.
    if (source === 'public') {
      // Sweeps expired thank-yous off the belt before reading it. Without this
      // a donation thank-you would sit there for ever and the belt would fill
      // with old gratitude until nobody read any of it.
      await supabase.rpc('expire_ticker_messages')
      const { data } = await supabase
        .from('news_ticker')
        .select('id, message, message_ur')
        .eq('is_active', true)
        .order('display_order')
      if (data) setMessages(data)
    }
  }, [source])

  useEffect(() => {
    load()
    const id = setInterval(load, 120000)
    return () => clearInterval(id)
  }, [load])

  // Both tracks' content are computed unconditionally, and both hooks
  // called unconditionally, before either early return below — which of
  // the two actually renders is a JSX-level branch, not a hooks-order one.
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
  const appealTicker = useTickerDuration(track)
  const messageTicker = useTickerDuration(tickerText)

  // ── Appeal takes the belt ──────────────────────────────────────────────
  if (appeals.length > 0) {
    const first = appeals[0]
    const tel = (first.contact_number ?? '').replace(/[^0-9]/g, '').replace(/^0/, '92')

    return (
      <div className="bg-dp-error text-white h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[60] print:hidden">
        {/* Static badge outside the scroll, so the warning never scrolls away
            even mid-message. */}
        <span className="shrink-0 flex items-center gap-1.5 h-full px-3 bg-black/20 font-sans text-[12px] font-bold tracking-[0.06em]">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="hidden sm:inline">{t('y.urgent')}</span>
        </span>

        <div className="flex-1 min-w-0 overflow-hidden">
          <div ref={appealTicker.ref} className="ticker-track text-[13px] font-sans font-bold tracking-[0.03em]" style={{ animationDuration: `${appealTicker.duration}s` }}>
            <span className="px-4">{track}</span>
            <span className="px-4">{SEPARATOR}{track}</span>
          </div>
        </div>

        {first.contact_number && (
          <a
            href={`tel:${tel}`}
            className="shrink-0 hidden md:flex items-center h-full px-3 bg-black/20 hover:bg-black/30 transition-colors font-sans text-[12.5px] font-bold"
          >
            {first.contact_number}
          </a>
        )}
      </div>
    )
  }

  // ── Otherwise the ordinary announcements ───────────────────────────────
  if (messages.length === 0) return null

  return (
    <div className="bg-dp-primary-container text-white text-[13px] font-sans font-semibold tracking-[0.05em] leading-[20px] h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[60] border-b border-dp-on-primary-container/20">
      <div ref={messageTicker.ref} className="ticker-track" style={{ animationDuration: `${messageTicker.duration}s` }}>
        <span className="px-4">{tickerText}</span>
        <span className="px-4">{SEPARATOR}{tickerText}</span>
      </div>
    </div>
  )
}
