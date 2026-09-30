// A short two-tone chime for new notifications, synthesized with the Web
// Audio API rather than shipping an audio file — no asset to host, works
// offline, and is trivially small. Browsers block audio until the page has
// had some user interaction (autoplay policy); playNotificationSound()
// fails silently if the AudioContext can't start, which just means no
// sound on the very first notification before anyone has clicked anything
// on the page yet — every one after that plays normally.
let ctx: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    return ctx
  } catch {
    return null
  }
}

export function playNotificationSound() {
  const audioCtx = getContext()
  if (!audioCtx) return
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const now = audioCtx.currentTime
    const notes = [880, 1108.73] // A5, then C#6 — a bright, short "ding-ding"
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + i * 0.11
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.18, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(start)
      osc.stop(start + 0.24)
    })
  } catch {
    // Autoplay/permissions can throw here even after the state check above
    // (some mobile browsers) — a missed sound is a fine failure mode, a
    // thrown error inside a realtime callback is not.
  }
}

// Real ask, 2026-09-30: a "Need Help" submission should not sound like
// every other admin notification — staff needs to recognize it without
// looking at the screen. A repeated two-tone wail (siren-like), louder
// and longer than the standard chime above, reusing the same lazily
// created AudioContext.
export function playUrgentAlertSound() {
  const audioCtx = getContext()
  if (!audioCtx) return
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const now = audioCtx.currentTime
    const cycleMs = 0.3
    const cycles = 4
    for (let i = 0; i < cycles; i++) {
      const pair = [660, 990] // lower/higher than the standard chime — reads as urgent, not routine
      pair.forEach((freq, j) => {
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.type = 'square'
        osc.frequency.value = freq
        const start = now + i * cycleMs * 2 + j * cycleMs
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.22, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, start + cycleMs - 0.02)
        osc.connect(gain)
        gain.connect(audioCtx.destination)
        osc.start(start)
        osc.stop(start + cycleMs)
      })
    }
  } catch {
    // Same fine-to-miss-a-sound reasoning as playNotificationSound() above.
  }
}
