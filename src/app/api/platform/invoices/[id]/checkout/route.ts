import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getJazzCashConfig, jazzCashCheckoutUrl, buildCheckoutFields } from '@/lib/payments/jazzcash'

// Initiates a JazzCash Hosted Checkout redirect for one of the caller's
// own tenant's invoices (or any invoice, for a platform admin) — gated by
// the existing platform_invoices_own_read RLS policy (tenant_id =
// my_tenant_id() or is_platform_admin()), so the SELECT below already
// returns nothing for an invoice that doesn't belong to the caller.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: invoiceId } = await params
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const config = getJazzCashConfig()
  if (!config) {
    return NextResponse.json({
      error: 'Online payment is not configured yet for this platform. Contact the platform operator, or pay by bank transfer and ask them to mark this invoice paid manually.',
    }, { status: 503 })
  }

  const { data: invoice, error } = await supabase.from('platform_invoices')
    .select('id, invoice_number, total_amount_pkr, status')
    .eq('id', invoiceId)
    .maybeSingle()
  if (error || !invoice) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 })
  if (invoice.status !== 'pending' && invoice.status !== 'overdue') {
    return NextResponse.json({ error: 'This invoice is already settled.' }, { status: 409 })
  }

  const origin = req.nextUrl.origin
  const fields = buildCheckoutFields(config, {
    amountPkr: invoice.total_amount_pkr,
    txnRefNo: invoice.invoice_number,
    description: `Platform subscription — ${invoice.invoice_number}`,
    returnUrl: `${origin}/api/webhooks/jazzcash`,
  })

  return NextResponse.json({ actionUrl: jazzCashCheckoutUrl(config.mode), fields })
}
