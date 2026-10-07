import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  // Set by middleware.ts from the request's Host header, resolved against
  // tenants.slug — lets request_tenant_id() in RLS show an anonymous
  // visitor the right tenant's public content for their subdomain. Absent
  // on the primary domain/localhost/previews, where every policy's own
  // coalesce() falls back to dhab-pari exactly as before. Harmless for an
  // authenticated request too — my_tenant_id() always wins over it.
  const tenantId = cookieStore.get('x-tenant-id')?.value

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from Server Component — ignore
          }
        },
      },
      ...(tenantId ? { global: { headers: { 'x-tenant-id': tenantId } } } : {}),
    }
  )
}
