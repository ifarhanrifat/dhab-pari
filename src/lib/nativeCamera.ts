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

import { Capacitor } from '@capacitor/core'

export async function takeNativePhoto(): Promise<File | null> {
  if (!Capacitor.isNativePlatform()) return null

  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
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
