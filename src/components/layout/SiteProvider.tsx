'use client'

import { createContext, useContext } from 'react'
import type { PublicSite } from '@/lib/publicSite'

// Unlike LocaleProvider (which fetches client-side after mount, since a
// person's own language preference needs a session to resolve), the
// tenant's own identity is already known from the Host header before
// any React renders at all (src/proxy.ts) -- root layout.tsx resolves
// it once, server-side, and passes it down here. No fetch, no flash of
// the wrong tenant's content, and server/client markup always match
// exactly (this is per-request, not per-user, so there's nothing for
// hydration to disagree about).
const SiteContext = createContext<PublicSite | null>(null)

export function SiteProvider({ site, children }: { site: PublicSite; children: React.ReactNode }) {
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>
}

export function useSite(): PublicSite {
  const site = useContext(SiteContext)
  if (!site) throw new Error('useSite() called outside <SiteProvider>')
  return site
}
