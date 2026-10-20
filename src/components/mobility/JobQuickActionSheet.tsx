'use client'

// Real ask, 2026-10-20: "the vehical system should work like real app
// style like a popup window like the request appear in the screen with
// same like other modern apps." The driver's Jobs tab was the one clear
// gap — every row navigated to a whole separate page just to accept or
// decline a single request, exactly the "incoming ride request" moment
// every real driver app (Uber/Careem/inDrive) shows as a popup over
// whatever screen you're already on. This is that popup: Accept/Decline
// call the exact same RPCs each vertical's own page already uses — no
// new backend, no change to those pages. Anything beyond accept/decline
// (starting a trip needs the PIN modal already built on that vertical's
// page, chat needs the full thread) still goes through "View full
// details" — a deliberate step deeper, not the only option any more.
//
// city_purchase is the one kind that can't be a plain accept/decline —
// the driver sets their own service fee within the committee's min/max
// band (same real distinction the self-invite fix earlier this session
// already respected) — so it gets one extra input, same recipe as the
// city-purchase detail page's own "ringing" block.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, X as XIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

export type QuickActionKind = 'hourly' | 'rental' | 'equipment' | 'shadi' | 'route' | 'dispatch' | 'city_purchase' | 'parcel' | 'delivery'
export interface QuickActionRow {
  id: string
  type: QuickActionKind
  title: string
  subtitle: string
  amount: number | null
  href: string
  needsAction: boolean
}
// dispatch/city_purchase/parcel/delivery all gate accept/decline on the
// caller owning the given vehicle_id — hourly/rental/equipment/shadi/
// route don't take one at all (ownership is derived from the booking's
// own vehicle_id server-side), so this is only threaded through where
// it's actually needed.
const NEEDS_VEHICLE_ID = new Set<QuickActionKind>(['dispatch', 'city_purchase', 'parcel', 'delivery'])

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

async function respond(kind: QuickActionKind, id: string, vehicleId: string | null, accept: boolean, feePkr?: number) {
  const supabase = createClient()
  switch (kind) {
    case 'hourly': return supabase.rpc('respond_hourly_booking', { p_booking_id: id, p_accept: accept })
    case 'rental': return supabase.rpc('respond_rental_booking', { p_booking_id: id, p_accept: accept })
    case 'equipment': return supabase.rpc('respond_equipment_booking', { p_booking_id: id, p_accept: accept })
    case 'shadi': return supabase.rpc('respond_shadi_request', { p_request_id: id, p_accept: accept })
    case 'route': return accept
      ? supabase.rpc('confirm_ride_booking', { p_booking_id: id })
      : supabase.rpc('reject_ride_booking', { p_booking_id: id })
    case 'dispatch': return accept
      ? supabase.rpc('accept_dispatch_call', { p_call_id: id, p_vehicle_id: vehicleId })
      : supabase.rpc('decline_dispatch_call', { p_call_id: id, p_vehicle_id: vehicleId })
    case 'parcel': return accept
      ? supabase.rpc('accept_parcel_delivery', { p_delivery_id: id, p_vehicle_id: vehicleId })
      : supabase.rpc('decline_parcel_delivery_invitation', { p_delivery_id: id, p_vehicle_id: vehicleId })
    case 'delivery': return accept
      ? supabase.rpc('accept_shop_delivery', { p_order_id: id, p_vehicle_id: vehicleId })
      : supabase.rpc('decline_shop_delivery', { p_order_id: id, p_vehicle_id: vehicleId })
    case 'city_purchase': return accept
      ? supabase.rpc('accept_city_purchase_request', { p_request_id: id, p_vehicle_id: vehicleId, p_addon_fee_pkr: feePkr })
      : supabase.rpc('decline_city_purchase_invitation', { p_request_id: id, p_vehicle_id: vehicleId })
  }
}

interface Props { row: QuickActionRow; vehicleId: string | null; onClose: () => void; onDone: () => void }

export function JobQuickActionSheet({ row, vehicleId, onClose, onDone }: Props) {
  const { t } = useLocale()
  const router = useRouter()
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [fee, setFee] = useState('')

  const act = async (accept: boolean) => {
    if (row.type === 'city_purchase' && accept && !fee.trim()) { toast.error(t('vp.yourServiceFeePlaceholder')); return }
    setBusy(accept ? 'accept' : 'decline')
    const { error } = await respond(row.type, row.id, NEEDS_VEHICLE_ID.has(row.type) ? vehicleId : null, accept, row.type === 'city_purchase' ? Number(fee) : undefined)
    setBusy(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(accept ? t('vp.jobAcceptedToast') : t('vp.jobDeclinedToast'))
    onDone()
    onClose()
    // Dispatch calls already had this redirect when accepted via the
    // requests page (live tracking lives there) — kept consistent
    // regardless of which entry point the driver accepted from.
    if (row.type === 'dispatch' && accept) router.push(`/portal/marketplace/dispatch/${row.id}`)
  }

  return (
    <MobilityBottomSheet title={row.title} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="bg-[#F9F9F6] rounded-xl p-3">
          <p className="font-sans text-[13.5px] font-semibold text-[#1e293b]">{row.subtitle}</p>
          {row.amount != null && <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num mt-1">₨{fmt(row.amount)}</p>}
        </div>

        {row.needsAction ? (
          <>
            {row.type === 'city_purchase' && (
              <div>
                <input type="number" value={fee} onChange={(e) => setFee(e.target.value)} placeholder={t('vp.yourServiceFeePlaceholder')} className="dp2-input" />
                <p className="font-sans text-[11px] text-[#64748b] mt-1">{t('vp.serviceFeeBandHint')}</p>
              </div>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => act(false)} disabled={busy !== null}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] text-[#b91c1c] font-sans text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">
                {busy === 'decline' ? <Loader2 size={15} className="animate-spin" /> : <XIcon size={15} />} {t('vp.declineBtn')}
              </button>
              <button onClick={() => act(true)} disabled={busy !== null}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">
                {busy === 'accept' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('vp.acceptBtn')}
              </button>
            </div>
          </>
        ) : (
          <p className="text-center font-sans text-[12.5px] text-[#64748b]">{t('vp.openFullDetailsHint')}</p>
        )}

        <Link href={row.href} onClick={onClose} className="text-center font-sans text-[12.5px] font-semibold text-[#64748b] underline">
          {t('vp.viewFullDetailsBtn')}
        </Link>
      </div>
    </MobilityBottomSheet>
  )
}
