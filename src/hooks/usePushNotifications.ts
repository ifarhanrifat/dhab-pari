'use client'
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Drives the "enable notifications" prompt (admin bell and portal bell both
// use this) and the actual browser subscribe call. Kept separate from
// NotificationBell/PortalNotificationBell since permission state is
// per-device, not per-audience — the same hook serves both.

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64Safe)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export type PushPermission = 'unsupported' | 'default' | 'granted' | 'denied'

export function usePushNotifications(owner: { adminUserId?: string; portalUserId?: string } | null) {
  const [permission, setPermission] = useState<PushPermission>('default')
  const [isStandalone, setIsStandalone] = useState(false)
  const [isIos, setIsIos] = useState(false)
  const [subscribing, setSubscribing] = useState(false)

  useEffect(() => {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    setPermission(supported ? (Notification.permission as PushPermission) : 'unsupported')

    setIsStandalone(
      window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    )
    const ua = window.navigator.userAgent
    setIsIos(/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
  }, [])

  const subscribe = useCallback(async () => {
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

  // Already granted from a previous visit (or a prior install of this same
  // device) but the DB row might be missing — e.g. cleared by the dispatch
  // route after a 410, or this is a fresh reinstall reusing the same
  // permission grant. Silently re-subscribes with no prompt, since the OS
  // already said yes once.
  useEffect(() => {
    if (permission === 'granted' && owner && (owner.adminUserId || owner.portalUserId)) {
      navigator.serviceWorker?.ready.then(async (registration) => {
        const existing = await registration.pushManager.getSubscription()
        if (!existing) subscribe()
      }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission, owner?.adminUserId, owner?.portalUserId])

  return { permission, subscribe, subscribing, isStandalone, isIos }
}
