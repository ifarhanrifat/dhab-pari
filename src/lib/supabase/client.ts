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
function makeClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

let browserClient: ReturnType<typeof makeClient> | undefined

export function createClient() {
  if (!browserClient) {
    browserClient = makeClient()
  }
  return browserClient
}
