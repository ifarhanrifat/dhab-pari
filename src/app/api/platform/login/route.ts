import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

// Same rate-limit shape as /api/admin/login — this panel has cross-tenant
// privilege, so it's at least as sensitive a target, not less.
const attempts = new Map<string, { count: number; lockedUntil: number; lastAttempt: number }>()

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000
const WINDOW_MS = 10 * 60 * 1000

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

  if (state.lockedUntil === 0 && now - state.lastAttempt > WINDOW_MS) {
    attempts.delete(ip)
    return { blocked: false, remaining: MAX_ATTEMPTS, retryAfter: 0 }
  }

  if (state.lockedUntil > now) {
    const retryAfter = Math.ceil((state.lockedUntil - now) / 1000)
    return { blocked: true, remaining: 0, retryAfter }
  }

  return { blocked: false, remaining: Math.max(0, MAX_ATTEMPTS - state.count), retryAfter: 0 }
}

function recordFailure(ip: string) {
  const now = Date.now()
  const state = attempts.get(ip) ?? { count: 0, lockedUntil: 0, lastAttempt: now }
  state.count += 1
  state.lastAttempt = now
  if (state.count >= MAX_ATTEMPTS) state.lockedUntil = now + LOCKOUT_MS
  attempts.set(ip, state)
}

function recordSuccess(ip: string) {
  attempts.delete(ip)
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const { blocked, retryAfter } = getRateLimitState(ip)

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
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
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
    const remainingMsg = newState.remaining > 0
      ? ` (${newState.remaining} attempt${newState.remaining === 1 ? '' : 's'} left)`
      : ''
    return NextResponse.json(
      { error: `Invalid credentials.${remainingMsg}`, remaining: newState.remaining, retryAfter: newState.retryAfter },
      { status: 401 }
    )
  }

  // A valid Supabase password doesn't mean platform access — this is a
  // separate identity from the tenant admin_users one (see migration 617).
  // Reject and sign back out rather than leaving an authenticated-but-wrong
  // session for this panel specifically.
  const { data: isPlatformAdmin } = await supabase.rpc('is_platform_admin')
  if (!isPlatformAdmin) {
    await supabase.auth.signOut()
    recordFailure(ip)
    return NextResponse.json({ error: 'This account does not have platform-admin access.' }, { status: 403 })
  }

  recordSuccess(ip)
  return NextResponse.json({ ok: true }, { status: 200 })
}
