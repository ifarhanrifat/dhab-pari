'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Report {
  id: string; category: string; title: string; description: string | null; photo_url: string | null
  location_text: string | null; status: string; created_at: string
}

const CATEGORIES = ['street_light', 'garbage', 'water', 'road', 'drainage', 'electricity', 'stray_animals', 'other']
const STATUSES = ['reported', 'assigned', 'in_progress', 'fixed']
const STATUS_TONE: Record<string, string> = {
  reported: 'bg-amber-100 text-amber-700', assigned: 'bg-sky-100 text-sky-700',
  in_progress: 'bg-blue-100 text-blue-700', fixed: 'bg-emerald-100 text-emerald-700',
}

// Phase 1 of the "Village OS" feature set, 2026-09-30: public by design —
// same transparency stance as the Development Tracker (/projects) — so
// the village can watch its own reported problems get fixed, not just
// the committee.
export default function CivicReportsPage() {
  const { t, isUrdu } = useLocale()
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    createClient().from('civic_reports')
      .select('id, category, title, description, photo_url, location_text, status, created_at')
      .order('created_at', { ascending: false })
      .then(({ data }) => { setReports(data ?? []); setLoading(false) })
  }, [])

  const filtered = useMemo(() => reports.filter((r) =>
    (!category || r.category === category) && (!status || r.status === status)
  ), [reports, category, status])

  return (
    <div className="max-w-[1000px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-on-surface flex items-center gap-3"><AlertTriangle size={28} className="text-dp-secondary" /> {t('cr.pageTitle')}</h1>
        <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[26px] max-w-2xl mt-2">
          {t('cr.pageIntro')}{' '}
          <Link href="/portal/report-problem" className="text-dp-secondary font-semibold hover:underline">{t('cr.reportYours')}</Link>.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 mb-8">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field w-auto">
          <option value="">{t('x.allCategories')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cr.cat.${c}`)}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-field w-auto">
          <option value="">{t('cr.allStatuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`cr.status.${s}`)}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="font-sans text-[14px] text-dp-on-surface-variant text-center py-16"><LoadingDots /></p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">{t('cr.noneFound')}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((r) => (
            <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
              {r.photo_url && (
                <div className="relative w-full aspect-video bg-dp-surface-container">
                  <Image src={r.photo_url} alt="" fill sizes="500px" className="object-cover" />
                </div>
              )}
              <div className="p-5">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="text-[10.5px] font-bold px-2.5 py-1 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`cr.cat.${r.category}`)}</span>
                  <span className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full uppercase ${STATUS_TONE[r.status]}`}>{t(`cr.status.${r.status}`)}</span>
                </div>
                <h3 className="font-sans text-[17px] font-semibold text-dp-on-surface">{r.title}</h3>
                {r.description && <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-[20px]">{r.description}</p>}
                {r.location_text && (
                  <p className="font-sans text-[13px] text-dp-on-surface-variant mt-2 flex items-center gap-1"><MapPin size={12} /> {r.location_text}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
