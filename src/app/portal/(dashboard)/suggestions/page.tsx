'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Send } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Suggestion { id: string; message: string; status: string; admin_notes: string | null; created_at: string }

const statusLabel: Record<string, { label: string; cls: string }> = {
  new: { label: 'Submitted', cls: 'bg-amber-100 text-amber-700' },
  reviewed: { label: 'Reviewed', cls: 'bg-blue-100 text-blue-700' },
  actioned: { label: 'Actioned', cls: 'bg-emerald-100 text-emerald-700' },
}

export default function PortalSuggestionsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const { data } = await supabase.from('suggestions').select('id, message, status, admin_notes, created_at')
      .eq('portal_user_id', user.id).order('created_at', { ascending: false })
    setItems(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const submit = async () => {
    if (!user || !message.trim()) { toast.error('Please write your suggestion'); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('suggestions').insert({
      name: user.full_name, mobile: user.whatsapp_number ?? user.mobile, message: message.trim(), portal_user_id: user.id, type: 'suggestion',
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Suggestion submitted')
    setMessage('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('g.suggestions')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.suggestionsBlurb')}</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-8">
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} placeholder="Your suggestion..." className="input-field resize-none mb-4" />
        <button onClick={submit} disabled={saving} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          <Send size={16} /> {saving ? 'Submitting...' : 'Submit Suggestion'}
        </button>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="px-5 py-3 border-b border-dp-outline-variant bg-dp-surface-container-low/60"><span className="font-sans text-[14px] font-bold">{t('p.mySuggestions')}</span></div>
        {items.length === 0 ? (
          <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('p.noSuggestions')}</p>
        ) : (
          items.map((s) => (
            <div key={s.id} className="px-5 py-4 border-b border-dp-outline-variant last:border-b-0">
              <div className="flex items-start justify-between gap-2">
                <p className="font-sans text-[14px] flex-1">{s.message}</p>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${statusLabel[s.status]?.cls}`}>{statusLabel[s.status]?.label ?? s.status}</span>
              </div>
              {s.admin_notes && <p className="font-sans text-[12.5px] text-dp-secondary mt-1.5">Reply: {s.admin_notes}</p>}
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{new Date(s.created_at).toLocaleDateString('en-GB')}</p>
            </div>
          ))
        )}
      </div>
    </>
  )
}
