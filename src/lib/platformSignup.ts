import type { SupabaseClient } from '@supabase/supabase-js'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'

export interface PlatformSignupBody {
  committee_name?: string; name_ur?: string; slug?: string
  admin_full_name?: string; admin_email?: string; password?: string
  plan_id?: string
}

export interface NormalizedPlatformSignup {
  committeeName: string; nameUr: string | null; slug: string
  adminFullName: string; adminEmail: string; password: string; planId: string
}

export function validatePlatformSignupFields(body: PlatformSignupBody): { error: string } | { ok: true; data: NormalizedPlatformSignup } {
  const committeeName = body.committee_name?.trim()
  const nameUr = body.name_ur?.trim() || null
  const slug = body.slug?.trim().toLowerCase()
  const adminFullName = body.admin_full_name?.trim()
  const adminEmail = body.admin_email?.trim().toLowerCase()
  const password = body.password
  const planId = body.plan_id?.trim()

  if (!committeeName || !slug || !adminFullName || !adminEmail || !password || !planId) {
    return { error: 'All fields are required.' }
  }
  if (committeeName.length > 200) {
    return { error: 'Committee name is too long.' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return { error: 'A valid email address is required.' }
  }
  if (!/^[a-z0-9-]{2,63}$/.test(slug)) {
    return { error: 'Subdomain must be lowercase letters, numbers, and hyphens only.' }
  }
  if (!passwordMeetsPolicy(password)) {
    return { error: 'Password does not meet the requirements (12+ characters, uppercase, lowercase, a number, and a special character).' }
  }

  return { ok: true, data: { committeeName, nameUr, slug, adminFullName, adminEmail, password, planId } }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = SupabaseClient<any, any, any>

// Checked up front (before sending a verification email) so nobody waits
// on an email for a slug/email they could never actually use.
export async function checkPlatformSignupAvailability(admin: AdminClient, data: NormalizedPlatformSignup): Promise<{ error: string } | { ok: true }> {
  const { data: slugTaken } = await admin.from('tenants').select('id').eq('slug', data.slug).maybeSingle()
  if (slugTaken) {
    return { error: 'That subdomain is already taken — choose another.' }
  }
  const { data: emailTaken } = await admin.from('admin_users').select('id').ilike('email', data.adminEmail).maybeSingle()
  if (emailTaken) {
    return { error: 'An admin account with this email already exists. Sign in instead.' }
  }
  return { ok: true }
}
