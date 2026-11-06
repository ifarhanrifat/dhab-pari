'use client'

// Real bug reported live, 2026-11-06: tapping a push notification on
// Android (screen off, app backgrounded, or a true cold start) just
// opened the WebView at its default root URL instead of the request —
// even after a first attempt at this fix (reading the link inside
// usePushNotifications' pushNotificationActionPerformed listener).
//
// Root cause of why that first attempt didn't work: this app's native
// shell is a bare WebView pointed at the live site's root URL
// (capacitor.config.ts, server.url) — a cold start from a notification
// tap lands on the public homepage, which sits OUTSIDE
// /portal/(dashboard)/*. usePushNotifications was only ever invoked from
// WelcomeTour/NotificationOffBanner, both mounted inside that portal
// dashboard layout — so on a cold start the listener was never
// registered in time (or at all) to catch the tap Capacitor buffers for
// app-launch, and the app just sat on whatever page it opened to.
//
// Fix: register the listener here instead — mounted once, unconditionally,
// at the true app root (src/app/layout.tsx), so it exists on literally
// every page including the one the app cold-starts on. Pure routing, no
// dependency on login state or any `owner`, so it belongs on its own
// rather than bundled into usePushNotifications (which is about
// subscribing a specific admin/portal user, not navigation).

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'

export function NativePushNavigator() {
  const router = useRouter()

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return
    const sub = PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const link = (action.notification?.data as { link?: string } | undefined)?.link
      if (link) router.push(link)
    })
    return () => { sub.then((h) => h.remove()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
