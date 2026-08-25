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
