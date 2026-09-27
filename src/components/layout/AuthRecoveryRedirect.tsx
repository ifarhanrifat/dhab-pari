'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

// Real bug, 2026-09-27: a password-reset email link is supposed to land on
// /admin/reset-password, but Supabase's admin generateLink() API silently
// drops the requested path and bakes in just the bare Site URL instead —
// confirmed directly against the live project: even after adding the
// correct entry to Authentication -> URL Configuration -> Redirect URLs
// (which DOES fix the plain /verify endpoint when hit directly), the
// admin generateLink() API itself still only ever returns a link that
// redirects to the origin with no path. Mounted at the root layout so it
// runs on every page including the homepage, and forwards a stray
// recovery hash to the actual reset-password page.
//
// Portal password reset no longer uses this at all (see /portal/
// forgot-password's own comment — it moved to a typed-in code, with no
// Supabase magic link or session/hash involved), so this only ever needs
// to send recovery hashes to the admin page now.
export function AuthRecoveryRedirect() {
  const pathname = usePathname()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash || !hash.includes('type=recovery') || !hash.includes('access_token=')) return
    if (pathname.startsWith('/admin/reset-password')) return

    // Full navigation, not router.replace() — Supabase's auth client only
    // scans window.location's hash for a recovery token once, at its own
    // initialization, which already ran (on whatever page this hash first
    // landed on) by the time a client-side route change would apply. A
    // real page load at the target URL is what actually gives it a chance
    // to detect and consume the token.
    window.location.replace(`/admin/reset-password${hash}`)
  }, [pathname])

  return null
}
