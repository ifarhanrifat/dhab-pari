'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Real ask, 2026-09-29: "total online users" on the homepage header. Uses
// Supabase Realtime Presence — every open tab of the public site joins the
// same channel and tracks itself, so the count is however many browser
// tabs currently have the site open, not a stored/DB-backed metric (no
// migration needed, nothing to clean up when a tab closes — presence drops
// automatically on disconnect).
export function OnlineUsersBadge() {
  const { t } = useLocale()
  const [count, setCount] = useState(1)

  useEffect(() => {
    const supabase = createClient()
    const key = Math.random().toString(36).slice(2)
    const channel = supabase.channel('site-presence', { config: { presence: { key } } })
    channel
      .on('presence', { event: 'sync' }, () => {
        setCount(Object.keys(channel.presenceState()).length || 1)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await channel.track({ online_at: new Date().toISOString() })
      })
    return () => { supabase.removeChannel(channel) }
  }, [])

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0 font-bold">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
      </span>
      <span className="ltr-num">{count}</span> {t('site.onlineNow')}
    </span>
  )
}
