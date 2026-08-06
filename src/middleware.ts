import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Edge-compatible rate limiter for /api/admin/login and /api/portal/login
// Uses a module-level Map (shared within the same worker instance)
const loginAttempts = new Map<string, { count: number; windowStart: number }>()
const LOGIN_WINDOW_MS = 60_000  // 1 minute window
const LOGIN_MAX_REQ   = 10      // max 10 POST requests to a login API per minute per IP

function middlewareRateLimit(request: NextRequest): NextResponse | null {
  const path = request.nextUrl.pathname
  if ((path !== '/api/admin/login' && path !== '/api/portal/login') || request.method !== 'POST') return null

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  // Keyed by IP+path — a burst of staff login attempts must not also rate-limit
  // portal logins (or vice versa) from the same IP (e.g. a shared village NAT).
  const key = `${ip}:${path}`

  const now = Date.now()
  const state = loginAttempts.get(key)

  if (!state || now - state.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: now })
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
      // A session can exist without being staff (a portal_users-only session,
      // since Phase 2) — redirecting to /admin unconditionally here caused an
      // infinite loop with the /admin branch below, which bounces a
      // non-staff session right back to /admin/login. Only redirect away if
      // this session actually has an admin_users row.
      const { data: staffProfile } = await supabase.from('admin_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).single()
      if (staffProfile) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin'
        return NextResponse.redirect(url)
      }
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

      // A session can be authenticated (real Supabase Auth user) without being
      // staff — since Phase 2 added portal_users, a donor/consumer session now
      // exists that previously could never occur here. Without this check none
      // of the role branches below would match (role is undefined) and such a
      // session would fall through onto /admin pages unblocked by middleware
      // (RLS would still deny the underlying data, but the page shell shouldn't
      // render for them at all).
      if (!profile) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin/login'
        return NextResponse.redirect(url)
      }

      const role = profile?.role
      if (role === 'water_accountant' && (pathname.startsWith('/admin/donors') || pathname.startsWith('/admin/finance/donors_projects'))) {
        const url = request.nextUrl.clone()
        url.pathname = '/admin'
        return NextResponse.redirect(url)
      }
      if (role === 'donor_accountant' && (pathname.startsWith('/admin/billing') || pathname.startsWith('/admin/finance/water_supply') || pathname.startsWith('/admin/connections') || pathname.startsWith('/admin/tasks') || pathname.startsWith('/admin/advances'))) {
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

  // Portal (donor/consumer) auth gate — entirely separate identity/table from
  // admin_users above; a staff session with no portal_users row is simply
  // treated as unauthenticated here, same as the reverse case above.
  if (pathname.startsWith('/portal/login')) {
    if (user) {
      const { data: portalProfile } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).single()
      if (portalProfile) {
        const url = request.nextUrl.clone()
        url.pathname = '/portal'
        return NextResponse.redirect(url)
      }
    }
    return supabaseResponse
  }

  if (pathname.startsWith('/portal/signup')) {
    return supabaseResponse
  }

  if (pathname.startsWith('/portal')) {
    if (!user) {
      const url = request.nextUrl.clone()
      url.pathname = '/portal/login'
      return NextResponse.redirect(url)
    }
    const { data: portalProfile } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).single()
    if (!portalProfile) {
      const url = request.nextUrl.clone()
      url.pathname = '/portal/login'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*', '/portal/:path*', '/api/portal/:path*'],
}
