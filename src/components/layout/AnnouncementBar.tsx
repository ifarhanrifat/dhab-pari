'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface TickerMessage {
  id: string
  message: string
  message_ur: string | null
}

const SEPARATOR = '    ——    '

export function AnnouncementBar() {
  const [messages, setMessages] = useState<TickerMessage[]>([])

  // Re-read every two minutes. This used to fetch once on mount, so a notice
  // posted while someone had the page open never appeared for them at all.
  useEffect(() => {
    const supabase = createClient()
    let cancelled = false
    const load = async () => {
      const { data } = await supabase
        .from('news_ticker')
        .select('id, message, message_ur')
        .eq('is_active', true)
        .order('display_order')
      if (!cancelled && data) setMessages(data)
    }
    load()
    const id = setInterval(load, 120000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (messages.length === 0) return null

  const tickerText = messages
    .map((m) => {
      const parts = [m.message]
      if (m.message_ur) parts.push(m.message_ur)
      return parts.join('  |  ')
    })
    .join(SEPARATOR)

  return (
    <div className="bg-dp-primary-container text-white text-[13px] font-sans font-semibold tracking-[0.05em] leading-[20px] h-9 flex items-center overflow-hidden whitespace-nowrap relative z-[60] border-b border-dp-on-primary-container/20">
      <div className="ticker-track">
        <span className="px-4">{tickerText}</span>
        <span className="px-4">{SEPARATOR}{tickerText}</span>
      </div>
    </div>
  )
}
