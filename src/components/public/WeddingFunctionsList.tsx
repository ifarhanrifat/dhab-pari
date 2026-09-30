'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { MapPin, Clock } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Fn { id: string; function_type: string; function_datetime: string; venue_men: string | null; venue_women: string | null }

// Real ask, 2026-09-30: "3 events mehndi, barat and waleema... single
// card for shadi" -- each function of a wedding shown on its own line,
// under the one event card, instead of one card per function.
export function WeddingFunctionsList({ eventId }: { eventId: string }) {
  const { t } = useLocale()
  const [fns, setFns] = useState<Fn[]>([])

  useEffect(() => {
    const supabase = createClient()
    supabase.from('wedding_functions').select('*').eq('event_id', eventId).order('function_datetime')
      .then(({ data }) => setFns((data ?? []) as Fn[]))
  }, [eventId])

  if (fns.length === 0) return null

  return (
    <div className="mt-2 space-y-1.5">
      {fns.map((f) => (
        <div key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-sans text-[12.5px] text-dp-on-surface-variant">
          <span className="font-semibold text-dp-on-surface">{t(`ve.fn.${f.function_type}`)}</span>
          <span className="flex items-center gap-1"><Clock size={11} /> <span className="ltr-num">{new Date(f.function_datetime).toLocaleString()}</span></span>
          {(f.venue_men || f.venue_women) && (
            <span className="flex items-center gap-1"><MapPin size={11} /> {f.venue_men ? `${t('ve.venueMen')}: ${f.venue_men}` : ''}{f.venue_men && f.venue_women ? ' · ' : ''}{f.venue_women ? `${t('ve.venueWomen')}: ${f.venue_women}` : ''}</span>
          )}
        </div>
      ))}
    </div>
  )
}
