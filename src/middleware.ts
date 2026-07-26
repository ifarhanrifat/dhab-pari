import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Edge-compatible rate limiter for /api/admin/login
// Uses a module-level Map (shared within the same worker instance)
const loginAttempts = new Map<string, { count: number; windowStart: number }>()
const LOGIN_WINDOW_MS = 60_000  // 1 minute window
const LOGIN_MAX_REQ   = 10      // max 10 POST requests to the login API per minute per IP

function middlewareRateLimit(request: NextRequest): NextResponse | null {
  if (request.nextUrl.pathname !== '/api/admin/login' || request.method !== 'POST') return null

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'

  const now = Date.now()
  const state = loginAttempts.get(ip)

  if (!state || now - state.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now })
    return null
  }

  state.count += 1
  if (state.count > LOGIN_MAX_REQ) {
    const retryAfter = Math.ceil((LOGIN_WINDOW_MS - (now - state.windowStart)) / 1000)
    return new NextResponse(
      JSON.stringify({ error: 'Too many requests. Please slow down.', retryAfter }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(LOGIN_MAX_REQ),
          'X-RateLimit-Remaining': '0',
        },
      }
    )
  }

  return null
}

export async function middleware(request: NextRequest) {
  // Rate limit the login API endpoint before anything else
  const rateLimitResponse = middlewareRateLimit(request)
  if (rateLimitResponse) return rateLimitResponse

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (pathname.startsWith('/admin/login')) {
    if (user) {
      const url = request.nextUrl.clone()
      url.pathname = '/admin'
      return NextResponse.redirect(url)
    }
    return supabaseResponse
  }

  if (pathname.startsWith('/admin')) {
    if (!user) {
      const url = request.nextUrl.clone()
      url.pathname = '/admin/login'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
}
