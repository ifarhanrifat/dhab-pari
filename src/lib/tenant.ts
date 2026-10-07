import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SITE } from '@/lib/constants'

// Mirrors the hardcoded fallback baked into every RLS policy's own
// coalesce() chain (see migration 624's request_tenant_id()). Used by
// server-side routes that write a tenant-scoped row via the service-role
// client (bypasses RLS entirely, and a service-role connection has no
// auth.uid() — so a column's own tenant_id DEFAULT would always resolve
// to this exact same fallback anyway, regardless of which tenant's
// subdomain the request actually came from). Those routes need the real
// value explicitly, not a column default to fall back on.
export const DEFAULT_TENANT_ID = 'bf9e4815-4104-472a-ab32-114171b7e34d'

// Set by src/proxy.ts from the request's Host header, resolved against
// tenants.slug. Null on the primary domain, localhost, previews, or any
// request this cookie never reached (e.g. a background job).
export async function getCookieTenantId(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get('x-tenant-id')?.value || null
}

// Convenience wrapper for callers that just want "the real tenant or the
// default" with no client-supplied fallback to consider.
export async function getRequestTenantId(): Promise<string> {
  return (await getCookieTenantId()) ?? DEFAULT_TENANT_ID
}

// White-labeling helper — every outbound email names the real tenant
// instead of the global SITE constant (which would always say "Dhab
// Pari" regardless of whose account the email is actually about). Falls
// back to SITE.name only if the lookup itself fails, so a quiet DB hiccup
// never blocks sending the email over branding.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTenantName(client: SupabaseClient<any, any, any>, tenantId: string | null | undefined): Promise<string> {
  if (!tenantId) return SITE.name
  const { data } = await client.from('tenants').select('name').eq('id', tenantId).maybeSingle()
  return data?.name ?? SITE.name
}
