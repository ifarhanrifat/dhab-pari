'use client'
import { createBrowserClient } from '@supabase/ssr'

// A single shared instance, not one per call. Every page calls createClient() directly
// inside the component body (const supabase = createClient()), so a fresh client on
// every call meant a new object reference on every render — and any useEffect/useCallback
// that lists supabase as a dependency (there are many) would re-run on every re-render,
// not just once. That re-fetches and re-sets state constantly, and can race with and
// silently clobber in-progress edits (e.g. an editable bill's line items getting reset
// mid-edit from a stale reload, dropping items that were never re-saved).
//
// makeClient() is a concrete (non-generic) wrapper around the generic createBrowserClient
// call — caching via ReturnType<typeof createBrowserClient> directly loses the resolved
// Database/SchemaName generics app-wide (every .from().select() call degrades to
// implicit-any). Routing through this monomorphic helper keeps the resolved type intact.
// Set by middleware.ts from the request's Host header, resolved against
// tenants.slug — read here once at client-init time (the cookie is
// already present in document.cookie by the time this module runs, since
// it was set server-side before the page's HTML was sent). Lets
// request_tenant_id() in RLS show an anonymous visitor the right
// tenant's public content for their subdomain; absent on the primary
// domain/localhost/previews, where every policy falls back to dhab-pari
// exactly as before. Harmless for an authenticated request too —
// my_tenant_id() always wins over it.
function readTenantIdCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const match = document.cookie.match(/(?:^|; )x-tenant-id=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : undefined
}

function makeClient() {
  const tenantId = readTenantIdCookie()
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    tenantId ? { global: { headers: { 'x-tenant-id': tenantId } } } : undefined
  )
}

let browserClient: ReturnType<typeof makeClient> | undefined

export function createClient() {
  if (!browserClient) {
    browserClient = makeClient()
  }
  return browserClient
}
