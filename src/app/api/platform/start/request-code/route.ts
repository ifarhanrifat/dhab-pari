import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { platformSignupVerificationEmail } from '@/lib/email/platformSignupVerificationEmail'
import { validatePlatformSignupFields, checkPlatformSignupAvailability, type PlatformSignupBody } from '@/lib/platformSignup'

const CODE_TTL_MS = 15 * 60_000

// Same IP rate-limiting shape as /api/admin/login and /api/platform/login
// — this creates a whole new tenant, a more sensitive surface than a
// single user row, so it gets the same brute-force protection as any
// other auth-adjacent endpoint.
const attempts = new Map<string, { count: number; windowStart: number }>()
const WINDOW_MS = 60_000
const MAX_REQ = 5

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const state = attempts.get(ip)
  if (!state || now - state.windowStart > WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now })
    return false
  }
  state.count += 1
  return state.count > MAX_REQ
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

// Step 1 of 2 — see confirm-code for step 2. Same "don't persist the
// form, just email+code+expiry" shape as /api/portal/signup/request-code
// (migration 516's reasoning applies identically here).
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a minute and try again.' }, { status: 429 })
  }

  let body: PlatformSignupBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const validated = validatePlatformSignupFields(body)
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }

  const admin = createAdminClient()
  const availability = await checkPlatformSignupAvailability(admin, validated.data)
  if ('error' in availability) {
    return NextResponse.json({ error: availability.error }, { status: 409 })
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  try {
    await sendEmail({
      to: validated.data.adminEmail,
      subject: 'Verify your email to finish setting up your committee',
      html: platformSignupVerificationEmail(code, validated.data.committeeName),
    })
  } catch (err) {
    console.error('platform signup request-code: email send failed', err)
    return NextResponse.json({ error: 'Could not send the verification email. Please try again in a moment.' }, { status: 500 })
  }

  await admin.from('platform_signup_verifications').upsert({
    email: validated.data.adminEmail, code, expires_at: expiresAt, attempts: 0,
  }, { onConflict: 'email' })

  return NextResponse.json({ success: true })
}
