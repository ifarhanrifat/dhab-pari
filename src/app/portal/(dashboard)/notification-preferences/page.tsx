'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { toast } from 'sonner'
import { Bell, CloudRain, Megaphone, BellRing } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

// Phase 3 of the "Village OS" feature set, 2026-10-01. Deliberately only
// two toggles -- a true emergency broadcast (blood, a Help Request, a
// Death Announcement -- all posted at severity='emergency') is never
// muteable here (see migration 546): this is a safety system, not a
// newsletter a villager can fully opt out of.
export default function NotificationPreferencesPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading, refresh } = usePortalUser()
  const { permission, subscribe, subscribing } = usePushNotifications(user ? { portalUserId: user.id } : null)
  const [saving, setSaving] = useState<string | null>(null)

  const toggle = async (field: 'notify_weather_alerts' | 'notify_general_appeals', value: boolean) => {
    if (!user) return
    setSaving(field)
    const supabase = createClient()
    const { error } = await supabase.from('portal_users').update({ [field]: value }).eq('id', user.id)
    setSaving(null)
    if (error) { toast.error(t('np.saveFailed')); return }
    toast.success(t('np.saved'))
    refresh()
  }

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return null

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-xl">
      <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2 mb-2"><Bell size={22} className="text-dp-secondary" /> {t('np.pageTitle')}</h1>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('np.pageIntro')}</p>

      {permission !== 'granted' && permission !== 'unsupported' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <BellRing size={18} className="text-amber-700 shrink-0" />
            <p className="font-sans text-[13px] text-amber-900">{t('np.enablePushHint')}</p>
          </div>
          <button onClick={subscribe} disabled={subscribing} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 shrink-0">
            {subscribing ? t('p.saving') : t('np.enablePush')}
          </button>
        </div>
      )}

      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-4 cursor-pointer">
          <div className="flex items-center gap-3">
            <CloudRain size={20} className="text-sky-600 shrink-0" />
            <div>
              <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('np.weatherAlerts')}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('np.weatherAlertsDesc')}</p>
            </div>
          </div>
          <input type="checkbox" defaultChecked={user.notify_weather_alerts ?? true} onChange={(e) => toggle('notify_weather_alerts', e.target.checked)}
            disabled={saving === 'notify_weather_alerts'} className="accent-dp-secondary w-5 h-5 cursor-pointer shrink-0" />
        </label>

        <label className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-4 cursor-pointer">
          <div className="flex items-center gap-3">
            <Megaphone size={20} className="text-violet-600 shrink-0" />
            <div>
              <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{t('np.generalAppeals')}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('np.generalAppealsDesc')}</p>
            </div>
          </div>
          <input type="checkbox" defaultChecked={user.notify_general_appeals ?? true} onChange={(e) => toggle('notify_general_appeals', e.target.checked)}
            disabled={saving === 'notify_general_appeals'} className="accent-dp-secondary w-5 h-5 cursor-pointer shrink-0" />
        </label>
      </div>

      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-5">{t('np.emergencyNote')}</p>
    </div>
  )
}
