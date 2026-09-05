'use client'

// AI photo-scan (my-shop's Add Stock camera, my-shop/sell's walk-in POS
// camera) used a plain <input type=file capture="environment"> for every
// platform. That's reliable in a real mobile browser tab, but inside the
// native Android shell's own WebView, Android's file-input intent handling
// doesn't consistently honor `capture` — several OEM builds just show the
// generic chooser (or default straight to Gallery/Photos), never launching
// the camera app itself. Same root cause as useLiveLocation.ts's own split:
// one hook, two very different implementations, picked at runtime by
// Capacitor.isNativePlatform().
//
// Native: @capacitor/camera's CameraSource.Camera opens the real device
// camera through the OS, no chooser involved. It hands back a `webPath`
// (a blob: URL Capacitor serves from its bridge), which is fetched and
// wrapped into a normal File — every existing caller (runScan(file: File))
// stays untouched.
//
// Web: returns null, telling the caller to fall back to its own
// <input capture> click — that already works fine in a browser tab and
// this file has no reason to reimplement it.
//
// Permission is checked/requested EXPLICITLY, as its own awaited step,
// before ever calling getPhoto() — reported bug: first tap shows the OS
// camera-permission dialog, user grants it, but no camera opens, and a
// second tap does nothing either. getPhoto() is documented to request
// permission internally and continue on to launch the camera in the same
// call, but that hand-off is exactly what was failing here — once
// getPhoto() has already returned (rejected) for a call made before
// permission existed, nothing retries it automatically. Requesting
// permission first, as a separate awaited round-trip, means the actual
// getPhoto() call that launches the camera only ever happens once the OS
// has already confirmed access is granted — no reliance on the plugin's
// own internal chaining. A denial (including "don't ask again", which
// Android answers instantly with no dialog on the next attempt) throws
// CameraPermissionDeniedError so the caller can point the shopkeeper at
// Settings instead of the tap silently doing nothing a second time.

export class CameraPermissionDeniedError extends Error {
  constructor() { super('Camera permission denied') }
}

// Same in-app AppSettings plugin LocationSettingsModal already uses to
// deep-link straight to this app's system settings page — see that
// component's header comment for why it's a small explicit-registration
// plugin rather than a third-party settings package.
interface AppSettingsPlugin { openAppDetailsSettings(): Promise<{ status: boolean }> }

export async function openCameraAppSettings(): Promise<void> {
  const { registerPlugin } = await import('@capacitor/core')
  const AppSettings = registerPlugin<AppSettingsPlugin>('AppSettings')
  await AppSettings.openAppDetailsSettings()
}

export async function takeNativePhoto(): Promise<File | null> {
  const { Capacitor } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return null

  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')

  const current = await Camera.checkPermissions()
  if (current.camera !== 'granted') {
    const requested = await Camera.requestPermissions({ permissions: ['camera'] })
    if (requested.camera !== 'granted') throw new CameraPermissionDeniedError()
  }

  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,
    quality: 80,
    saveToGallery: false,
  })
  if (!photo.webPath) return null

  const res = await fetch(photo.webPath)
  const blob = await res.blob()
  const mime = blob.type || `image/${photo.format || 'jpeg'}`
  return new File([blob], `scan_${Date.now()}.${photo.format || 'jpg'}`, { type: mime })
}
