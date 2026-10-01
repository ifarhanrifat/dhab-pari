'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { HeartCrack, ArrowRight } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Item {
  id: string; deceased_name: string; deceased_name_ur: string | null; age: number | null; gender: string | null
  location_text: string | null; death_datetime: string | null; funeral_datetime: string | null; burial_location: string | null
  family_contact_name: string; family_contact_mobile: string; message: string | null
  moderation_status: string; is_active: boolean; created_at: string
}

// Real ask, 2026-10-01: "why to create separate sections?" — approving a
// pending announcement (which also broadcasts it) now happens in one
// place, the Alerts & Appeals control room (/admin/notifications),
// alongside every other kind of alert instead of its own bespoke button
// here. This page is just for browsing what's already live.
export default function AdminDeathAnnouncementsPage() {
  const { t, isUrdu } = useLocale()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('death_announcements').select('*').eq('moderation_status', 'approved').order('created_at', { ascending: false })
    setItems(data ?? []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><HeartCrack size={26} /> {t('da.pageTitle')}</h1>
      </div>
      <Link href="/admin/notifications" className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 hover:border-amber-400 transition-all">
        <span className="font-sans text-[13.5px] text-amber-900">{t('al.reviewPendingNote')}</span>
        <ArrowRight size={16} className="text-amber-700 shrink-0" />
      </Link>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && items.map((a) => (
          <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <p className="font-sans text-[15px] font-bold text-dp-on-surface">{a.deceased_name}{a.deceased_name_ur ? ` (${a.deceased_name_ur})` : ''}{a.age ? ` · ${a.age}` : ''}</p>
            {a.funeral_datetime && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{t('da.funeralAt')}: {new Date(a.funeral_datetime).toLocaleString()}</p>}
            {a.burial_location && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('da.burialAt')}: {a.burial_location}</p>}
            {a.message && <p className="font-sans text-[13px] text-dp-on-surface mt-1.5">{a.message}</p>}
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{t('da.familyContact')}: {a.family_contact_name} · {a.family_contact_mobile}{a.location_text ? ` · ${a.location_text}` : ''}</p>
          </div>
        ))}
        {!loading && items.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('cr.noneFound')}</p>}
      </div>
    </div>
  )
}
