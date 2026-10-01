'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Timer, Save } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Setting { alert_type: string; label: string; label_ur: string | null; default_hours: number }

// Phase 3 of the "Village OS" feature set, 2026-10-01. Real ask: "can we
// have a default expiry in the settings for each kind of belt alerts...
// we will set its expiry from the setting" — how long each auto-triggered
// alert type (Help Request, Death Announcement, Weather, Chanda launch,
// and the generic emergency/important/appeal tiers) stays on the belt
// before it expires on its own, editable here instead of hardcoded
// (migration 550). Plain news items are deliberately not here — that
// page (/admin/ticker) already made staff-controlled, never-auto-expire
// a real design choice, not an oversight.
export default function AlertExpirySettingsPage() {
  const { t, isUrdu } = useLocale()
  const [settings, setSettings] = useState<Setting[]>([])
  const [hours, setHours] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('alert_expiry_settings').select('*').order('default_hours')
    setSettings((data ?? []) as Setting[])
    setHours(Object.fromEntries((data ?? []).map((s: Setting) => [s.alert_type, String(s.default_hours)])))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async (alertType: string) => {
    const h = parseInt(hours[alertType], 10)
    if (!h || h <= 0) { toast.error(t('aes.invalidHours')); return }
    setSaving(alertType)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const { error } = await supabase.from('alert_expiry_settings')
      .update({ default_hours: h, updated_at: new Date().toISOString(), updated_by: me?.id })
      .eq('alert_type', alertType)
    setSaving(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('aes.saved'))
    load()
  }

  const describeHours = (h: number) => {
    if (h % 24 === 0) { const d = h / 24; return d === 1 ? t('aes.oneDay') : `${d} ${t('aes.days')}` }
    return `${h} ${t('aes.hours')}`
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2 mb-2"><Timer size={26} /> {t('aes.title')}</h1>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8 max-w-2xl">{t('aes.intro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : (
        <div className="space-y-3 max-w-xl">
          {settings.map((s) => (
            <div key={s.alert_type} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{isUrdu && s.label_ur ? s.label_ur : s.label}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('aes.currently')}: {describeHours(s.default_hours)}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input type="number" min={1} value={hours[s.alert_type] ?? ''} onChange={(e) => setHours({ ...hours, [s.alert_type]: e.target.value })}
                  className="input-field w-20 text-center" />
                <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('aes.hoursUnit')}</span>
                <button onClick={() => save(s.alert_type)} disabled={saving === s.alert_type}
                  className="p-2 bg-dp-secondary text-white rounded-lg cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                  <Save size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
