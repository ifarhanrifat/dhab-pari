import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getEasyPaisaConfig, verifyReturnedFields } from '@/lib/payments/easypaisa'

// EasyPaisa's own redirect back (postBackURL above) — mirrors
// /api/webhooks/jazzcash exactly (see that file's own comment for the
// full reasoning: no admin session exists here, so this writes directly
// via the service-role client, with the verified hash as the real
// authorization boundary). Idempotent — a replayed callback on an
// already-paid invoice is a silent no-op.
async function handleReturn(fields: Record<string, string>) {
  const config = getEasyPaisaConfig()
  const origin = `https://${process.env.NEXT_PUBLIC_DOMAIN?.trim() || 'dhabpari.com'}`
  const redirectTo = (status: 'success' | 'failed' | 'error') => NextResponse.redirect(`${origin}/admin/subscription?payment=${status}`)

  if (!config) return redirectTo('error')

  if (!verifyReturnedFields(fields, config.hashKey)) {
    console.error('easypaisa webhook: hash verification failed', fields.orderRefNum)
    return redirectTo('error')
  }

  const txnRefNo = fields.orderRefNum
  const responseCode = fields.responseCode ?? fields.status
  if (!txnRefNo) return redirectTo('error')

  const admin = createAdminClient()
  const { data: invoice } = await admin.from('platform_invoices')
    .select('id, status, tenant_id')
    .eq('invoice_number', txnRefNo)
    .maybeSingle()
  if (!invoice) {
    console.error('easypaisa webhook: no invoice for orderRefNum', txnRefNo)
    return redirectTo('error')
  }

  if (invoice.status === 'paid') return redirectTo('success')

  // '0000'/'00' is the commonly documented EasyPaisa success code family —
  // same caveat as jazzcash.ts: verify against live docs once real
  // credentials exist.
  if (responseCode !== '0000' && responseCode !== '00') {
    return redirectTo('failed')
  }

  await admin.from('platform_invoices').update({
    status: 'paid',
    paid_at: new Date().toISOString(),
    gateway_provider: 'easypaisa',
    gateway_reference: fields.transactionId || fields.orderRefNum,
  }).eq('id', invoice.id)

  await admin.from('platform_audit_log').insert({
    actor_platform_admin_id: null,
    actor_name: 'EasyPaisa (automated)',
    action: 'invoice_marked_paid',
    target_tenant_id: invoice.tenant_id,
    details: { invoice_id: invoice.id, gateway: 'easypaisa', reference: fields.transactionId || null },
  })

  return redirectTo('success')
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const fields: Record<string, string> = {}
  form.forEach((value, key) => { fields[key] = String(value) })
  return handleReturn(fields)
}

export async function GET(req: NextRequest) {
  const fields: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((value, key) => { fields[key] = value })
  return handleReturn(fields)
}
