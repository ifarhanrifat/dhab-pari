'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { CalendarDays, MapPin, User, Clock } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Ev {
  id: string; title: string; title_ur: string | null; description: string | null; description_ur: string | null
  category: string; start_datetime: string; end_datetime: string | null; location_text: string | null
  organizer_name: string | null; organizer_contact: string | null; photo_url: string | null
  groom_name: string | null; bride_name: string | null; wedding_function: string | null
  venue_men: string | null; venue_women: string | null
  deceased_name: string | null; gathering_type: string | null
  speaker_name: string | null
  tournament_name: string | null; entry_fee: number | null; registration_contact: string | null
  agenda: string | null
}

const categoryTone: Record<string, string> = {
  religious: 'bg-emerald-50 text-emerald-700', wedding: 'bg-pink-50 text-pink-700', sports: 'bg-sky-50 text-sky-700',
  meeting: 'bg-violet-50 text-violet-700', education: 'bg-amber-50 text-amber-700', condolence: 'bg-slate-100 text-slate-700',
  other: 'bg-dp-surface-container-high text-dp-on-surface-variant',
}

// Phase 3 of the "Village OS" feature set, 2026-09-30.
export default function VillageEventsPage() {
  const { t, isUrdu } = useLocale()
  const [upcoming, setUpcoming] = useState<Ev[]>([])
  const [past, setPast] = useState<Ev[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    const nowIso = new Date().toISOString()
    Promise.all([
      supabase.from('village_events').select('*').eq('is_active', true).gte('start_datetime', nowIso).order('start_datetime', { ascending: true }),
      supabase.from('village_events').select('*').eq('is_active', true).lt('start_datetime', nowIso).order('start_datetime', { ascending: false }).limit(10),
    ]).then(([u, p]) => {
      setUpcoming(u.data ?? []); setPast(p.data ?? []); setLoading(false)
    })
  }, [])

  const card = (e: Ev, faded = false) => (
    <div key={e.id} className={`bg-white border border-dp-outline-variant rounded-lg p-5 ${faded ? 'opacity-60' : ''}`}>
      <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full uppercase ${categoryTone[e.category] ?? categoryTone.other}`}>{t(`ve.cat.${e.category}`)}{e.category === 'wedding' && e.wedding_function ? ` · ${t(`ve.fn.${e.wedding_function}`)}` : ''}{e.category === 'condolence' && e.gathering_type ? ` · ${t(`ve.gt.${e.gathering_type}`)}` : ''}</span>
      <p className="font-heading text-[18px] font-bold text-dp-on-surface mt-2">{isUrdu && e.title_ur ? e.title_ur : e.title}</p>
      {e.category === 'wedding' && (e.groom_name || e.bride_name) && (
        <p className="font-sans text-[13.5px] text-dp-on-surface mt-1">{e.groom_name}{e.groom_name && e.bride_name ? ' & ' : ''}{e.bride_name}</p>
      )}
      {e.category === 'condolence' && e.deceased_name && <p className="font-sans text-[13.5px] text-dp-on-surface mt-1">{e.deceased_name}</p>}
      {e.category === 'religious' && e.speaker_name && <p className="font-sans text-[13.5px] text-dp-on-surface mt-1">{t('ve.speakerName')}: {e.speaker_name}</p>}
      {e.category === 'sports' && e.tournament_name && <p className="font-sans text-[13.5px] text-dp-on-surface mt-1">{e.tournament_name}{e.entry_fee ? ` · ${t('ve.entryFee')}: ${e.entry_fee}` : ''}</p>}
      {e.category === 'meeting' && e.agenda && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5">{e.agenda}</p>}
      {(isUrdu ? e.description_ur : e.description) && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5">{isUrdu ? e.description_ur : e.description}</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 font-sans text-[12.5px] text-dp-on-surface-variant">
        <span className="flex items-center gap-1"><Clock size={12} /> <span className="ltr-num">{new Date(e.start_datetime).toLocaleString()}</span>{e.end_datetime && <span className="ltr-num"> – {new Date(e.end_datetime).toLocaleString()}</span>}</span>
        {e.location_text && <span className="flex items-center gap-1"><MapPin size={12} /> {e.location_text}</span>}
        {(e.venue_men || e.venue_women) && (
          <span className="flex items-center gap-1"><MapPin size={12} /> {e.venue_men ? `${t('ve.venueMen')}: ${e.venue_men}` : ''}{e.venue_men && e.venue_women ? ' · ' : ''}{e.venue_women ? `${t('ve.venueWomen')}: ${e.venue_women}` : ''}</span>
        )}
        {e.organizer_name && <span className="flex items-center gap-1"><User size={12} /> {e.organizer_name}{e.organizer_contact ? ` · ${e.organizer_contact}` : ''}</span>}
        {e.category === 'sports' && e.registration_contact && <span className="flex items-center gap-1"><User size={12} /> {t('ve.registrationContact')}: {e.registration_contact}</span>}
      </div>
    </div>
  )

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <CalendarDays size={26} className="text-dp-primary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('ve.pageTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8">{t('ve.pageIntro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : (
        <>
          {upcoming.length === 0 ? (
            <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg mb-10">{t('ve.noneFound')}</p>
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
