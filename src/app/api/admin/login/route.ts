import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

// In-memory rate limiter — resets on cold start, fine for low-traffic admin portal
const attempts = new Map<string, { count: number; lockedUntil: number; lastAttempt: number }>()

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000  // 15 minutes
const WINDOW_MS  = 10 * 60 * 1000  // reset count after 10 min of no attempts

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

function getRateLimitState(ip: string) {
  const now = Date.now()
  const state = attempts.get(ip)

  if (!state) return { blocked: false, remaining: MAX_ATTEMPTS, retryAfter: 0 }

  // Clear stale state (no activity for WINDOW_MS and not locked)
  if (state.lockedUntil === 0 && now - state.lastAttempt > WINDOW_MS) {
    attempts.delete(ip)
    return { blocked: false, remaining: MAX_ATTEMPTS, retryAfter: 0 }
  }

  if (state.lockedUntil > now) {
    const retryAfter = Math.ceil((state.lockedUntil - now) / 1000)
    return { blocked: true, remaining: 0, retryAfter }
  }

  return {
    blocked: false,
    remaining: Math.max(0, MAX_ATTEMPTS - state.count),
    retryAfter: 0,
  }
}

function recordFailure(ip: string) {
  const now = Date.now()
  const state = attempts.get(ip) ?? { count: 0, lockedUntil: 0, lastAttempt: now }
  state.count += 1
  state.lastAttempt = now
  if (state.count >= MAX_ATTEMPTS) {
    state.lockedUntil = now + LOCKOUT_MS
  }
  attempts.set(ip, state)
}

function recordSuccess(ip: string) {
  attempts.delete(ip)
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const { blocked, remaining, retryAfter } = getRateLimitState(ip)

  if (blocked) {
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`, retryAfter },
      { status: 429 }
    )
  }

  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const { email, password } = body
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
  }

  // Trim inputs and enforce basic length limits to prevent abuse
  if (email.length > 254 || password.length > 256) {
    return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 })
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })

  if (error) {
    recordFailure(ip)
    const newState = getRateLimitState(ip)
    // Always return the same generic message regardless of whether email or password was wrong
    const remainingMsg = newState.remaining > 0
      ? ` (${newState.remaining} attempt${newState.remaining === 1 ? '' : 's'} left)`
      : ''
    return NextResponse.json(
      {
        error: `Invalid credentials.${remainingMsg}`,
        remaining: newState.remaining,
        retryAfter: newState.retryAfter,
      },
      { status: 401 }
    )
  }

  recordSuccess(ip)
  return NextResponse.json({ ok: true }, { status: 200 })
}
