import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { validateSignupFields, checkSignupDuplicates, createSignupAccount, resolveSignupTenantId } from '@/lib/portalSignup'
import { getCookieTenantId } from '@/lib/tenant'

const MAX_ATTEMPTS = 8

// Step 2 of 2 — the browser resends the WHOLE signup form here (nothing
// but email/code/expiry was persisted after request-code, see that
// route's own comment), plus the code from the email. Re-validates and
// re-checks duplicates from scratch rather than trusting request-code's
// earlier pass — state (an available username, say) can change in the
// few minutes someone takes to read an email.
export async function POST(req: NextRequest) {
  let body: Parameters<typeof validateSignupFields>[0] & { code?: string; tenant_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const code = body.code?.trim()
  const validated = validateSignupFields(body)
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }
  if (!code) {
    return NextResponse.json({ error: 'Enter the code sent to your email.' }, { status: 400 })
  }

  const admin = createAdminClient()
  // Must resolve tenantId before the verification lookup below, not after --
  // the table's real PK (migration 590) is (tenant_id, email), so looking
  // this row up by email alone (the bug fixed 2026-10-09 alongside
  // request-code's matching upsert) could also cross-match a different
  // tenant's pending code for the same email.
  const tenantId = await resolveSignupTenantId(admin, await getCookieTenantId(), body.tenant_id)
  const { data: verification } = await admin.from('portal_signup_verifications')
    .select('code, expires_at, attempts').eq('tenant_id', tenantId).eq('email', validated.data.userEmail).maybeSingle()

  const invalid = { error: 'That code is wrong or has expired. Request a new one.' }
  if (!verification) return NextResponse.json(invalid, { status: 400 })
  if (new Date(verification.expires_at).getTime() < Date.now()) return NextResponse.json(invalid, { status: 400 })
  if (verification.attempts >= MAX_ATTEMPTS) return NextResponse.json(invalid, { status: 400 })

  if (verification.code !== code) {
    await admin.from('portal_signup_verifications').update({ attempts: verification.attempts + 1 }).eq('tenant_id', tenantId).eq('email', validated.data.userEmail)
    return NextResponse.json(invalid, { status: 400 })
  }

  const dupCheck = await checkSignupDuplicates(admin, validated.data, tenantId)
  if ('error' in dupCheck) {
    return NextResponse.json({ error: dupCheck.error }, { status: dupCheck.status })
  }

  const result = await createSignupAccount(admin, validated.data, dupCheck.claiming, tenantId)
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  // One-time use — clear it immediately regardless of outcome from here.
  await admin.from('portal_signup_verifications').delete().eq('tenant_id', tenantId).eq('email', validated.data.userEmail)

  // Sign them in immediately (cookie-bound client) so signup flows straight
  // into the portal without a separate login step — same as the original
  // single-step route always did.
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: (list) => list.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } }
  )
  await supabase.auth.signInWithPassword({ email: result.email, password: result.password })

  return NextResponse.json({ success: true })
}
