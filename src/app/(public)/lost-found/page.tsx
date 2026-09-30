'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { Search, MapPin, Phone, MessageCircle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Post {
  id: string; type: string; item_name: string; description: string | null; photo_url: string | null
  location_text: string | null; contact_name: string; contact_mobile: string; contact_whatsapp: string | null; status: string
}

function normalizePakPhone(raw: string) {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('0') ? `92${digits.slice(1)}` : digits.startsWith('92') ? digits : `92${digits}`
}

// Phase 1 of the "Village OS" feature set, 2026-09-30 — same public/
// self-manage/staff-moderate shape as the Jobs board (job_listings), just
// for lost/found items instead of trade services.
export default function LostFoundPage() {
  const { t, isUrdu } = useLocale()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'lost' | 'found'>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    createClient().from('lost_found_posts')
      .select('id, type, item_name, description, photo_url, location_text, contact_name, contact_mobile, contact_whatsapp, status')
      .eq('is_active', true).eq('status', 'open').order('created_at', { ascending: false })
      .then(({ data }) => { setPosts(data ?? []); setLoading(false) })
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return posts.filter((p) =>
      (tab === 'all' || p.type === tab) &&
      (!q || p.item_name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q) || (p.location_text ?? '').toLowerCase().includes(q))
    )
  }, [posts, tab, search])

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3"><Search size={28} className="text-dp-secondary" /> {t('lf.pageTitle')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2">
          {t('lf.pageIntro')}{' '}
          <Link href="/portal/lost-found" className="text-dp-secondary font-semibold hover:underline">{t('lf.postYourOwn')}</Link>.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 mb-8">
        <div className="flex gap-2">
          {(['all', 'lost', 'found'] as const).map((tb) => (
            <button key={tb} onClick={() => setTab(tb)}
              className={`px-5 py-2 rounded-full font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === tb ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'}`}>
              {tb === 'all' ? t('lf.all') : tb === 'lost' ? t('lf.lost') : t('lf.found')}
            </button>
          ))}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('lf.searchPlaceholder')} className="input-field flex-1 min-w-[200px]" />
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant text-center py-16"><LoadingDots /></p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">{t('lf.noneFound')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((p) => (
            <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
              {p.photo_url && (
                <div className="relative w-full aspect-video bg-dp-surface-container">
                  <Image src={p.photo_url} alt="" fill sizes="500px" className="object-cover" />
                </div>
              )}
              <div className="p-5">
                <span className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full uppercase ${p.type === 'lost' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                  {p.type === 'lost' ? t('lf.lost') : t('lf.found')}
                </span>
                <h3 className="font-sans text-[17px] font-semibold text-dp-on-surface mt-2">{p.item_name}</h3>
                {p.description && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-[20px]">{p.description}</p>}
                {p.location_text && (
                  <p className="font-sans text-[13px] text-dp-on-surface-variant mt-2 flex items-center gap-1"><MapPin size={12} /> {p.location_text}</p>
                )}
                <div className="flex gap-2 mt-4">
                  <a href={`tel:${p.contact_mobile}`} className="flex-1 flex items-center justify-center gap-2 border-2 border-dp-primary text-dp-primary px-4 py-2 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary hover:text-white transition-all">
                    <Phone size={14} /> {t('x.call')}
                  </a>
                  {p.contact_whatsapp && (
                    <a href={`https://wa.me/${normalizePakPhone(p.contact_whatsapp)}`} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-2 bg-dp-secondary text-white px-4 py-2 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">
                      <MessageCircle size={14} /> {t('w.whatsapp')}
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
