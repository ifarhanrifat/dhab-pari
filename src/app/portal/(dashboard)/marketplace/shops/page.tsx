'use client'

// Shops pillar — extracted from the old flat marketplace hub (mp.
// pageTitle screen) so "Shops & Market" and "Travel & Transport" are two
// real, separate places instead of one long scroll. Content itself is
// unchanged from what used to live inline on the hub.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop { id: string; name: string; name_ur: string | null; location: string | null; location_ur: string | null; delivery_enabled: boolean }

export default function MarketplaceShopsPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [shops, setShops] = useState<Shop[] | null>(null)

  useEffect(() => {
    supabase.from('shops').select('id, name, name_ur, location, location_ur, delivery_enabled').eq('status', 'active').order('name')
      .then(({ data }) => setShops(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('mp.shopsHeading')}</h1>
      </div>
      {shops === null && <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>}
      {shops !== null && shops.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('mp.noShopsListed')}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {(shops ?? []).map((s) => (
          <Link key={s.id} href={`/portal/marketplace/shop/${s.id}`} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
            <p className="font-sans text-[14px] font-semibold text-dp-on-surface truncate">{isUrdu && s.name_ur ? s.name_ur : s.name}</p>
            {s.location && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1"><MapPin size={11} /> {isUrdu ? (s.location_ur || s.location) : s.location}</p>}
            <span className={`inline-block mt-2 text-[10.5px] font-bold px-2 py-0.5 rounded-full ${s.delivery_enabled ? 'bg-sky-100 text-sky-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
              {s.delivery_enabled ? t('mk.deliveryEnabled') : t('mk.pickupOnly')}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
