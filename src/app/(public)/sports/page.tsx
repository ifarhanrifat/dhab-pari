'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Trophy, MapPin, User, Clock, PlusCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Ev {
  id: string; title: string; title_ur: string | null; description: string | null; description_ur: string | null
  start_datetime: string; end_datetime: string | null; location_text: string | null
  tournament_name: string | null; entry_fee: number | null; registration_contact: string | null
}

// Phase 3 of the "Village OS" feature set, 2026-10-01. A filtered view of
// Village Events (category='sports') rather than a separate content
// system -- a tournament is an event with a date/venue like any other,
// and Events (538/539) already has the tournament_name/entry_fee/
// registration_contact fields for it.
export default function SportsPage() {
  const { t, isUrdu } = useLocale()
  const [upcoming, setUpcoming] = useState<Ev[]>([])
  const [past, setPast] = useState<Ev[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    const nowIso = new Date().toISOString()
    Promise.all([
      supabase.from('village_events').select('*').eq('is_active', true).eq('category', 'sports').gte('start_datetime', nowIso).order('start_datetime', { ascending: true }),
      supabase.from('village_events').select('*').eq('is_active', true).eq('category', 'sports').lt('start_datetime', nowIso).order('start_datetime', { ascending: false }).limit(10),
    ]).then(([u, p]) => { setUpcoming(u.data ?? []); setPast(p.data ?? []); setLoading(false) })
  }, [])

  const card = (e: Ev, faded = false) => (
    <div key={e.id} className={`bg-white border border-dp-outline-variant rounded-lg p-5 ${faded ? 'opacity-60' : ''}`}>
      <p className="font-heading text-[18px] font-bold text-dp-on-surface">{isUrdu && e.title_ur ? e.title_ur : e.title}</p>
      {e.tournament_name && <p className="font-sans text-[13.5px] text-dp-on-surface mt-1">{e.tournament_name}{e.entry_fee ? ` · ${t('ve.entryFee')}: ${e.entry_fee}` : ''}</p>}
      {(isUrdu ? e.description_ur : e.description) && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5">{isUrdu ? e.description_ur : e.description}</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 font-sans text-[12.5px] text-dp-on-surface-variant">
        <span className="flex items-center gap-1"><Clock size={12} /> <span className="ltr-num">{new Date(e.start_datetime).toLocaleString()}</span></span>
        {e.location_text && <span className="flex items-center gap-1"><MapPin size={12} /> {e.location_text}</span>}
        {e.registration_contact && <span className="flex items-center gap-1"><User size={12} /> {t('ve.registrationContact')}: {e.registration_contact}</span>}
      </div>
    </div>
  )

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1.5">
        <div className="flex items-center gap-2.5">
          <Trophy size={26} className="text-amber-600" />
          <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('sp.pageTitle')}</h1>
        </div>
        <Link href="/portal/suggestions" className="flex items-center gap-2 px-4 py-2 border-2 border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-secondary hover:text-white transition-all">
          <PlusCircle size={15} /> {t('sp.proposeEvent')}
        </Link>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8">{t('sp.pageIntro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : (
        <>
          {upcoming.length === 0 ? (
            <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg mb-10">{t('sp.noneFound')}</p>
          ) : (
            <div className="space-y-4 mb-10">{upcoming.map((e) => card(e))}</div>
          )}
          {past.length > 0 && (
            <>
              <h2 className="font-heading text-[18px] font-bold text-dp-on-surface-variant mb-4">{t('x.past')}</h2>
              <div className="space-y-4">{past.map((e) => card(e, true))}</div>
            </>
          )}
        </>
      )}
    </div>
  )
}
