'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { MapPin as MapPinIcon } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface DirEntry { id: string; category: string; name: string; name_ur: string | null; location_text: string | null; phone: string | null; lat: number | null; lng: number | null }
interface Landmark { id: string; category: string; name: string; name_ur: string | null; description: string | null; lat: number; lng: number }

const dirIcon: Record<string, { emoji: string; color: string }> = {
  mosque: { emoji: '🕌', color: '#16a34a' },
  school: { emoji: '🏫', color: '#2563eb' },
  health: { emoji: '➕', color: '#dc2626' },
  business: { emoji: '🏪', color: '#ea580c' },
}
const landmarkIcon: Record<string, { emoji: string; color: string }> = {
  graveyard: { emoji: '🪦', color: '#64748b' },
  park: { emoji: '🌳', color: '#16a34a' },
  government_office: { emoji: '🏛️', color: '#7c3aed' },
  committee_office: { emoji: '🏢', color: '#0284c7' },
  water_supply: { emoji: '💧', color: '#0891b2' },
  eid_gah: { emoji: '🕌', color: '#16a34a' },
  entrance: { emoji: '🚧', color: '#d97706' },
  other: { emoji: '📍', color: '#64748b' },
}

// Phase 3 of the "Village OS" feature set, 2026-10-01. Coordinates come
// from two places on purpose, not a merged single table: directory_entries
// (any business/health/mosque/school an admin has pinned) and
// village_landmarks (things Directory has no category for at all) --
// see migration 543 for why that split, not a new all-in-one "places"
// table, was the right call.
export default function VillageMapPage() {
  const { t, isUrdu } = useLocale()
  const [pins, setPins] = useState<MapPin[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.from('directory_entries').select('id, category, name, name_ur, location_text, phone, lat, lng').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('village_landmarks').select('id, category, name, name_ur, description, lat, lng').eq('is_active', true),
    ]).then(([dirRes, landRes]) => {
      const dirPins: MapPin[] = ((dirRes.data ?? []) as DirEntry[]).map((e) => ({
        lat: e.lat as number, lng: e.lng as number, ...dirIcon[e.category] ?? { emoji: '📍', color: '#64748b' },
        popupHtml: `<b>${isUrdu && e.name_ur ? e.name_ur : e.name}</b>${e.location_text ? `<br>${e.location_text}` : ''}${e.phone ? `<br>${e.phone}` : ''}`,
      }))
      const landPins: MapPin[] = ((landRes.data ?? []) as Landmark[]).map((l) => ({
        lat: l.lat, lng: l.lng, ...landmarkIcon[l.category] ?? landmarkIcon.other,
        popupHtml: `<b>${isUrdu && l.name_ur ? l.name_ur : l.name}</b>${l.description ? `<br>${l.description}` : ''}`,
      }))
      setPins([...dirPins, ...landPins])
      setLoading(false)
    })
  }, [isUrdu])

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <MapPinIcon size={26} className="text-dp-primary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('vm.pageTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('vm.pageIntro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : pins.length === 0 ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('vm.noneFound')}</p>
      ) : (
        <LeafletMap pins={pins} height={520} className="rounded-lg border border-dp-outline-variant" />
      )}
    </div>
  )
}
