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
//
// Real report, 2026-09-30: (1) camera never showed anything — the <video>
// tag was gated behind the 'active' phase, but the stream was attached to
// it BEFORE that phase switch, while the element didn't exist yet.
// WebCameraCaptureModal (the shop AI-scan camera) already solved this the
// right way: mount the <video> first, attach the stream once it exists.
// (2) horizontal aim was off, and vertical never resolved (kept pointing
// "up" no matter how far up the phone tilted) -- both traced to using
// raw alpha/beta directly (`(360-alpha)%360`, `90-beta`), which only
// happen to be right when the phone is dead flat. Held upright like a
// camera (beta≈90, exactly this feature's use case) those single-axis
// shortcuts drift and, past beta=90, invert sign entirely -- explains
// "always up". Replaced with the actual 3-axis rotation math.
//
// Real report, 2026-09-30, round 2, with a real moon photo: camera now
// works, but a follow-up screenshot showed the actual moon clearly inside
// the frame (near the top) while the app still showed full directional
// arrows instead of the reticle. Two most likely causes, can't fully
// distinguish without live numbers: FOUND_TOLERANCE (4°) is tighter than
// real phone sensor noise can reliably hit, and the assumed FOV (60°/45°)
// is probably narrower than this phone's real rear camera, which would
// make genuinely-close deltas register as "offscreen" too eagerly.
// Loosened both, and added a small debug readout (bottom-start corner) so
// the next test shows the real numbers instead of guessing from a photo.
const HFOV = 70 // assumed horizontal camera field of view, degrees
const VFOV = 55 // assumed vertical camera field of view, degrees
const FOUND_TOLERANCE = 8 // degrees, both axes, to count as "found"

type Phase = 'idle' | 'starting' | 'active' | 'belowHorizon' | 'error'

// Full device-rotation-based heading + elevation, not the naive
// single-axis shortcuts. Standard Tait-Bryan (Z-X'-Y'') decomposition:
// rotates the device's local frame (camera points along local -Z) into
// world East/North/Up, then reads heading and elevation off that vector
// directly instead of assuming the phone is flat.
function computeHeadingAndElevation(alpha: number, beta: number, gamma: number) {
  const aRad = alpha * Math.PI / 180
  const bRad = beta * Math.PI / 180
  const gRad = gamma * Math.PI / 180
  const cA = Math.cos(aRad), sA = Math.sin(aRad)
  const cB = Math.cos(bRad), sB = Math.sin(bRad)
  const cG = Math.cos(gRad), sG = Math.sin(gRad)

  const east = -cA * sG - sA * sB * cG
  const north = -sA * sG + cA * sB * cG
  const up = -cB * cG

  let heading = Math.atan2(east, north) * 180 / Math.PI
  if (heading < 0) heading += 360
  const elevation = Math.asin(Math.max(-1, Math.min(1, up))) * 180 / Math.PI
  return { heading, elevation }
}

export default function MoonFinderPage() {
  const { t, isUrdu } = useLocale()
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [target, setTarget] = useState<MoonTarget | null>(null)
  const [deltaAz, setDeltaAz] = useState(0)
  const [deltaAlt, setDeltaAlt] = useState(0)
  const [hasHeading, setHasHeading] = useState(false)
  // Raw readout while this is still being calibrated against real devices
  // — see the file header note. Safe to remove once the math is trusted.
  const [debugHeading, setDebugHeading] = useState(0)
  const [debugElevation, setDebugElevation] = useState(0)
  const [debugSource, setDebugSource] = useState<'webkit' | 'computed' | 'uncalibrated' | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  // If no true-north-referenced heading ever arrives (some browsers never
  // fire an absolute orientation event at all), fall back to the
  // best-effort computed one after a few seconds rather than leaving the
  // feature stuck forever on "hold upright" — flagged in the debug line
  // so it's clear accuracy may be reduced.
  const [allowUncalibrated, setAllowUncalibrated] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const targetRef = useRef<MoonTarget | null>(null)
  const lastUpdateRef = useRef(0)
  const orientationHandlerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null)
  const uncalibratedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // handleOrientation is attached via addEventListener once (in start()),
  // so it closes over state from that instant — reading allowUncalibrated
  // state directly inside it would always see its stale initial value.
  // Same reason targetRef exists above for `target`.
  const allowUncalibratedRef = useRef(false)
  // Raw sensor readings are noisy frame-to-frame — without smoothing, the
  // reticle visibly jitters/"blinks" near the found threshold (real
  // report, 2026-09-30). Heading is smoothed as a unit vector, not the
  // raw angle, so it doesn't break at the 0°/360° wraparound.
  const smoothedHeadingVecRef = useRef<{ x: number; y: number } | null>(null)
  const smoothedElevationRef = useRef<number | null>(null)

  useEffect(() => { targetRef.current = target }, [target])

  const stop = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    if (orientationHandlerRef.current) {
      window.removeEventListener('deviceorientationabsolute', orientationHandlerRef.current as EventListener)
      window.removeEventListener('deviceorientation', orientationHandlerRef.current as EventListener)
      orientationHandlerRef.current = null
    }
    if (uncalibratedTimerRef.current) { clearTimeout(uncalibratedTimerRef.current); uncalibratedTimerRef.current = null }
    allowUncalibratedRef.current = false
    smoothedHeadingVecRef.current = null
    smoothedElevationRef.current = null
    setPhase('idle')
    setHasHeading(false)
    setCameraReady(false)
    setAllowUncalibrated(false)
  }

  useEffect(() => () => stop(), [])

  const handleOrientation = (e: DeviceOrientationEvent) => {
    const now = performance.now()
    if (now - lastUpdateRef.current < 80) return // ~12fps is plenty for a slow-moving target
    lastUpdateRef.current = now
    if (e.alpha == null || e.beta == null || e.gamma == null) return

    const tgt = targetRef.current
    if (!tgt) return

    const computed = computeHeadingAndElevation(e.alpha, e.beta, e.gamma)
    // Elevation only depends on beta/gamma (device tilt) — accurate
    // regardless of whether alpha is true-north-referenced, so this
    // always updates. Smoothed (simple exponential average) — real
    // report, 2026-09-30: the raw per-frame reading was noisy enough to
    // make the reticle visibly jitter/"blink" as it neared the target.
    const SMOOTHING = 0.2
    smoothedElevationRef.current = smoothedElevationRef.current == null
      ? computed.elevation
      : smoothedElevationRef.current + SMOOTHING * (computed.elevation - smoothedElevationRef.current)
    const elevation = smoothedElevationRef.current
    setDeltaAlt(tgt.altitude - elevation)
    setDebugElevation(elevation)

    // Real report, 2026-09-30, round 3: altitude/target math is now
    // correct (confirmed via debug readout), but azimuth stayed ~17° off
    // while altitude was accurate to ~4° — a split that only makes sense
    // if `alpha` itself carries an uncalibrated offset, since alpha is
    // the ONLY input to heading (elevation above never touches it). Root
    // cause: this handler accepted alpha from plain 'deviceorientation'
    // events too, without checking they were actually true-north-
    // referenced (`e.absolute`) — on many Android setups that event can
    // fire with alpha relative to an arbitrary start orientation, not
    // north, silently corrupting heading while leaving elevation fine
    // (exactly what was observed). Now heading only updates from a
    // source we can trust: iOS's calibrated webkitCompassHeading, or an
    // event explicitly flagged e.absolute === true.
    const webkitHeading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
    const trustworthy = typeof webkitHeading === 'number' || e.absolute === true
    if (!trustworthy && !allowUncalibratedRef.current) return
    const rawHeading = typeof webkitHeading === 'number' ? webkitHeading : computed.heading
    // Smoothed as a unit vector, not the raw angle -- averaging angles
    // directly breaks at the 0°/360° wraparound (0.2*0 + 0.8*359 ≈ 287,
    // a huge spurious jump for what's really a 1° change).
    const rad = rawHeading * Math.PI / 180
    const prev = smoothedHeadingVecRef.current
    const sv = prev
      ? { x: prev.x + SMOOTHING * (Math.cos(rad) - prev.x), y: prev.y + SMOOTHING * (Math.sin(rad) - prev.y) }
      : { x: Math.cos(rad), y: Math.sin(rad) }
    smoothedHeadingVecRef.current = sv
    let heading = Math.atan2(sv.y, sv.x) * 180 / Math.PI
    if (heading < 0) heading += 360

    setHasHeading(true)
    setDeltaAz(angularDiff(tgt.azimuth, heading))
    setDebugHeading(heading)
    setDebugSource(typeof webkitHeading === 'number' ? 'webkit' : trustworthy ? 'computed' : 'uncalibrated')
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
    allowUncalibratedRef.current = false
    uncalibratedTimerRef.current = setTimeout(() => {
      allowUncalibratedRef.current = true
      setAllowUncalibrated(true)
    }, 4000)

    // Mounts the <video> tag — the camera stream is attached to it in the
    // effect below, once it actually exists in the DOM.
    setPhase('active')
  }

  // Runs once the 'active' phase has mounted the <video> element — camera
  // permission is requested here, not inside start(), so videoRef.current
  // is guaranteed non-null when the stream arrives (see file header note).
  useEffect(() => {
    if (phase !== 'active') return
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((stream) => {
      streamRef.current = stream
      if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return }
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(() => {})
      }
      setCameraReady(true)
    }).catch(() => {
      if (cancelled) return
      setPhase('error'); setErrorMsg(t('mf.needCamera'))
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

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

          {!cameraReady && (
            <div className="absolute inset-0 flex items-center justify-center text-white/70 font-sans text-[13px]">
              {t('mf.starting')}
            </div>
          )}

          {cameraReady && !hasHeading && (
            <div className="absolute inset-x-4 top-4 bg-black/60 text-white text-center rounded-lg px-3 py-2 font-sans text-[12.5px]">
              {t('mf.holdUpright')}
            </div>
          )}

          {hasHeading && !offscreen && (
            <div
              className={`absolute rounded-full border-4 border-white -translate-x-1/2 -translate-y-1/2 transition-all duration-150 ${found ? 'w-20 h-20 shadow-[0_0_24px_8px_rgba(255,255,255,0.5)]' : 'w-16 h-16 opacity-80'}`}
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
            <>
              {/* A pulsing frame around the whole view, not just the small
                  reticle — real report, 2026-09-30: the browser has no way
                  to read a phone's true camera field of view, so the
                  reticle's exact pixel position is always an assumed-FOV
                  approximation and can visibly miss the real moon even
                  when the underlying angle is genuinely close. This makes
                  "yes, you're on it" obvious without depending on that
                  pixel-perfect overlay. */}
              <div className="absolute inset-0 border-[6px] border-white/90 rounded-lg pointer-events-none animate-pulse" />
              <div className="absolute inset-x-0 bottom-16 text-center">
                <span className="inline-block bg-emerald-500 text-white px-4 py-1.5 rounded-full font-sans text-[14px] font-bold">{t('mf.found')}</span>
              </div>
            </>
          )}

          {target && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pt-6 pb-3 text-white font-sans text-[12px]">
              {Math.round(target.illumination * 100)}% {t('mf.illuminated')} · {t(`mf.phase.${target.phaseLabel}`)}
              {/* Temporary while this is being calibrated against real
                  devices -- remove once the tolerance/FOV are trusted. */}
              {hasHeading && (
                <p className="ltr-num text-white/60 text-[10px] mt-1 font-mono">
                  moon: az{Math.round(target.azimuth)}° alt{Math.round(target.altitude)}° · you: {debugSource === 'webkit' ? 'ios' : debugSource === 'uncalibrated' ? 'calc*' : 'calc'} hd{Math.round(debugHeading)}° el{Math.round(debugElevation)}° · Δaz{Math.round(deltaAz)}° Δalt{Math.round(deltaAlt)}°
                  {debugSource === 'uncalibrated' && ' · *no true-north signal, heading may drift'}
                </p>
              )}
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
