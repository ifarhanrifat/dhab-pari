'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { School, MapPin, Phone, Globe } from 'lucide-react'

interface Institute {
  id: string; name: string; name_ur: string | null; description: string | null
  address: string | null; category: string; subjects: string | null
  phone: string | null; website: string | null
}

export default function PortalInstitutesPage() {
  const { t, isUrdu } = useLocale()
  const [rows, setRows] = useState<Institute[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    createClient().from('institutes').select('*').order('name').then(({ data }) => {
      setRows((data ?? []) as Institute[])
      setLoading(false)
    })
  }, [])

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><School size={22} className="text-dp-secondary" /> {t('in.title')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('in.portalBlurb')}</p>
      </div>

      {loading ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('action.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('in.none')}</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {rows.map((r) => (
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{isUrdu && r.name_ur ? r.name_ur : r.name}</p>
                <span className="text-[9px] font-bold uppercase text-dp-secondary bg-dp-secondary/10 rounded-full px-1.5 py-0.5">{r.category}</span>
              </div>
              {r.subjects && <p className="font-sans text-[12px] text-dp-secondary font-semibold mb-1">{r.subjects}</p>}
              {r.description && <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed mb-2">{r.description}</p>}
              <div className="space-y-1">
                {r.address && <p className="font-sans text-[12px] text-dp-on-surface-variant flex items-center gap-1.5"><MapPin size={12} /> {r.address}</p>}
                {r.phone && <p className="font-sans text-[12px] text-dp-on-surface-variant flex items-center gap-1.5"><Phone size={12} /> {r.phone}</p>}
                {r.website && <a href={r.website} target="_blank" rel="noreferrer" className="font-sans text-[12px] text-dp-secondary hover:underline flex items-center gap-1.5"><Globe size={12} /> {r.website}</a>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
