'use client'

// One hook, two very different implementations underneath, picked at
// runtime by Capacitor.isNativePlatform() — the same bundle runs both
// inside the native Android shell and in a plain mobile browser (this
// app's capacitor.config.ts points the shell at the live site itself,
// see that file's own header comment).
//
// Native: @capacitor-community/background-geolocation, which keeps
// delivering fixes via a real Android foreground service even with the
// screen off or the app backgrounded — the whole reason the native shell
// exists. That plugin ships no JS entry point (no main/module/exports in
// its package.json, only a .d.ts) — it must be reached through
// registerPlugin(), not a normal import.
//
// Web (a driver who hasn't installed the app, or is just using it in a
// browser tab): navigator.geolocation.watchPosition — which only keeps
// delivering fixes while the tab is open and the screen is on. A Screen
// Wake Lock is requested alongside it for exactly that reason — it stops
// the phone auto-locking the screen while sharing is on, closing the
// single most common real failure mode (driver props the phone up,
// screen times out on its own after 30s, tracking silently dies). A
// wake lock is released automatically whenever the tab goes into the
// background, so it's re-acquired on visibilitychange rather than once.
// Neither of these substitutes for a driver switching apps or locking
// the phone by hand on iOS Safari — that's an OS policy, not something
// fixable from inside a browser tab.
//
// Both paths only ever call onFix at most once per minIntervalMs — this
// throttle lives here, not in each caller, since the /marketplace/trip/
// [bookingId] page's own inline throttle (12s) is exactly this same
// pattern duplicated; new callers should use this hook instead of
// re-inventing it.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface LiveLocationPosition {
  lat: number
  lng: number
}

interface UseLiveLocationOptions {
  enabled: boolean
  onFix: (pos: LiveLocationPosition) => void
  minIntervalMs?: number
  backgroundTitle?: string
  backgroundMessage?: string
}

interface BackgroundGeoPlugin {
  addWatcher(
    options: { backgroundTitle?: string; backgroundMessage?: string; requestPermissions?: boolean; distanceFilter?: number },
    callback: (position?: { latitude: number; longitude: number }, error?: { message: string }) => void
  ): Promise<string>
  removeWatcher(options: { id: string }): Promise<void>
}

export function useLiveLocation({ enabled, onFix, minIntervalMs = 12000, backgroundTitle, backgroundMessage }: UseLiveLocationOptions) {
  const [error, setError] = useState<string | null>(null)
  const [wakeLockHeld, setWakeLockHeld] = useState(false)
  const [isNative, setIsNative] = useState(false)
  const lastFixRef = useRef(0)
  const watchIdRef = useRef<string | null>(null)
  const isNativeRef = useRef(false)
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null)
  const onFixRef = useRef(onFix)
  onFixRef.current = onFix

  const throttledFix = useCallback((lat: number, lng: number) => {
    const now = Date.now()
    if (now - lastFixRef.current < minIntervalMs) return
    lastFixRef.current = now
    onFixRef.current({ lat, lng })
  }, [minIntervalMs])

  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void>; addEventListener: (ev: string, cb: () => void) => void }> } }
      if (!nav.wakeLock) return
      const lock = await nav.wakeLock.request('screen')
      wakeLockRef.current = lock
      setWakeLockHeld(true)
      lock.addEventListener('release', () => setWakeLockHeld(false))
    } catch { /* not supported (e.g. iOS < 16.4) or denied — degrades silently, web tracking still works while foregrounded */ }
  }, [])

  useEffect(() => {
    if (!enabled) { setError(null); return }
    let cancelled = false

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !wakeLockRef.current) acquireWakeLock()
    }

    const start = async () => {
      const { Capacitor, registerPlugin } = await import('@capacitor/core')
      isNativeRef.current = Capacitor.isNativePlatform()
      if (!cancelled) setIsNative(isNativeRef.current)

      if (isNativeRef.current) {
        const BackgroundGeolocation = registerPlugin<BackgroundGeoPlugin>('BackgroundGeolocation')
        try {
          const id = await BackgroundGeolocation.addWatcher(
            { backgroundTitle: backgroundTitle ?? 'Dhab Pari', backgroundMessage: backgroundMessage ?? 'Sharing your live location with riders', distanceFilter: 30 },
            (position, err) => {
              if (cancelled) return
              if (err) { setError(err.message); return }
              if (position) throttledFix(position.latitude, position.longitude)
            }
          )
          if (!cancelled) watchIdRef.current = id
        } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not start location tracking.') }
      } else {
        const { Geolocation } = await import('@capacitor/geolocation')
        try {
          const id = await Geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 10000 }, (position, err) => {
            if (cancelled) return
            if (err) { setError(err.message); return }
            if (position) throttledFix(position.coords.latitude, position.coords.longitude)
          })
          if (!cancelled) watchIdRef.current = id
        } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not start location tracking.') }
        acquireWakeLock()
        document.addEventListener('visibilitychange', handleVisibility)
      }
    }
    start()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      wakeLockRef.current?.release().catch(() => {})
      wakeLockRef.current = null
      const id = watchIdRef.current
      if (!id) return
      if (isNativeRef.current) {
        import('@capacitor/core').then(({ registerPlugin }) => {
          registerPlugin<BackgroundGeoPlugin>('BackgroundGeolocation').removeWatcher({ id }).catch(() => {})
        })
      } else {
        import('@capacitor/geolocation').then(({ Geolocation }) => { Geolocation.clearWatch({ id }).catch(() => {}) })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, backgroundTitle, backgroundMessage, throttledFix, acquireWakeLock])

  return { error, wakeLockHeld, isNative }
}

export type LocationErrorReason = 'permission_denied' | 'services_disabled' | 'timeout' | 'unavailable'

// A failed getCurrentPositionOnce() was showing one generic "could not get
// your location" toast regardless of cause — but the native plugin (and
// the browser) actually distinguish several real, different problems with
// different fixes:
//   - the app doesn't have location permission (fix: grant it in the
//     phone's app-permission settings)
//   - the *phone's* Location/GPS service itself is switched off (fix:
//     turn it on in the phone's system settings — @capacitor/geolocation's
//     Android plugin raises this as its own distinct error, code
//     OS-PLUG-GLOC-0007 "Location services are not enabled", separate from
//     permission denial; the browser's navigator.geolocation can't tell
//     these two apart on the web, both surface as POSITION_UNAVAILABLE)
//   - a timeout (weak signal / indoors — fix: move somewhere open, retry)
// Classifying lets the caller show the actual fix instead of one catch-all
// "check your permission" line that's often simply wrong (permission was
// fine, GPS was just off).
export function classifyLocationError(err: unknown): LocationErrorReason {
  const e = err as { code?: string | number; message?: string } | undefined
  const code = e?.code
  const msg = (e?.message ?? '').toLowerCase()

  if (typeof code === 'string') {
    // Native Android plugin: "OS-PLUG-GLOC-000N" string codes.
    if (code.endsWith('0007') || code.endsWith('0017')) return 'services_disabled'
    if (code.endsWith('0003') || code.endsWith('0009')) return 'permission_denied'
    if (code.endsWith('0010')) return 'timeout'
  } else if (typeof code === 'number') {
    // Browser navigator.geolocation: numeric PositionError codes.
    if (code === 1) return 'permission_denied'
    if (code === 3) return 'timeout'
    // code === 2 (POSITION_UNAVAILABLE) — the web can't tell "GPS is off"
    // from "no fix yet" any further than this, falls through below.
  }
  if (msg.includes('denied')) return 'permission_denied'
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout'
  if (msg.includes('disabled') || msg.includes('not enabled')) return 'services_disabled'
  return 'unavailable'
}

// One-shot "where am I right now" — used by a rider tapping "use my
// location", not the continuous driver-sharing path above.
// @capacitor/geolocation's getCurrentPosition works on web natively too
// (it wraps navigator.geolocation there), so this needs no native/web
// branch the way the continuous watcher above does.
export async function getCurrentPositionOnce(): Promise<LiveLocationPosition> {
  const { Geolocation } = await import('@capacitor/geolocation')
  const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true })
  return { lat: pos.coords.latitude, lng: pos.coords.longitude }
}
