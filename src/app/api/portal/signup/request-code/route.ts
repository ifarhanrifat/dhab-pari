import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { portalSignupVerificationEmail } from '@/lib/email/portalSignupVerificationEmail'
import { validateSignupFields, checkSignupDuplicates, resolveSignupTenantId } from '@/lib/portalSignup'
import { getCookieTenantId, getTenantName } from '@/lib/tenant'

const CODE_TTL_MS = 15 * 60_000

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

// Step 1 of 2 — see /api/portal/signup/confirm-code for step 2, and
// portalSignup.ts for why the full form (not just email) is validated
// here: fail fast on a taken username/duplicate mobile before making
// someone wait on an email they can't act on anyway. Nothing from this
// request is persisted except email + code + expiry (migration 516) —
// the account itself is only ever created in confirm-code, after the
// code comes back.
export async function POST(req: NextRequest) {
  let body: Parameters<typeof validateSignupFields>[0] & { tenant_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const validated = validateSignupFields(body)
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }

  const admin = createAdminClient()
  const tenantId = await resolveSignupTenantId(admin, await getCookieTenantId(), body.tenant_id)
  const dupCheck = await checkSignupDuplicates(admin, validated.data, tenantId)
  if ('error' in dupCheck) {
    return NextResponse.json({ error: dupCheck.error }, { status: dupCheck.status })
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  try {
    const tenantName = await getTenantName(admin, tenantId)
    await sendEmail({
      to: validated.data.userEmail,
      subject: `Verify your email — ${tenantName} portal signup`,
      html: portalSignupVerificationEmail(code, tenantName),
    })
  } catch (err) {
    console.error('portal signup request-code: email send failed', err)
    return NextResponse.json({ error: 'Could not send the verification email. Please try again in a moment.' }, { status: 500 })
  }

  // Real bug found 2026-10-09: migration 590 re-keyed this table's PK from
  // (email) alone to (tenant_id, email) -- same multi-tenancy sweep as
  // notification_preferences/fcm_device_tokens -- but this upsert's
  // onConflict target and payload were never updated to match. Every call
  // here (insert or update) hit "no unique or exclusion constraint matching
  // ON CONFLICT" and failed outright, silently, since the result was never
  // checked -- the email still sent, but the row was never saved, so
  // confirm-code always found nothing and returned its generic "wrong or
  // expired" message regardless of what code was typed back.
  const { error: verificationErr } = await admin.from('portal_signup_verifications').upsert({
    tenant_id: tenantId, email: validated.data.userEmail, code, expires_at: expiresAt, attempts: 0,
  }, { onConflict: 'tenant_id,email' })
  if (verificationErr) {
    console.error('portal signup request-code: verification upsert failed', verificationErr)
    return NextResponse.json({ error: 'Could not send the verification email. Please try again in a moment.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
