'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

// Real bug, 2026-09-27 (recovery) / 2026-09-28 (invite): an admin email
// link — password reset OR accept-invite — is supposed to land on
// /admin/reset-password or /admin/accept-invite respectively, but
// Supabase's admin generateLink()/inviteUserByEmail() APIs silently drop
// the requested path and bake in just the bare Site URL instead —
// confirmed directly against the live project for both link types: even
// after adding the correct entry to Authentication -> URL Configuration
// -> Redirect URLs (which DOES fix the plain /verify endpoint when hit
// directly), these admin APIs still only ever return a link that
// redirects to the origin with no path. Mounted at the root layout so it
// runs on every page including the homepage, and forwards a stray
// recovery/invite hash to the actual page that knows what to do with it.
//
// Portal password reset no longer uses this at all (see /portal/
// forgot-password's own comment — it moved to a typed-in code, with no
// Supabase magic link or session/hash involved), so this only ever needs
// to route admin-side hashes now.
const TARGET_BY_TYPE: Record<string, string> = {
  recovery: '/admin/reset-password',
  invite: '/admin/accept-invite',
}

export function AuthRecoveryRedirect() {
  const pathname = usePathname()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash || !hash.includes('access_token=')) return

    const params = new URLSearchParams(hash.slice(1))
    const type = params.get('type')
    const target = type ? TARGET_BY_TYPE[type] : undefined
    if (!target || pathname.startsWith(target)) return

    // Full navigation, not router.replace() — Supabase's auth client only
    // scans window.location's hash for a token once, at its own
    // initialization, which already ran (on whatever page this hash first
    // landed on) by the time a client-side route change would apply. A
    // real page load at the target URL is what actually gives it a chance
    // to detect and consume the token.
    window.location.replace(`${target}${hash}`)
  }, [pathname])

  return null
}
