'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { createClient } from '@/lib/supabase/client'

// Drives the "enable notifications" prompt (admin bell and portal bell both
// use this) and the actual subscribe call. Kept separate from
// NotificationBell/PortalNotificationBell since permission state is
// per-device, not per-audience — the same hook serves both.
//
// Two completely different delivery mechanisms share this one interface:
// a real browser (or an iOS Home Screen install) uses the Web Push API
// below; the Android app is a bare WebView, which can't receive Web Push
// in the background at all — it needs Firebase Cloud Messaging instead,
// via the native @capacitor/push-notifications plugin (fcm_device_tokens,
// migration 558). Everything branches once, at the top, on
// Capacitor.getPlatform() === 'android'.

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64Safe)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export type PushPermission = 'unsupported' | 'default' | 'granted' | 'denied'

const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

export function usePushNotifications(owner: { adminUserId?: string; portalUserId?: string } | null) {
  const [permission, setPermission] = useState<PushPermission>('default')
  const [isStandalone, setIsStandalone] = useState(false)
  const [isIos, setIsIos] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  // Holds the resolve/reject for whatever subscribe() call is currently
  // waiting on the plugin's 'registration'/'registrationError' event —
  // those arrive on a global listener, not as register()'s own return
  // value, so this is how the async subscribe() call below hears back.
  const pendingToken = useRef<{ resolve: (token: string) => void; reject: () => void } | null>(null)

  useEffect(() => {
    if (isNativeAndroid()) {
      PushNotifications.checkPermissions().then(({ receive }) => {
        setPermission(receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'default')
      })
      setIsStandalone(true) // an installed app is always "standalone" — no iOS-web Home Screen gate applies here
      setIsIos(false)

      const regSub = PushNotifications.addListener('registration', (token) => pendingToken.current?.resolve(token.value))
      const errSub = PushNotifications.addListener('registrationError', () => pendingToken.current?.reject())
      return () => { regSub.then((h) => h.remove()); errSub.then((h) => h.remove()) }
    }

    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    setPermission(supported ? (Notification.permission as PushPermission) : 'unsupported')

    setIsStandalone(
      window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    )
    const ua = window.navigator.userAgent
    setIsIos(/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
  }, [])

  const subscribeNative = useCallback(async () => {
    if (!owner || (!owner.adminUserId && !owner.portalUserId)) return false
    setSubscribing(true)
    try {
      const { receive } = await PushNotifications.requestPermissions()
      setPermission(receive === 'granted' ? 'granted' : 'denied')
      if (receive !== 'granted') return false

      const token = await new Promise<string>((resolve, reject) => {
        pendingToken.current = { resolve, reject }
        PushNotifications.register().catch(reject)
      })

      const supabase = createClient()
      const { error } = await supabase.from('fcm_device_tokens').upsert({
        admin_user_id: owner.adminUserId ?? null,
        portal_user_id: owner.portalUserId ?? null,
        token,
      }, { onConflict: 'token' })
      return !error
    } catch {
      return false
    } finally {
      setSubscribing(false)
      pendingToken.current = null
    }
  }, [owner])

  const subscribeWeb = useCallback(async () => {
    if (!owner || (!owner.adminUserId && !owner.portalUserId)) return false
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setPermission('unsupported'); return false }

    setSubscribing(true)
    try {
      const result = await Notification.requestPermission()
      setPermission(result as PushPermission)
      if (result !== 'granted') return false

      const registration = await navigator.serviceWorker.ready
      let sub = await registration.pushManager.getSubscription()
      if (!sub) {
        sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
        })
      }

      const json = sub.toJSON()
      const supabase = createClient()
      const { error } = await supabase.from('push_subscriptions').upsert({
        admin_user_id: owner.adminUserId ?? null,
        portal_user_id: owner.portalUserId ?? null,
        endpoint: json.endpoint!,
        p256dh: json.keys!.p256dh,
        auth: json.keys!.auth,
        user_agent: navigator.userAgent,
      }, { onConflict: 'endpoint' })
      if (error) return false

      return true
    } catch {
      return false
    } finally {
      setSubscribing(false)
    }
  }, [owner])

  const subscribe = isNativeAndroid() ? subscribeNative : subscribeWeb

  // Already granted from a previous visit (or a prior install of this same
  // device) but the DB row might be missing — e.g. cleared by the dispatch
  // route after a dead-token cleanup, or this is a fresh reinstall reusing
  // the same permission grant. Silently re-subscribes with no prompt, since
  // the OS already said yes once. Native Android always re-registers on
  // launch anyway (register() is cheap and idempotent), so this only
  // matters for the web path's getSubscription() check.
  useEffect(() => {
    if (permission !== 'granted' || !owner || (!owner.adminUserId && !owner.portalUserId)) return
    if (isNativeAndroid()) { subscribeNative(); return }
    navigator.serviceWorker?.ready.then(async (registration) => {
      const existing = await registration.pushManager.getSubscription()
      if (!existing) subscribeWeb()
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission, owner?.adminUserId, owner?.portalUserId])

  return { permission, subscribe, subscribing, isStandalone, isIos }
}
