// Mirrors escalate_stale_ride_dispatch_requests() (migration 792): outstation
// requests step up every 15 minutes, in-city every 4, capped at 3 steps
// (+50% max). Used client-side only to tell the rider when the next
// possible bump is due — the real fare always comes from the server.
export function nextEscalationMinutesRemaining(
  activatedAt: string | null, escalationCount: number, isOutOfCity: boolean, now: number = Date.now()
): number | null {
  if (!activatedAt || escalationCount >= 3) return null
  const stepMinutes = isOutOfCity ? 15 : 4
  const nextStepAt = new Date(activatedAt).getTime() + (escalationCount + 1) * stepMinutes * 60_000
  return Math.max(0, Math.ceil((nextStepAt - now) / 60_000))
}
