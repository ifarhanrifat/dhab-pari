'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { HandHeart, Sparkles, Send } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'

interface Item { id: string; message: string; type: string; status: string; admin_notes: string | null; created_at: string }

const statusKey: Record<string, { key: string; cls: string }> = {
  new: { key: 'p.statusSubmitted', cls: 'bg-amber-100 text-amber-700' },
  reviewed: { key: 'p.statusReviewed', cls: 'bg-blue-100 text-blue-700' },
  actioned: { key: 'p.statusActioned', cls: 'bg-emerald-100 text-emerald-700' },
}
const typeKey: Record<string, string> = { volunteer: 'p.typeVolunteer', role_request: 'p.typeRoleRequest' }

// Both flows are deliberately lightweight: they just post into the existing
// `suggestions` inbox (type='volunteer' / 'role_request') for staff to
// review — no auto-granting of the publisher role, matching how every other
// role change in this app already works (manual, via User Management).
export default function PortalGetInvolvedPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [skills, setSkills] = useState('')
  const [roleSkills, setRoleSkills] = useState('')
  const [savingVolunteer, setSavingVolunteer] = useState(false)
  const [savingRole, setSavingRole] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const { data } = await supabase.from('suggestions').select('id, message, type, status, admin_notes, created_at')
      .eq('portal_user_id', user.id).in('type', ['volunteer', 'role_request']).order('created_at', { ascending: false })
    setItems(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const submitVolunteer = async () => {
    if (!user || !skills.trim()) { toast.error(t('p.describeHowHelp')); return }
    setSavingVolunteer(true)
    const supabase = createClient()
    const { error } = await supabase.from('suggestions').insert({
      name: user.display_name || user.username || user.full_name, mobile: user.whatsapp_number ?? user.mobile, message: skills.trim(), portal_user_id: user.id, type: 'volunteer',
    })
    setSavingVolunteer(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.volunteerSubmitted'))
    setSkills('')
    load()
  }

  const submitRoleRequest = async () => {
    if (!user || !roleSkills.trim()) { toast.error(t('p.describeSkills')); return }
    setSavingRole(true)
    const supabase = createClient()
    const { error } = await supabase.from('suggestions').insert({
      name: user.display_name || user.username || user.full_name, mobile: user.whatsapp_number ?? user.mobile, message: roleSkills.trim(), portal_user_id: user.id, type: 'role_request',
    })
    setSavingRole(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.requestSubmitted'))
    setRoleSkills('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2">{t('p.getInvolved')} <PortalHelp pageKey="getInvolved" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.getInvolvedBlurb')}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
          <h2 className="font-heading text-[17px] font-bold text-dp-primary flex items-center gap-2 mb-3"><HandHeart size={18} className="text-dp-secondary" /> {t('p.volunteer')}</h2>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mb-3">{t('p.volunteerBlurb')}</p>
          <textarea value={skills} onChange={(e) => setSkills(e.target.value)} rows={4} placeholder={t('p.volunteerPlaceholder')} className="input-field resize-none mb-3" />
          <button onClick={submitVolunteer} disabled={savingVolunteer} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            <Send size={14} /> {savingVolunteer ? t('p.submitting') : t('p.submit')}
          </button>
        </div>

        <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
          <h2 className="font-heading text-[17px] font-bold text-dp-primary flex items-center gap-2 mb-3"><Sparkles size={18} className="text-dp-secondary" /> {t('p.requestPublisher')}</h2>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mb-3">{t('p.requestPublisherBlurb')}</p>
          <textarea value={roleSkills} onChange={(e) => setRoleSkills(e.target.value)} rows={4} placeholder={t('p.rolePlaceholder')} className="input-field resize-none mb-3" />
          <button onClick={submitRoleRequest} disabled={savingRole} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            <Send size={14} /> {savingRole ? t('p.submitting') : t('p.request')}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low/60"><span className="font-sans text-[14px] font-bold">{t('p.myRequests')}</span></div>
        {items.length === 0 ? (
          <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('p.noRequests')}</p>
        ) : (
          items.map((i) => (
            <div key={i.id} className="px-5 py-4 border-b border-dp-outline-variant last:border-b-0">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <span className="font-sans text-[11px] font-bold text-dp-secondary uppercase tracking-wide">{typeKey[i.type] ? t(typeKey[i.type]) : i.type}</span>
                  <p className="font-sans text-[14px] mt-0.5">{i.message}</p>
                </div>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${statusKey[i.status]?.cls}`}>{statusKey[i.status] ? t(statusKey[i.status].key) : i.status}</span>
              </div>
              {i.admin_notes && <p className="font-sans text-[12.5px] text-dp-secondary mt-1.5">{t('p.replyLabel')}: {i.admin_notes}</p>}
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{new Date(i.created_at).toLocaleDateString('en-GB')}</p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
