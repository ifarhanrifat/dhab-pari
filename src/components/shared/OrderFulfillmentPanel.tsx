'use client'

// Delivery pipeline for one shop order — pending → accepted → preparing →
// out_for_delivery → delivered (or cancelled), independent of the
// separate payment-confirmation status (announced/confirmed/rejected)
// shown alongside it. Shared between admin/shops (staff) and
// portal/my-shop/reports (the shop's own keeper) — both call the exact
// same RPCs (accept_shop_order/advance_shop_order_fulfillment,
// migration 405), which authorize either caller server-side.

import { useState } from 'react'
import { MapPin, Phone, PackageCheck, ChefHat, Truck, CheckCircle2, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface FulfillableOrder {
  id: string
  fulfillment_status: string
  delivery_address: string | null
  buyer_mobile: string | null
}

const STEP_ICON: Record<string, React.ElementType> = {
  pending: PackageCheck, accepted: ChefHat, preparing: ChefHat, out_for_delivery: Truck, delivered: CheckCircle2,
}

export function OrderFulfillmentPanel({ order, onChanged }: { order: FulfillableOrder; onChanged: () => void }) {
  const { t } = useLocale()
  const supabase = createClient()
  const [busy, setBusy] = useState(false)

  if (order.fulfillment_status === 'cancelled') return null

  const nextStep: { status: string; label: string } | null =
    order.fulfillment_status === 'pending' ? { status: 'accepted', label: t('of.acceptBtn') }
    : order.fulfillment_status === 'accepted' ? { status: 'preparing', label: t('of.startPreparingBtn') }
    : order.fulfillment_status === 'preparing' ? { status: 'out_for_delivery', label: t('of.outForDeliveryBtn') }
    : order.fulfillment_status === 'out_for_delivery' ? { status: 'delivered', label: t('of.markDeliveredBtn') }
    : null

  const advance = async (status: string) => {
    setBusy(true)
    const { error } = status === 'accepted'
      ? await supabase.rpc('accept_shop_order', { p_order_id: order.id })
      : await supabase.rpc('advance_shop_order_fulfillment', { p_order_id: order.id, p_status: status })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('of.updatedToast'))
    onChanged()
  }

  const cancel = async () => {
    if (!confirm(t('of.confirmCancel'))) return
    setBusy(true)
    const { error } = await supabase.rpc('advance_shop_order_fulfillment', { p_order_id: order.id, p_status: 'cancelled' })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('of.cancelledToast'))
    onChanged()
  }

  const Icon = STEP_ICON[order.fulfillment_status] ?? PackageCheck

  return (
    <div className="mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
      {(order.delivery_address || order.buyer_mobile) && (
        <div className="mb-2 space-y-0.5">
          {order.delivery_address && <p className="font-sans text-[12px] text-dp-on-surface-variant flex items-start gap-1.5"><MapPin size={12} className="shrink-0 mt-0.5" /> {order.delivery_address}</p>}
          {order.buyer_mobile && <p className="font-sans text-[12px] text-dp-on-surface-variant flex items-center gap-1.5"><Phone size={12} className="shrink-0" /> <span className="ltr-num">{order.buyer_mobile}</span></p>}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full bg-dp-secondary-container/50 text-dp-secondary">
          <Icon size={12} /> {t(`of.status.${order.fulfillment_status}`)}
        </span>
        <div className="flex items-center gap-1.5">
          {order.fulfillment_status !== 'delivered' && (
            <button onClick={cancel} disabled={busy} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-error hover:bg-red-50 disabled:opacity-50 flex items-center gap-1">
              <XCircle size={12} /> {t('of.cancelBtn')}
            </button>
          )}
          {nextStep && (
            <button onClick={() => advance(nextStep.status)} disabled={busy} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">
              {nextStep.label}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
