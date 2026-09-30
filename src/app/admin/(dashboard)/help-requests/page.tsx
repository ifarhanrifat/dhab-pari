'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { HandHeart, CheckCircle2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Req {
  id: string; category: string; description: string; location_text: string | null
  contact_name: string; contact_mobile: string; status: string; created_at: string
}

export default function AdminHelpRequestsPage() {
  const { t, isUrdu } = useLocale()
  const [requests, setRequests] = useState<Req[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('open')
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('help_requests').select('*').order('created_at', { ascending: false })
    setRequests(data ?? []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const toggleStatus = async (r: Req) => {
    const nextStatus = r.status === 'open' ? 'resolved' : 'open'
    const { error } = await supabase.from('help_requests').update({ status: nextStatus, updated_at: new Date().toISOString() }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(nextStatus === 'resolved' ? t('hr.markedResolved') : t('hr.markedOpen'))
    load()
  }

  const filtered = statusFilter ? requests.filter((r) => r.status === statusFilter) : requests

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><HandHeart size={26} /> {t('em.needHelpTitle')}</h1>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input-field w-auto">
          <option value="">{t('cr.allStatuses')}</option>
          <option value="open">{t('hr.open')}</option>
          <option value="resolved">{t('lf.resolved')}</option>
        </select>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && filtered.map((r) => (
          <div key={r.id} className={`bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4 ${r.status === 'resolved' ? 'opacity-60' : ''}`}>
            <div className="min-w-0">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high uppercase font-sans">{t(`hr.cat.${r.category}`)}</span>
              <p className="font-sans text-[14px] text-dp-on-surface mt-1.5">{r.description}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{r.contact_name} · {r.contact_mobile}{r.location_text ? ` · ${r.location_text}` : ''}</p>
            </div>
            <button onClick={() => toggleStatus(r)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer shrink-0">
              {r.status === 'open' ? <CheckCircle2 size={18} /> : <RotateCcw size={18} />}
            </button>
          </div>
        ))}
        {!loading && filtered.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('cr.noneFound')}</p>}
      </div>
    </div>
  )
}
