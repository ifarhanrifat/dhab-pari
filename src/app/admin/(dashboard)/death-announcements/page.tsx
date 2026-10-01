'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { HeartCrack, Radio, X } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Item {
  id: string; deceased_name: string; deceased_name_ur: string | null; age: number | null; gender: string | null
  location_text: string | null; death_datetime: string | null; funeral_datetime: string | null; burial_location: string | null
  family_contact_name: string; family_contact_mobile: string; message: string | null
  moderation_status: string; is_active: boolean; created_at: string
}

// Phase 3 of the "Village OS" feature set, 2026-09-30. Same approve=
// broadcast shape as /admin/help-requests -- one action, via the existing
// create_appeal() RPC, at the same 'emergency' severity tier since a
// death announcement is at least as time-critical.
export default function AdminDeathAnnouncementsPage() {
  const { t, isUrdu } = useLocale()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('death_announcements').select('*').order('created_at', { ascending: false })
    setItems(data ?? []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const reject = async (a: Item) => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const { error } = await supabase.from('death_announcements').update({
      moderation_status: 'rejected', reviewed_by: me?.id, reviewed_at: new Date().toISOString(),
    }).eq('id', a.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.rejected'))
    load()
  }

  const approveAndBroadcast = async (a: Item) => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const { error: updateErr } = await supabase.from('death_announcements').update({
      moderation_status: 'approved', is_active: true, reviewed_by: me?.id, reviewed_at: new Date().toISOString(),
    }).eq('id', a.id)
    if (updateErr) { toast.error(friendlyError(updateErr)); return }

    const nameLine = a.deceased_name_ur ? `${a.deceased_name} (${a.deceased_name_ur})` : a.deceased_name
    const funeralLine = a.funeral_datetime ? ` — نماز جنازہ: ${new Date(a.funeral_datetime).toLocaleString()}` : ''
    const funeralLineEn = a.funeral_datetime ? ` — Funeral: ${new Date(a.funeral_datetime).toLocaleString()}` : ''
    const { error: appealErr } = await supabase.rpc('create_appeal', {
      p_kind: 'other',
      p_severity: 'emergency',
      // Real ask, 2026-10-01: configurable default expiry per alert type
      // (migration 550) — "Death Announcement" gets its own setting
      // instead of the generic emergency default.
      p_alert_type: 'death_announcement',
      p_body_ur: `انا للہ و انا الیہ راجعون۔ ${nameLine} کا انتقال ہو گیا۔${funeralLine} رابطہ: ${a.family_contact_name} (${a.family_contact_mobile})`,
      p_body_en: `Inna lillahi wa inna ilayhi raji'un. ${nameLine} has passed away.${funeralLineEn} Contact: ${a.family_contact_name} (${a.family_contact_mobile})`,
      p_title_ur: 'وفات کی اطلاع', p_title_en: 'Death Announcement',
      p_contact_name: a.family_contact_name, p_contact_number: a.family_contact_mobile,
    })
    if (appealErr) {
      toast.error(t('mod.approvedNoBroadcast') + ': ' + friendlyError(appealErr))
    } else {
      toast.success(t('mod.approvedAndBroadcast'))
    }
    load()
  }

  const pending = items.filter((a) => a.moderation_status === 'pending')
  const approved = items.filter((a) => a.moderation_status === 'approved')
  const shown = tab === 'pending' ? pending : approved

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><HeartCrack size={26} /> {t('da.pageTitle')}</h1>
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
        {!loading && shown.map((a) => (
          <div key={a.id} className={`bg-white border rounded-lg p-4 ${tab === 'pending' ? 'border-amber-300' : 'border-dp-outline-variant'}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">{a.deceased_name}{a.deceased_name_ur ? ` (${a.deceased_name_ur})` : ''}{a.age ? ` · ${a.age}` : ''}</p>
                {a.funeral_datetime && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{t('da.funeralAt')}: {new Date(a.funeral_datetime).toLocaleString()}</p>}
                {a.burial_location && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('da.burialAt')}: {a.burial_location}</p>}
                {a.message && <p className="font-sans text-[13px] text-dp-on-surface mt-1.5">{a.message}</p>}
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{t('da.familyContact')}: {a.family_contact_name} · {a.family_contact_mobile}{a.location_text ? ` · ${a.location_text}` : ''}</p>
              </div>
              {tab === 'pending' && (
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => approveAndBroadcast(a)} title={t('mod.approveAndBroadcast')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700 flex items-center gap-1">
                    <Radio size={15} />
                  </button>
                  <button onClick={() => reject(a)} title={t('mod.reject')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><X size={15} /></button>
                </div>
              )}
            </div>
          </div>
        ))}
        {!loading && shown.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{tab === 'pending' ? t('mod.nothingPending') : t('cr.noneFound')}</p>}
      </div>
    </div>
  )
}
