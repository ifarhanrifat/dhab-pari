import type { SupabaseClient } from '@supabase/supabase-js'

export interface SignupBody {
  full_name?: string; name_ur?: string; father_husband_name?: string
  mobile?: string; whatsapp_number?: string; password?: string
  donor_type?: string; country?: string; sector?: string
  username?: string; email?: string
}

export interface NormalizedSignup {
  fullName: string; nameUr: string | null; fatherName: string
  mobile: string; whatsapp: string; password: string
  donorType: 'villager' | 'overseas'; country: string | null; sector: string | null
  username: string; userEmail: string
}

export function syntheticEmail(mobile: string) {
  return `${mobile.replace(/[^0-9]/g, '')}@portal.dhabpari.local`
}

// Field-format validation only — no DB round trip. Shared between request-
// code (fail fast before sending an email nobody can act on) and confirm-
// code (the form is resent in full there, since nothing about it is
// persisted server-side while waiting on the code — see migration 516's
// comment on why).
export function validateSignupFields(body: SignupBody): { error: string } | { ok: true; data: NormalizedSignup } {
  const fullName = body.full_name?.trim()
  const mobile = body.mobile?.trim()
  const password = body.password
  const whatsapp = body.whatsapp_number?.trim()
  const fatherName = body.father_husband_name?.trim()
  const nameUr = body.name_ur?.trim() || null
  const donorType = body.donor_type === 'overseas' ? 'overseas' : 'villager'
  const country = donorType === 'overseas' ? (body.country?.trim() || null) : null
  const sector = body.sector?.trim() || null
  const username = body.username?.trim()
  const userEmail = body.email?.trim().toLowerCase() || null

  if (!userEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
    return { error: 'براہ کرم ایک درست ای میل ایڈریس درج کریں۔ A valid email address is required.' }
  }
  if (!fullName || !mobile || !password || !whatsapp || !fatherName || !username) {
    return { error: "Name, father's/husband's name, mobile, WhatsApp number, username, and password are required." }
  }
  if (!/^[a-zA-Z0-9_]{6,30}$/.test(username)) {
    return { error: 'Username must be 6-30 characters: letters, numbers, and underscores only.' }
  }
  if (donorType === 'overseas' && !country) {
    return { error: 'Please enter your country.' }
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' }
  }
  if (fullName.length > 200 || mobile.length > 30) {
    return { error: 'Invalid input.' }
  }

  return { ok: true, data: { fullName, nameUr, fatherName, mobile, whatsapp, password, donorType, country, sector, username, userEmail } }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = SupabaseClient<any, any, any>

export interface DuplicateCandidate { id: string; full_name: string; mobile: string; whatsapp_number: string | null; father_husband_name: string | null; auth_user_id: string | null }

// DB-backed checks — username uniqueness and the same duplicate/claiming
// logic the original single-step signup route always had (see its own
// long-standing comment on why an exact-mobile match on an unclaimed
// placeholder row claims it instead of blocking). Re-run at confirm time
// too, not just request time — state can change in the few minutes
// someone takes to read an email and type a code back in.
export async function checkSignupDuplicates(admin: AdminClient, data: NormalizedSignup): Promise<{ error: string; status: number } | { ok: true; claiming: DuplicateCandidate | null }> {
  const { data: usernameTaken } = await admin.from('portal_users').select('id').ilike('username', data.username).maybeSingle()
  if (usernameTaken) {
    return { error: 'That username is already taken.', status: 409 }
  }

  const { data: candidates } = await admin.from('portal_users').select('id, full_name, mobile, whatsapp_number, father_husband_name, auth_user_id')
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  const dup = ((candidates ?? []) as DuplicateCandidate[]).find((c) =>
    norm(c.mobile) === norm(data.mobile) ||
    norm(c.whatsapp_number) === norm(data.whatsapp) ||
    (norm(c.full_name) === norm(data.fullName) && norm(c.father_husband_name) === norm(data.fatherName))
  )
  const claiming = dup && dup.auth_user_id === null && norm(dup.mobile) === norm(data.mobile) ? dup : null
  if (dup && !claiming) {
    return { error: 'An account with this mobile/WhatsApp number or name already exists. Try logging in instead.', status: 409 }
  }
  return { ok: true, claiming }
}

// The actual account creation — moved out of the original single-step
// route unchanged, just parameterized. Only ever called after a code has
// been verified (see /api/portal/signup/confirm-code).
export async function createSignupAccount(admin: AdminClient, data: NormalizedSignup, claiming: DuplicateCandidate | null) {
  const email = syntheticEmail(claiming ? claiming.mobile : data.mobile)
  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email, password: data.password, email_confirm: true,
  })
  if (authErr || !authUser.user) {
    return { error: authErr?.message ?? 'Could not create account.', status: 400 } as const
  }

  const { data: matchedConsumer } = await admin.from('consumers')
    .select('consumer_id')
    .or(`mobile.eq.${data.mobile},whatsapp_number.eq.${data.mobile},mobile.eq.${data.whatsapp},whatsapp_number.eq.${data.whatsapp}`)
    .limit(1)
    .maybeSingle()

  let matchedDonorAccountId: string | null = null
  for (const candidate of [data.mobile, data.whatsapp]) {
    const { data: match } = await admin.rpc('match_donor_account_by_phone', { p_phone: candidate })
      .maybeSingle<{ account_id: string; already_claimed: boolean }>()
    if (match?.account_id && !match.already_claimed) { matchedDonorAccountId = match.account_id; break }
  }

  const { error: writeErr } = claiming
    ? await admin.from('portal_users').update({
        auth_user_id: authUser.user.id, username: data.username, email: data.userEmail, name_ur: data.nameUr,
        whatsapp_number: data.whatsapp, donor_type: data.donorType, country: data.country, sector: data.sector,
        consumer_id: matchedConsumer?.consumer_id ?? null,
        donor_account_id: matchedDonorAccountId,
        email_verified_at: new Date().toISOString(),
      }).eq('id', claiming.id)
    : await admin.from('portal_users').insert({
        auth_user_id: authUser.user.id, full_name: data.fullName, name_ur: data.nameUr,
        mobile: data.mobile, whatsapp_number: data.whatsapp, father_husband_name: data.fatherName,
        donor_type: data.donorType, country: data.country, sector: data.sector, username: data.username, email: data.userEmail,
        consumer_id: matchedConsumer?.consumer_id ?? null,
        donor_account_id: matchedDonorAccountId,
        email_verified_at: new Date().toISOString(),
      })

  if (writeErr) {
    await admin.auth.admin.deleteUser(authUser.user.id)
    return { error: writeErr.message, status: 400 } as const
  }

  return { ok: true, email, password: data.password } as const
}
