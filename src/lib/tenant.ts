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

// Real gap found 2026-10-08: the admin invite email's accept-invite link
// always pointed at the bare apex domain, regardless of which tenant the
// invite was for -- for any tenant other than dhab-pari, that means
// landing on the WRONG subdomain with no x-tenant-id cookie set, which
// breaks the tenant-locking this whole invite flow depends on (same bug
// class as the portal signup tenant-assignment issue this already has a
// fix for). Null (dhab-pari itself, or a lookup failure) means "use the
// apex domain, no subdomain prefix" -- its own long-standing default.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTenantSlug(client: SupabaseClient<any, any, any>, tenantId: string | null | undefined): Promise<string | null> {
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) return null
  const { data } = await client.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
  return data?.slug ?? null
}

// Duplicated from src/lib/nativeWhatsApp.ts's normalizePhone rather than
// imported, same reasoning as that file's own comment — not worth a
// cross-file import for one line.
function toIntlPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('92')) return digits
  if (digits.startsWith('0')) return '92' + digits.slice(1)
  return digits
}

// Same white-labeling reasoning as getTenantName — the "if this wasn't
// you, contact the committee" security notice should point at the real
// tenant's own WhatsApp number, not dhab-pari's. Falls back to the
// global SITE constant if the tenant never set one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTenantWhatsapp(client: SupabaseClient<any, any, any>, tenantId: string | null | undefined): Promise<{ number: string; link: string }> {
  if (tenantId) {
    const { data } = await client.from('site_settings').select('value').eq('tenant_id', tenantId).eq('key', 'whatsapp_number').maybeSingle()
    const raw = data?.value?.trim()
    const intl = raw ? toIntlPhone(raw) : null
    if (raw && intl) return { number: raw, link: `https://wa.me/${intl}` }
  }
  return { number: SITE.whatsapp, link: SITE.whatsappLink }
}
