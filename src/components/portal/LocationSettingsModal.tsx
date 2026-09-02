'use client'

// Android deliberately doesn't let any app flip the phone's Location
// toggle or its own permission switch from inside a custom screen —
// that's an OS security rule. The closest legitimate equivalent, and
// what this modal actually does, is a one-tap shortcut straight to the
// *system's own* settings screen — AppSettings, a small in-app native
// plugin (android/app/.../AppSettingsPlugin.java), registered explicitly
// in MainActivity rather than through a third-party package's
// auto-discovery. (The original build used capacitor-native-settings for
// this; its registration looked entirely correct on paper — present in
// capacitor.plugins.json, its class compiled into the release dex,
// correctly signed — and still surfaced "plugin is not implemented on
// android" at runtime for reasons static inspection couldn't pin down.
// An in-app plugin, explicitly registered, has no dependency on any
// third-party package's own build/packaging to get that wrong.) No iOS
// build of this app exists, so the modal only renders its action button
// on native Android — anyone else (web) just gets the explanation.

import { useEffect, useState } from 'react'
import { MapPinOff, ShieldAlert, ExternalLink, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import type { LocationErrorReason } from '@/hooks/useLiveLocation'

interface AppSettingsPlugin {
  openLocationSettings(): Promise<{ status: boolean }>
  openAppDetailsSettings(): Promise<{ status: boolean }>
}

interface Props {
  reason: Extract<LocationErrorReason, 'services_disabled' | 'permission_denied'>
  onClose: () => void
}

export function LocationSettingsModal({ reason, onClose }: Props) {
  const { t, isUrdu } = useLocale()
  const [opening, setOpening] = useState(false)
  const [isNative, setIsNative] = useState<boolean | null>(null)

  useEffect(() => {
    import('@capacitor/core').then(({ Capacitor }) => setIsNative(Capacitor.isNativePlatform()))
  }, [])

  const openSettings = async () => {
    setOpening(true)
    try {
      const { registerPlugin } = await import('@capacitor/core')
      const AppSettings = registerPlugin<AppSettingsPlugin>('AppSettings')
      await (reason === 'services_disabled' ? AppSettings.openLocationSettings() : AppSettings.openAppDetailsSettings())
      onClose()
    } catch (err) {
      // Surfaced rather than swallowed on purpose — a silent failure here
      // gave no way to tell "the tap didn't register" (an earlier z-index
      // bug this modal shipped with) apart from "the native call itself
      // genuinely failed." Keep the modal open so the message is visible
      // instead of also closing on failure.
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  const disabled = reason === 'services_disabled'

  // z-[200] to match every other modal in this app (WalletTopupModal etc. use
  // 100-210) — this one shipped at Tailwind's default z-50, which sits below
  // Leaflet's own internal panes/controls, so on a page with a map open (like
  // this one) the map rendered visually above the modal and captured the tap
  // meant for "Open Settings" instead of passing it through.
  return (
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center ${disabled ? 'bg-amber-50 text-amber-700' : 'bg-dp-secondary-container/50 text-dp-secondary'}`}>
            {disabled ? <MapPinOff size={20} /> : <ShieldAlert size={20} />}
          </div>
          <button onClick={onClose} className="shrink-0 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer p-1"><X size={16} /></button>
        </div>
        <p className="font-sans text-[15px] font-bold text-dp-on-surface">
          {disabled ? t('af.gpsOffModalTitle') : t('af.permissionModalTitle')}
        </p>
        <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1.5 leading-relaxed">
          {disabled ? t('af.gpsOffModalBody') : t('af.permissionModalBody')}
        </p>
        {isNative ? (
          <button onClick={openSettings} disabled={opening}
            className="mt-4 w-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg font-sans text-[13.5px] font-bold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">
            {opening ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />} {t('af.openSettingsBtn')}
          </button>
        ) : (
          <p className="font-sans text-[12px] text-dp-on-surface-variant mt-4 italic">{t('af.settingsWebFallbackHint')}</p>
        )}
      </div>
    </div>
  )
}
