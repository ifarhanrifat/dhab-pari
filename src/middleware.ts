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

  const { pathname } = request.nextUrl

  // Invite / magic-link / password-reset emails redirect back here with a PKCE
  // ?code= param — exchange it for a real session (setting the auth cookies)
  // before any auth gate below runs. Without this, the very first request for
  // the redirect target would look unauthenticated, get bounced to /admin/login,
  // and the one-time code would be discarded before ever being used.
  const code = request.nextUrl.searchParams.get('code')
  if (code) {
    await supabase.auth.exchangeCodeForSession(code)
    const url = request.nextUrl.clone()
    url.searchParams.delete('code')
    const redirectResponse = NextResponse.redirect(url)
    supabaseResponse.cookies.getAll().forEach((c) => redirectResponse.cookies.set(c))
    return redirectResponse
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (pathname.startsWith('/admin/login')) {
    if (user) {
      const url = request.nextUrl.clone()
      url.pathname = '/admin'
      return NextResponse.redirect(url)
    }
    return supabaseResponse
  }

  if (pathname.startsWith('/admin')) {
    // accept-invite/forgot-password/reset-password must always render regardless
    // of session state. accept-invite and reset-password's token arrives as a
    // URL hash fragment (invisible to this server-side middleware) rather than a
    // ?code= query param, so the only place that can ever detect and establish
    // that session is the page's own client-side JS — the pages themselves
    // already show "invalid or expired" when no session shows up. forgot-password
    // is requested BY DEFINITION by someone with no session at all, so it must
    // never be gated behind having one.
    const isPublicAuthPage = pathname.startsWith('/admin/accept-invite')
      || pathname.startsWith('/admin/forgot-password')
      || pathname.startsWith('/admin/reset-password')
    if (!isPublicAuthPage) {
      if (!user) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin/login'
        return NextResponse.redirect(url)
      }

      // Defense-in-depth route confinement for the two accounting roles — RLS is
      // the real data-access boundary, this just avoids serving an obviously-
      // wrong-system page (e.g. a water accountant landing on /admin/donors)
      // instead of leaving it to render empty.
      const { data: profile } = await supabase
        .from('admin_users')
        .select('role')
        .eq('auth_user_id', user.id)
        .eq('is_active', true)
        .single()

      const role = profile?.role
      if (role === 'water_accountant' && (pathname.startsWith('/admin/donors') || pathname.startsWith('/admin/finance/donors_projects'))) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin'
        return NextResponse.redirect(url)
      }
      if (role === 'donor_accountant' && (pathname.startsWith('/admin/billing') || pathname.startsWith('/admin/finance/water_supply'))) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin'
        return NextResponse.redirect(url)
      }
      if (role !== 'super_admin' && role !== 'admin' && (pathname.startsWith('/admin/users') || pathname.startsWith('/admin/audit-log'))) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin'
        return NextResponse.redirect(url)
      }
      if (role !== 'super_admin' && pathname.startsWith('/admin/settings')) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin'
        return NextResponse.redirect(url)
      }
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
}
