'use client'

// Live camera barcode reader — a fundamentally different interaction
// from the AI photo-scan buttons elsewhere in the shop portal (Camera
// icon buttons): those take ONE snapshot and send it to Gemini; a
// barcode read needs a continuous decode loop over the live video feed
// until a code is actually found, since there's no way to know in
// advance which single frame will have the barcode in focus.
//
// @zxing/browser (pure JS/WASM, works in any modern browser — Safari's
// own native BarcodeDetector support is too inconsistent across iOS
// versions to rely on, and this app's iPhone users are web-only, see
// appDownload.ts) rather than the browser's native BarcodeDetector API,
// so one code path works identically on the native Android app's
// Chromium WebView and on Safari.
//
// Deliberately its own modal, not folded into the existing scan-photo
// <input type="file" capture> buttons — those are a single tap that
// hands off to the OS camera app/chooser; this needs to keep a live
// <video> element on screen while ZXing decodes frame after frame, so
// it has to own its own camera permission + stream lifecycle instead.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Barcode } from 'lucide-react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function BarcodeScannerModal({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) {
  const { t } = useLocale()
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const reader = new BrowserMultiFormatReader()
    reader.decodeFromConstraints(
      { video: { facingMode: 'environment' } },
      videoRef.current ?? undefined,
      (result, err, controls) => {
        controlsRef.current = controls
        if (cancelled) return
        // ZXing calls this callback every frame, even ones with no code
        // found (err set to a plain "not found" — expected, not a real
        // failure) — only a genuine `result` means an actual read.
        if (result) {
          controls.stop()
          onDetected(result.getText())
        }
      }
    ).catch((err) => {
      if (cancelled) return
      // The one real failure mode worth naming specifically: camera
      // permission refused. Everything else (no camera at all, etc.)
      // falls back to a plain message pointing at manual entry.
      const msg = err instanceof Error ? err.message : String(err)
      setError(/NotAllowedError|Permission/i.test(msg) ? t('sk.barcodeCameraDenied') : t('sk.barcodeCameraUnavailable'))
    })
    return () => {
      cancelled = true
      controlsRef.current?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // No SSR-mount gate needed — this component only ever renders once a
  // parent screen flips a client-side "show scanner" state to true (a
  // button click), so `document` is always available by then.
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <p className="font-sans text-[14px] font-semibold flex items-center gap-2"><Barcode size={18} /> {t('sk.scanBarcodeTitle')}</p>
        <button onClick={onClose} className="p-1.5 cursor-pointer"><X size={20} /></button>
      </div>
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {error ? (
          <p className="text-white/90 font-sans text-[13px] text-center px-8">{error}</p>
        ) : (
          <>
            <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
            <div className="absolute inset-x-10 top-1/2 -translate-y-1/2 h-24 border-2 border-white/80 rounded-lg pointer-events-none" />
            <p className="absolute bottom-8 inset-x-4 text-center text-white/80 font-sans text-[12.5px]">{t('sk.scanBarcodeHint')}</p>
          </>
        )}
      </div>
      {!error && <div className="flex items-center justify-center gap-2 py-3 text-white/60 font-sans text-[11px]"><Loader2 size={12} className="animate-spin" /> {t('sk.scanBarcodeSearching')}</div>}
    </div>,
    document.body
  )
}
