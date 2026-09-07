'use client'

// Real fallback for the AI photo-scan buttons when the native camera
// intent fails outright — confirmed live on a rooted/custom-ROM Pixel
// 4a: CameraSource.Prompt's own "Take Photo" option still routes into
// Android's legacy ACTION_IMAGE_CAPTURE intent, which throws
// ActivityNotFoundException on that ROM (no app answers it at all —
// several privacy-hardened/de-Googled ROMs ship a camera app that
// deliberately doesn't register for it, pushing everything toward
// modern picker/CameraX flows instead; this is a ROM decision, not
// something Capacitor's own manifest <queries> declaration or a
// startActivityForResult retry can work around).
//
// getUserMedia is a completely different code path — no native intent,
// no dependency on any external camera app being registered for
// anything — and was already proven working on this exact device by
// BarcodeScannerModal (same API, same device, same session). This just
// reuses that: a live preview and a Capture button that grabs one frame
// into a canvas and hands back a File, same shape runScan() already
// expects from the file-input path.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Camera as CameraIcon, Images } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function WebCameraCaptureModal({ onCaptured, onClose, onUseGalleryInstead }: {
  onCaptured: (file: File) => void; onClose: () => void; onUseGalleryInstead?: () => void
}) {
  const { t } = useLocale()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((stream) => {
      // Same leak this session already found and fixed once in
      // BarcodeScannerModal — capture the stream from the promise
      // itself so it's always reachable to stop, even if the modal
      // closes before the video element has actually started playing.
      streamRef.current = stream
      if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return }
      if (videoRef.current) videoRef.current.srcObject = stream
      setReady(true)
    }).catch((err) => {
      if (cancelled) return
      const msg = err instanceof Error ? err.message : String(err)
      setError(/NotAllowedError|Permission/i.test(msg) ? t('sk.barcodeCameraDenied') : t('sk.barcodeCameraUnavailable'))
    })
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((tr) => tr.stop())
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const capture = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) return
      streamRef.current?.getTracks().forEach((tr) => tr.stop())
      onCaptured(new File([blob], `scan_${Date.now()}.jpg`, { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.9)
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <p className="font-sans text-[14px] font-semibold flex items-center gap-2"><CameraIcon size={18} /> {t('sk.webCameraTitle')}</p>
        <button onClick={onClose} className="p-1.5 cursor-pointer"><X size={20} /></button>
      </div>
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {error ? (
          <p className="text-white/90 font-sans text-[13px] text-center px-8">{error}</p>
        ) : (
          <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
        )}
      </div>
      <div className="flex flex-col items-center gap-3 py-4">
        {!error && (
          <button onClick={capture} disabled={!ready}
            className="w-16 h-16 rounded-full bg-white border-4 border-white/40 cursor-pointer disabled:opacity-40" aria-label={t('sk.webCameraCaptureBtn')} />
        )}
        {onUseGalleryInstead && (
          <button onClick={onUseGalleryInstead} className="flex items-center gap-1.5 text-white/80 font-sans text-[12.5px] cursor-pointer">
            <Images size={14} /> {t('sk.useGalleryInsteadBtn')}
          </button>
        )}
      </div>
    </div>,
    document.body
  )
}
