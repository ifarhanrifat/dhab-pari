'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'

// Real bug, 2026-09-27: a password-reset email link is supposed to land on
// /portal/reset-password (or /admin/reset-password), but Supabase's admin
// generateLink() API silently drops the requested path and bakes in just
// the bare Site URL instead — confirmed directly against the live project:
// even after adding the correct entry to Authentication -> URL
// Configuration -> Redirect URLs (which DOES fix the plain /verify
// endpoint when hit directly), generateLink() itself still only ever
// returns a link that redirects to the origin with no path, e.g.
// "https://dhabpari.com#access_token=...&type=recovery" instead of
// ".../portal/reset-password#...". Rather than depend on getting every
// layer of Supabase's own redirect-URL matching to agree (dashboard
// config we don't have full visibility or control over from here), this
// makes the actual page the recovery lands on irrelevant: mounted at the
// root layout, so it runs on every page including the homepage, and
// forwards a stray recovery hash to the right reset-password page itself.
//
// Which reset page to send it to is read out of the access_token's own
// email claim (portal accounts are the synthetic <mobile>@portal.
// dhabpari.local address; anyone else is admin) — a JWT payload is just
// base64, not encrypted, so this needs no server round trip.
export function AuthRecoveryRedirect() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash || !hash.includes('type=recovery') || !hash.includes('access_token=')) return
    if (pathname.startsWith('/portal/reset-password') || pathname.startsWith('/admin/reset-password')) return

    const params = new URLSearchParams(hash.slice(1))
    const token = params.get('access_token')
    let isPortal = false
    try {
      const payload = JSON.parse(atob(token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      isPortal = typeof payload.email === 'string' && payload.email.endsWith('@portal.dhabpari.local')
    } catch {
      // Malformed/unreadable token — fall through to the admin page, which
      // will itself show "invalid or expired" same as any other bad link.
    }
    const target = isPortal ? '/portal/reset-password' : '/admin/reset-password'
    router.replace(`${target}${hash}`)
  }, [pathname, router])

  return null
}
