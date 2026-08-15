import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

// Portal signup — creates a brand-new public identity (portal_users), fully
// separate from admin_users/staff login. Mobile-first (a synthetic email is
// used under the hood for Supabase Auth) since mobile/WhatsApp is the
// identifier this app's donors/consumers actually use, and this avoids any
// paid SMS-OTP provider — consistent with this app's existing avoidance of
// paid messaging APIs elsewhere (WhatsApp deep-links, not the Business API).
function syntheticEmail(mobile: string) {
  return `${mobile.replace(/[^0-9]/g, '')}@portal.dhabpari.local`
}

function donorKeyFor(name: string, phone: string | null) {
  const p = (phone ?? '').trim()
  return (p !== '' ? p : name.trim()).toLowerCase()
}

export async function POST(req: NextRequest) {
  let body: {
    full_name?: string; name_ur?: string; father_husband_name?: string
    mobile?: string; whatsapp_number?: string; password?: string
    donor_type?: string; country?: string; sector?: string
    username?: string; email?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

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
  const userEmail = body.email?.trim() || null

  if (!fullName || !mobile || !password || !whatsapp || !fatherName || !username) {
    return NextResponse.json({ error: "Name, father's/husband's name, mobile, WhatsApp number, username, and password are required." }, { status: 400 })
  }
  if (!/^[a-zA-Z0-9_]{6,30}$/.test(username)) {
    return NextResponse.json({ error: 'Username must be 6-30 characters: letters, numbers, and underscores only.' }, { status: 400 })
  }
  if (donorType === 'overseas' && !country) {
    return NextResponse.json({ error: 'Please enter your country.' }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }
  if (fullName.length > 200 || mobile.length > 30) {
    return NextResponse.json({ error: 'Invalid input.' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: usernameTaken } = await admin.from('portal_users').select('id').ilike('username', username).maybeSingle()
  if (usernameTaken) {
    return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 })
  }

  // Duplicate check against existing portal_users identities — mobile is
  // already unique-indexed (belt and suspenders here), but WhatsApp and the
  // name+father's-name combo aren't, so check those explicitly. Same
  // matching rules as check_donor_duplicate() (migration 115)/duplicateCheck.ts.
  const { data: candidates } = await admin.from('portal_users').select('id, full_name, mobile, whatsapp_number, father_husband_name, auth_user_id')
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  const dup = (candidates ?? []).find((c) =>
    norm(c.mobile) === norm(mobile) ||
    norm(c.whatsapp_number) === norm(whatsapp) ||
    (norm(c.full_name) === norm(fullName) && norm(c.father_husband_name) === norm(fatherName))
  )
  // An accountant can now create a portal_users row for a walk-in cash donor
  // straight from the admin side (auth_user_id left NULL — nobody has ever
  // logged into it) so a confirmed donation has a real account to land
  // against instead of floating free. That row is not "somebody else's
  // account" — it is this donor's own account, just not yet claimed. If the
  // match is by their exact mobile number (the one hard identity signal,
  // and the same one login resolves through), signup claims it instead of
  // being told to "log in" to credentials that were never issued. A softer
  // match (WhatsApp only, or name + father's name only) still blocks, since
  // claiming on a weaker signal risks handing a similarly-named stranger's
  // placeholder to the wrong person.
  const claiming = dup && dup.auth_user_id === null && norm(dup.mobile) === norm(mobile) ? dup : null
  if (dup && !claiming) {
    return NextResponse.json({ error: 'An account with this mobile/WhatsApp number or name already exists. Try logging in instead.' }, { status: 409 })
  }

  const email = syntheticEmail(claiming ? claiming.mobile : mobile)
  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (authErr || !authUser.user) {
    return NextResponse.json({ error: authErr?.message ?? 'Could not create account.' }, { status: 400 })
  }

  // Auto-link: match against existing water-supply consumers and donor
  // ledger accounts by phone/WhatsApp — per direction, automatic rather than
  // a staff-approved request.
  const { data: matchedConsumer } = await admin.from('consumers')
    .select('consumer_id')
    .or(`mobile.eq.${mobile},whatsapp_number.eq.${mobile},mobile.eq.${whatsapp},whatsapp_number.eq.${whatsapp}`)
    .limit(1)
    .maybeSingle()

  const donorKey = donorKeyFor(fullName, mobile)
  const { data: matchedDonorAccount } = await admin.from('accounts')
    .select('id')
    .eq('type', 'donor').eq('system', 'donors_projects').eq('donor_key', donorKey)
    .maybeSingle()

  // Claiming an accountant-created placeholder updates that same row rather
  // than inserting a second one — the whole point is one account per donor.
  // full_name/mobile stay whatever the accountant already recorded (that is
  // what any earlier confirmed cash gift is already attributed to); this
  // only fills in what a placeholder row never had.
  const { error: writeErr } = claiming
    ? await admin.from('portal_users').update({
        auth_user_id: authUser.user.id, username, email: userEmail, name_ur: nameUr,
        whatsapp_number: whatsapp, donor_type: donorType, country, sector,
        consumer_id: matchedConsumer?.consumer_id ?? null,
        donor_account_id: matchedDonorAccount?.id ?? null,
      }).eq('id', claiming.id)
    : await admin.from('portal_users').insert({
        auth_user_id: authUser.user.id, full_name: fullName, name_ur: nameUr,
        mobile, whatsapp_number: whatsapp, father_husband_name: fatherName,
        donor_type: donorType, country, sector, username, email: userEmail,
        consumer_id: matchedConsumer?.consumer_id ?? null,
        donor_account_id: matchedDonorAccount?.id ?? null,
      })
  if (writeErr) {
    await admin.auth.admin.deleteUser(authUser.user.id)
    return NextResponse.json({ error: writeErr.message }, { status: 400 })
  }

  // Sign them in immediately (cookie-bound client) so signup flows straight
  // into the portal without a separate login step.
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: (list) => list.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } }
  )
  await supabase.auth.signInWithPassword({ email, password })

  return NextResponse.json({ ok: true }, { status: 200 })
}
