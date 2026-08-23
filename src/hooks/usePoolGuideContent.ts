'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { poolGuideKeys } from '@/lib/portalGuideContent'

// Kafalat, Wazifa and Esal-e-Sawab portal pages all render the identical
// sponsorship-pool guide — this fetches it once per page rather than
// tripling the same site_settings query across three files. Falls back to
// {} on the first render; each page's own get() helper falls back further,
// to the original messages.ts text, so there's never a blank guide.
export function usePoolGuideContent() {
  const [content, setContent] = useState<Record<string, string>>({})
  useEffect(() => {
    const supabase = createClient()
    supabase.from('site_settings').select('key, value').in('key', poolGuideKeys()).then(({ data }) => {
      const m: Record<string, string> = {}
      ;((data ?? []) as { key: string; value: string | null }[]).forEach((s) => { m[s.key] = s.value ?? '' })
      setContent(m)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return content
}
