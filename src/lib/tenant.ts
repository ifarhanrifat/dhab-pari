import { cookies } from 'next/headers'

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
// tenants.slug. Falls back to dhab-pari's own tenant on the primary
// domain, localhost, previews, or any request this cookie never reached
// (e.g. a background job) — never throws, never blocks account creation.
export async function getRequestTenantId(): Promise<string> {
  const cookieStore = await cookies()
  return cookieStore.get('x-tenant-id')?.value || DEFAULT_TENANT_ID
}
