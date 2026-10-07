import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { validatePlatformSignupFields, checkPlatformSignupAvailability, type PlatformSignupBody } from '@/lib/platformSignup'

const MAX_ATTEMPTS = 8
const TRIAL_DAYS = 14

// Step 2 of 2 — the browser resends the whole form here plus the code,
// same shape as /api/portal/signup/confirm-code. Re-checks availability
// from scratch (a slug/email can be taken by someone else in the few
// minutes between steps). On success: creates the auth user, calls
// platform_self_signup (no is_platform_admin() gate — there's no admin
// session yet, this is the function that creates the first one), and
// signs the new admin straight into /admin.
export async function POST(req: NextRequest) {
  let body: PlatformSignupBody & { code?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const code = body.code?.trim()
  const validated = validatePlatformSignupFields(body)
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }
  if (!code) {
    return NextResponse.json({ error: 'Enter the code sent to your email.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: verification } = await admin.from('platform_signup_verifications')
    .select('code, expires_at, attempts').eq('email', validated.data.adminEmail).maybeSingle()

  const invalid = { error: 'That code is wrong or has expired. Request a new one.' }
  if (!verification) return NextResponse.json(invalid, { status: 400 })
  if (new Date(verification.expires_at).getTime() < Date.now()) return NextResponse.json(invalid, { status: 400 })
  if (verification.attempts >= MAX_ATTEMPTS) return NextResponse.json(invalid, { status: 400 })
  if (verification.code !== code) {
    await admin.from('platform_signup_verifications').update({ attempts: verification.attempts + 1 }).eq('email', validated.data.adminEmail)
    return NextResponse.json(invalid, { status: 400 })
  }

  const availability = await checkPlatformSignupAvailability(admin, validated.data)
  if ('error' in availability) {
    return NextResponse.json({ error: availability.error }, { status: 409 })
  }

  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email: validated.data.adminEmail, password: validated.data.password, email_confirm: true,
  })
  if (authErr || !authUser.user) {
    return NextResponse.json({ error: authErr?.message ?? 'Could not create account.' }, { status: 400 })
  }

  const { data: tenantId, error: signupErr } = await admin.rpc('platform_self_signup', {
    p_tenant_name: validated.data.committeeName,
    p_slug: validated.data.slug,
    p_name_ur: validated.data.nameUr,
    p_admin_full_name: validated.data.adminFullName,
    p_admin_email: validated.data.adminEmail,
    p_auth_user_id: authUser.user.id,
    p_plan_id: validated.data.planId,
    p_trial_days: TRIAL_DAYS,
  })
  if (signupErr) {
    // Roll back the auth user rather than leaving an orphaned login with
    // no tenant/admin_users row behind it.
    await admin.auth.admin.deleteUser(authUser.user.id)
    return NextResponse.json({ error: signupErr.message }, { status: 400 })
  }

  await admin.from('platform_signup_verifications').delete().eq('email', validated.data.adminEmail)

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: (list) => list.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } }
  )
  await supabase.auth.signInWithPassword({ email: validated.data.adminEmail, password: validated.data.password })

  return NextResponse.json({ success: true, tenant_id: tenantId })
}
