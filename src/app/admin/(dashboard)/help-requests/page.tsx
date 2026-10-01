'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { HandHeart, CheckCircle2, RotateCcw, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Req {
  id: string; category: string; description: string; location_text: string | null
  contact_name: string; contact_mobile: string; status: string; created_at: string
  moderation_status: string; is_active: boolean
}

// Real ask, 2026-10-01: "why to create separate sections?" — approving a
// pending request (which also broadcasts it) now happens in one place,
// the Alerts & Appeals control room (/admin/notifications), alongside
// every other kind of alert instead of its own bespoke button here. This
// page is for browsing what's already live and marking it resolved.
export default function AdminHelpRequestsPage() {
  const { t, isUrdu } = useLocale()
  const [requests, setRequests] = useState<Req[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('help_requests').select('*').eq('moderation_status', 'approved').order('created_at', { ascending: false })
    setRequests(data ?? []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const toggleResolved = async (r: Req) => {
    const nextStatus = r.status === 'open' ? 'resolved' : 'open'
    const { error } = await supabase.from('help_requests').update({ status: nextStatus, updated_at: new Date().toISOString() }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(nextStatus === 'resolved' ? t('hr.markedResolved') : t('hr.markedOpen'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><HandHeart size={26} /> {t('em.needHelpTitle')}</h1>
      </div>
      <Link href="/admin/notifications" className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 hover:border-amber-400 transition-all">
        <span className="font-sans text-[13.5px] text-amber-900">{t('al.reviewPendingNote')}</span>
        <ArrowRight size={16} className="text-amber-700 shrink-0" />
      </Link>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && requests.map((r) => (
          <div key={r.id} className={`bg-white border border-dp-outline-variant rounded-lg p-4 ${r.status === 'resolved' ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high uppercase font-sans">{t(`hr.cat.${r.category}`)}</span>
                <p className="font-sans text-[14px] text-dp-on-surface mt-1.5">{r.description}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{r.contact_name} · {r.contact_mobile}{r.location_text ? ` · ${r.location_text}` : ''}</p>
              </div>
              <button onClick={() => toggleResolved(r)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer shrink-0">
                {r.status === 'open' ? <CheckCircle2 size={16} /> : <RotateCcw size={16} />}
              </button>
            </div>
          </div>
        ))}
        {!loading && requests.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('cr.noneFound')}</p>}
      </div>
    </div>
  )
}
