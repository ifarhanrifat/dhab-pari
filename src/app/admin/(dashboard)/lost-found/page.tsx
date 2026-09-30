'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Search, Check, X, Power } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Post {
  id: string; type: string; item_name: string; location_text: string | null
  contact_name: string; contact_mobile: string; status: string; is_active: boolean
  moderation_status: string; created_at: string
}

// Real direction, 2026-09-30: nothing posts to the public board
// automatically. This admin page didn't exist at all before -- Lost &
// Found only ever had self-manage (portal) + staff-read RLS, no staff UI.
export default function AdminLostFoundPage() {
  const { t, isUrdu } = useLocale()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('lost_found_posts').select('*').order('created_at', { ascending: false })
    setPosts((data ?? []) as Post[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const reviewer = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    return me?.id
  }

  const approve = async (p: Post) => {
    const reviewedBy = await reviewer()
    const { error } = await supabase.from('lost_found_posts').update({ moderation_status: 'approved', is_active: true, reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() }).eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.approved')); load()
  }
  const reject = async (p: Post) => {
    const reviewedBy = await reviewer()
    const { error } = await supabase.from('lost_found_posts').update({ moderation_status: 'rejected', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() }).eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.rejected')); load()
  }
  const toggleActive = async (p: Post) => {
    const { error } = await supabase.from('lost_found_posts').update({ is_active: !p.is_active }).eq('id', p.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(p.is_active ? t('jb.deactivated') : t('jb.reactivated'))
    load()
  }

  const pending = posts.filter((p) => p.moderation_status === 'pending')
  const approved = posts.filter((p) => p.moderation_status === 'approved')
  const shown = tab === 'pending' ? pending : approved

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><Search size={26} /> {t('lf.pageTitle')}</h1>
        <div className="flex gap-2">
          <button onClick={() => setTab('pending')} className={`px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${tab === 'pending' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t('mod.pending')} {pending.length > 0 && `(${pending.length})`}
          </button>
          <button onClick={() => setTab('approved')} className={`px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${tab === 'approved' ? 'bg-dp-primary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {t('mod.approved')}
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && shown.map((p) => (
          <div key={p.id} className={`bg-white border rounded-lg p-4 flex items-center justify-between gap-4 ${tab === 'pending' ? 'border-amber-300' : 'border-dp-outline-variant'} ${p.status === 'resolved' ? 'opacity-60' : ''}`}>
            <div className="min-w-0">
              <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full uppercase ${p.type === 'lost' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>{p.type === 'lost' ? t('lf.lost') : t('lf.found')}</span>
              <p className="font-sans text-[15px] font-semibold text-dp-on-surface mt-1.5">{p.item_name}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{p.contact_name} · {p.contact_mobile}{p.location_text ? ` · ${p.location_text}` : ''}</p>
            </div>
            {tab === 'pending' ? (
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => approve(p)} title={t('mod.approve')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700"><Check size={15} /></button>
                <button onClick={() => reject(p)} title={t('mod.reject')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><X size={15} /></button>
              </div>
            ) : (
              <button onClick={() => toggleActive(p)} title={p.is_active ? t('jb.deactivateTitle') : t('jb.reactivateTitle')} className="p-2 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer shrink-0"><Power size={16} /></button>
            )}
          </div>
        ))}
        {!loading && shown.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{tab === 'pending' ? t('mod.nothingPending') : t('cr.noneFound')}</p>}
      </div>
    </div>
  )
}
