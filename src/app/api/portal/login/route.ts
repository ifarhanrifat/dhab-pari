import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

// Mirrors src/app/api/admin/login/route.ts's rate-limit shape exactly, but
// for portal_users — entirely separate in-memory limiter/table, no shared
// state with staff login. Portal users log in with a username (never a
// phone number, per direction — usernames are also the public identity for
// future chat/voting), which resolves server-side to the underlying
// synthetic-email identity via a service-role lookup (usernames aren't
// derivable client-side the way the old mobile-based synthetic email was).
const attempts = new Map<string, { count: number; lockedUntil: number; lastAttempt: number }>()

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000
const WINDOW_MS = 10 * 60 * 1000

function getClientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
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
    return { blocked: true, remaining: 0, retryAfter: Math.ceil((state.lockedUntil - now) / 1000) }
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

function syntheticEmail(mobile: string) {
  return `${mobile.replace(/[^0-9]/g, '')}@portal.dhabpari.local`
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const { blocked, remaining, retryAfter } = getRateLimitState(ip)
  if (blocked) {
    return NextResponse.json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`, retryAfter }, { status: 429 })
  }

  let body: { username?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const { username, password } = body
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Username and password are required.' }, { status: 400 })
  }
  if (username.length > 30 || password.length > 256) {
    return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 })
  }

  // Same generic "Invalid credentials" outcome whether the username doesn't
  // exist or the password is wrong — don't leak which one it was.
  const admin = createAdminClient()
  const { data: portalUser } = await admin.from('portal_users').select('mobile').ilike('username', username.trim()).maybeSingle()
  if (!portalUser) {
    recordFailure(ip)
    const newState = getRateLimitState(ip)
    return NextResponse.json({ error: 'Invalid credentials.', remaining: newState.remaining, retryAfter: newState.retryAfter }, { status: 401 })
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: (list) => list.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } }
  )

  const { error } = await supabase.auth.signInWithPassword({ email: syntheticEmail(portalUser.mobile), password })

  if (error) {
    recordFailure(ip)
    const newState = getRateLimitState(ip)
    const remainingMsg = newState.remaining > 0 ? ` (${newState.remaining} attempt${newState.remaining === 1 ? '' : 's'} left)` : ''
    return NextResponse.json({ error: `Invalid credentials.${remainingMsg}`, remaining: newState.remaining, retryAfter: newState.retryAfter }, { status: 401 })
  }

  recordSuccess(ip)
  return NextResponse.json({ ok: true }, { status: 200 })
}
