'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { HandHeart, CheckCircle2, RotateCcw, X, Radio } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Req {
  id: string; category: string; description: string; location_text: string | null
  contact_name: string; contact_mobile: string; status: string; created_at: string
  moderation_status: string; is_active: boolean
}

// Real direction, 2026-09-30: nothing posts to the public "Need Help"
// board automatically — a committee member has to approve it first.
// Approving a help request is also what broadcasts it (news ticker + a
// notification to every portal user), via the same create_appeal() RPC
// the existing emergency-appeal feature already uses (migrations 195/196)
// — no new broadcast mechanism, just calling the one already built.
export default function AdminHelpRequestsPage() {
  const { t, isUrdu } = useLocale()
  const [requests, setRequests] = useState<Req[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('help_requests').select('*').order('created_at', { ascending: false })
    setRequests(data ?? []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const reject = async (r: Req) => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const { error } = await supabase.from('help_requests').update({
      moderation_status: 'rejected', reviewed_by: me?.id, reviewed_at: new Date().toISOString(),
    }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.rejected'))
    load()
  }

  // Approve = broadcast, per direction: one action, not two. Community
  // "Need Help" requests are urgent enough that splitting "show on the
  // board" from "tell everyone" would just mean a second forgotten step.
  const approveAndBroadcast = async (r: Req) => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const { error: updateErr } = await supabase.from('help_requests').update({
      moderation_status: 'approved', is_active: true, reviewed_by: me?.id, reviewed_at: new Date().toISOString(),
    }).eq('id', r.id)
    if (updateErr) { toast.error(friendlyError(updateErr)); return }

    const catLabel = t(`hr.cat.${r.category}`)
    const { error: appealErr } = await supabase.rpc('create_appeal', {
      p_kind: r.category === 'medical' ? 'medical' : 'other',
      p_body_ur: `${catLabel}: ${r.description} — رابطہ: ${r.contact_name} (${r.contact_mobile})`,
      p_body_en: `${catLabel}: ${r.description} — Contact: ${r.contact_name} (${r.contact_mobile})`,
      p_title_ur: 'مدد درکار ہے', p_title_en: 'Need Help',
      p_contact_name: r.contact_name, p_contact_number: r.contact_mobile,
    })
    if (appealErr) {
      // The help request is still approved and visible on /emergency even
      // if the broadcast itself fails (e.g. the approving admin lacks the
      // appeal permission) -- better than losing the approval too.
      toast.error(t('mod.approvedNoBroadcast') + ': ' + friendlyError(appealErr))
    } else {
      toast.success(t('mod.approvedAndBroadcast'))
    }
    load()
  }

  const toggleResolved = async (r: Req) => {
    const nextStatus = r.status === 'open' ? 'resolved' : 'open'
    const { error } = await supabase.from('help_requests').update({ status: nextStatus, updated_at: new Date().toISOString() }).eq('id', r.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(nextStatus === 'resolved' ? t('hr.markedResolved') : t('hr.markedOpen'))
    load()
  }

  const pending = requests.filter((r) => r.moderation_status === 'pending')
  const approved = requests.filter((r) => r.moderation_status === 'approved')
  const shown = tab === 'pending' ? pending : approved

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><HandHeart size={26} /> {t('em.needHelpTitle')}</h1>
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
        {!loading && shown.map((r) => (
          <div key={r.id} className={`bg-white border rounded-lg p-4 ${tab === 'pending' ? 'border-amber-300' : 'border-dp-outline-variant'} ${r.status === 'resolved' ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high uppercase font-sans">{t(`hr.cat.${r.category}`)}</span>
                <p className="font-sans text-[14px] text-dp-on-surface mt-1.5">{r.description}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{r.contact_name} · {r.contact_mobile}{r.location_text ? ` · ${r.location_text}` : ''}</p>
              </div>
              {tab === 'pending' ? (
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => approveAndBroadcast(r)} title={t('mod.approveAndBroadcast')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700 flex items-center gap-1">
                    <Radio size={15} />
                  </button>
                  <button onClick={() => reject(r)} title={t('mod.reject')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><X size={15} /></button>
                </div>
              ) : (
                <button onClick={() => toggleResolved(r)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer shrink-0">
                  {r.status === 'open' ? <CheckCircle2 size={16} /> : <RotateCcw size={16} />}
                </button>
              )}
            </div>
          </div>
        ))}
        {!loading && shown.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{tab === 'pending' ? t('mod.nothingPending') : t('cr.noneFound')}</p>}
      </div>
    </div>
  )
}
