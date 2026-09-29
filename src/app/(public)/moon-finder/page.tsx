'use client'

import { useEffect, useRef, useState } from 'react'
import { Moon, X, LocateFixed, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getMoonTarget, angularDiff, type MoonTarget } from '@/lib/moonFinder'

// Real ask, 2026-09-29: a moon icon next to the header's Hijri date that
// opens the camera and guides the visitor to where the moon actually is.
// See src/lib/moonFinder.ts for why this is sensor+astronomy math, not
// real image recognition — the same approach every published stargazing
// app uses. Best-effort: phone compasses on the web are less reliable
// than in a native app, and there's no way to read a device's true camera
// field-of-view from a browser, so the on-screen reticle position is an
// assumed-FOV approximation, not a precise overlay.
const HFOV = 60 // assumed horizontal camera field of view, degrees
const VFOV = 45 // assumed vertical camera field of view, degrees
const FOUND_TOLERANCE = 4 // degrees, both axes, to count as "found"

type Phase = 'idle' | 'starting' | 'active' | 'belowHorizon' | 'error'

export default function MoonFinderPage() {
  const { t, isUrdu } = useLocale()
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [target, setTarget] = useState<MoonTarget | null>(null)
  const [deltaAz, setDeltaAz] = useState(0)
  const [deltaAlt, setDeltaAlt] = useState(0)
  const [hasHeading, setHasHeading] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const targetRef = useRef<MoonTarget | null>(null)
  const lastUpdateRef = useRef(0)
  const orientationHandlerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null)

  useEffect(() => { targetRef.current = target }, [target])

  const stop = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    if (orientationHandlerRef.current) {
      window.removeEventListener('deviceorientationabsolute', orientationHandlerRef.current as EventListener)
      window.removeEventListener('deviceorientation', orientationHandlerRef.current as EventListener)
      orientationHandlerRef.current = null
    }
    setPhase('idle')
    setHasHeading(false)
  }

  useEffect(() => () => stop(), [])

  const handleOrientation = (e: DeviceOrientationEvent) => {
    const now = performance.now()
    if (now - lastUpdateRef.current < 80) return // ~12fps is plenty for a slow-moving target
    lastUpdateRef.current = now

    const webkitHeading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
    let heading: number | null = null
    if (typeof webkitHeading === 'number') heading = webkitHeading // iOS: already 0=N, clockwise
    else if (e.absolute && e.alpha != null) heading = (360 - e.alpha) % 360 // Android best-effort

    if (heading == null || e.beta == null) return
    const deviceAltitude = 90 - e.beta // phone held upright (camera ~horizontal) => beta≈90 => altitude≈0

    const tgt = targetRef.current
    if (!tgt) return
    setHasHeading(true)
    setDeltaAz(angularDiff(tgt.azimuth, heading))
    setDeltaAlt(tgt.altitude - deviceAltitude)
  }

  const start = async () => {
    setErrorMsg('')
    if (!navigator.mediaDevices?.getUserMedia || !window.DeviceOrientationEvent || !navigator.geolocation) {
      setPhase('error'); setErrorMsg(t('mf.unsupported')); return
    }
    setPhase('starting')

    let coords: GeolocationCoordinates
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10000 })
      )
      coords = pos.coords
    } catch {
      setPhase('error'); setErrorMsg(t('mf.needLocation')); return
    }

    const tgt = getMoonTarget(new Date(), coords.latitude, coords.longitude)
    setTarget(tgt)
    if (tgt.altitude < -2) { setPhase('belowHorizon'); return }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch {
      setPhase('error'); setErrorMsg(t('mf.needCamera')); return
    }

    // iOS 13+ gates DeviceOrientationEvent behind an explicit permission
    // prompt that can only be triggered from a user gesture — this whole
    // start() call is one, since it only ever runs from the Start button.
    const requestPermission = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission
    if (typeof requestPermission === 'function') {
      try {
        const result = await requestPermission()
        if (result !== 'granted') { setPhase('error'); setErrorMsg(t('mf.needOrientation')); return }
      } catch {
        setPhase('error'); setErrorMsg(t('mf.needOrientation')); return
      }
    }
    orientationHandlerRef.current = handleOrientation
    window.addEventListener('deviceorientationabsolute', handleOrientation as EventListener)
    window.addEventListener('deviceorientation', handleOrientation as EventListener)

    setPhase('active')
  }

  // Moon moves slowly (~0.5°/min in the sky) — refreshing every 30s keeps
  // the target accurate without doing real astronomy math every frame.
  useEffect(() => {
    if (phase !== 'active') return
    const id = setInterval(() => {
      navigator.geolocation.getCurrentPosition((pos) => {
        setTarget(getMoonTarget(new Date(), pos.coords.latitude, pos.coords.longitude))
      })
    }, 30000)
    return () => clearInterval(id)
  }, [phase])

  const found = hasHeading && Math.abs(deltaAz) < FOUND_TOLERANCE && Math.abs(deltaAlt) < FOUND_TOLERANCE
  const nx = Math.max(-1.4, Math.min(1.4, deltaAz / (HFOV / 2)))
  const ny = Math.max(-1.4, Math.min(1.4, -deltaAlt / (VFOV / 2)))
  const offscreen = Math.abs(nx) > 1 || Math.abs(ny) > 1

  return (
    <div className="max-w-[600px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Moon size={24} className="text-dp-secondary" />
        <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('mf.title')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('mf.subtitle')}</p>

      {phase === 'idle' && (
        <button onClick={start} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-4 rounded-lg font-sans text-[15px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <LocateFixed size={18} /> {t('mf.start')}
        </button>
      )}

      {phase === 'starting' && (
        <div className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('mf.starting')}</div>
      )}

      {phase === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-5 text-center">
          <p className="font-sans text-[14px] text-red-700 mb-4">{errorMsg}</p>
          <button onClick={start} className="px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">{t('mf.start')}</button>
        </div>
      )}

      {phase === 'belowHorizon' && (
        <div className="bg-slate-900 rounded-lg p-8 text-center text-white">
          <Moon size={40} className="mx-auto mb-3 opacity-40" />
          <p className="font-heading text-[18px] font-bold mb-1.5">{t('mf.belowHorizonTitle')}</p>
          <p className="font-sans text-[13.5px] text-white/70 mb-5">{t('mf.belowHorizonBody')}</p>
          <button onClick={() => setPhase('idle')} className="px-5 py-2.5 border border-white/40 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-white/10">{t('mf.stop')}</button>
        </div>
      )}

      {phase === 'active' && (
        <div className="relative rounded-lg overflow-hidden bg-black" style={{ aspectRatio: '3/4' }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

          {!hasHeading && (
            <div className="absolute inset-x-4 top-4 bg-black/60 text-white text-center rounded-lg px-3 py-2 font-sans text-[12.5px]">
              {t('mf.holdUpright')}
            </div>
          )}

          {hasHeading && !offscreen && (
            <div
              className={`absolute w-16 h-16 rounded-full border-4 -translate-x-1/2 -translate-y-1/2 transition-all duration-150 ${found ? 'border-emerald-400 shadow-[0_0_24px_8px_rgba(52,211,153,0.6)]' : 'border-white/80'}`}
              style={{ left: `${50 + nx * 45}%`, top: `${50 + ny * 45}%` }}
            />
          )}

          {hasHeading && offscreen && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-2 text-white">
                {deltaAlt > FOUND_TOLERANCE && <ArrowUp size={40} className="animate-bounce" />}
                {deltaAlt < -FOUND_TOLERANCE && <ArrowDown size={40} className="animate-bounce" />}
                {deltaAz > FOUND_TOLERANCE && <ArrowRight size={40} className="animate-bounce" />}
                {deltaAz < -FOUND_TOLERANCE && <ArrowLeft size={40} className="animate-bounce" />}
              </div>
            </div>
          )}

          {found && (
            <div className="absolute inset-x-0 bottom-16 text-center">
              <span className="inline-block bg-emerald-500 text-white px-4 py-1.5 rounded-full font-sans text-[14px] font-bold">{t('mf.found')}</span>
            </div>
          )}

          {target && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 py-3 text-white font-sans text-[12px]">
              {Math.round(target.illumination * 100)}% {t('mf.illuminated')} · {t(`mf.phase.${target.phaseLabel}`)}
            </div>
          )}

          <button onClick={stop} className="absolute top-3 end-3 bg-black/50 text-white rounded-full p-2 cursor-pointer">
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  )
}
