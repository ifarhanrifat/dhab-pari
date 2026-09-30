'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { HeartCrack, Phone, MapPin, PlusCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Item {
  id: string; deceased_name: string; deceased_name_ur: string | null; age: number | null
  location_text: string | null; funeral_datetime: string | null; burial_location: string | null
  family_contact_name: string; family_contact_mobile: string; message: string | null; created_at: string
}

// Phase 3 of the "Village OS" feature set, 2026-09-30.
export default function DeathAnnouncementsPage() {
  const { t, isUrdu } = useLocale()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase.from('death_announcements').select('*').eq('is_active', true)
      .order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => { setItems(data ?? []); setLoading(false) })
  }, [])

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1.5">
        <div className="flex items-center gap-2.5">
          <HeartCrack size={26} className="text-dp-secondary" />
          <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('da.pageTitle')}</h1>
        </div>
        <Link href="/portal/death-announcement" className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all">
          <PlusCircle size={15} /> {t('da.newAnnouncement')}
        </Link>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8">{t('da.pageIntro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : items.length === 0 ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('da.noneFound')}</p>
      ) : (
        <div className="space-y-4">
          {items.map((a) => (
            <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
              <p className="font-heading text-[18px] font-bold text-dp-on-surface">
                {a.deceased_name}{a.deceased_name_ur ? ` (${a.deceased_name_ur})` : ''}{a.age ? ` · ${a.age}` : ''}
              </p>
              {a.message && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-2">{a.message}</p>}
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 font-sans text-[12.5px] text-dp-on-surface-variant">
                {a.funeral_datetime && <span>{t('da.funeralAt')}: <span className="ltr-num">{new Date(a.funeral_datetime).toLocaleString()}</span></span>}
                {a.burial_location && <span className="flex items-center gap-1"><MapPin size={12} /> {t('da.burialAt')}: {a.burial_location}</span>}
              </div>
              <a href={`tel:${a.family_contact_mobile.replace(/\s+/g, '')}`}
                className="mt-3 inline-flex items-center gap-2 border-2 border-dp-primary text-dp-primary px-3 py-1.5 rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary hover:text-white transition-all">
                <Phone size={13} /> {a.family_contact_name} · {a.family_contact_mobile}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
