'use client'

// The real gap found while auditing the vehicle/delivery mockups: placing
// a delivery order previously only fired a toast, and the marketplace
// hub's own "My Orders" list showed just a one-word fulfillment_status —
// no delivery address, no assigned biker, no timeline. Everything this
// page needs (fulfillment_status, out_for_delivery_at, delivered_at,
// delivery_vehicle_id) already existed on shop_orders (405/472); this is
// purely a read-only view of state that was already being tracked,
// reached by tapping an order on the marketplace hub.

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, MapPin, Phone, PackageCheck, ChefHat, Truck, CheckCircle2, XCircle, Store as StoreIcon, Ban } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'

interface Order {
  id: string; status: string; total_amount_pkr: number; rejected_reason: string | null; created_at: string
  fulfillment_status: string; fulfillment_mode: string; delivery_address: string | null; delivery_fee_pkr: number | null
  accepted_at: string | null; out_for_delivery_at: string | null; delivered_at: string | null
  shops: { name: string; name_ur: string | null } | null
  vehicles: { owner_name: string; owner_mobile: string | null; vehicle_type: string; vehicle_number: string | null } | null
}

const STEPS = ['pending', 'accepted', 'preparing', 'out_for_delivery', 'delivered'] as const
const STEP_ICON = { pending: PackageCheck, accepted: ChefHat, preparing: ChefHat, out_for_delivery: Truck, delivered: CheckCircle2 } as const

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function OrderTrackingPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const params = useParams<{ orderId: string }>()
  const supabase = createClient()

  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () =>
    supabase.from('shop_orders')
      .select('id, status, total_amount_pkr, rejected_reason, created_at, fulfillment_status, fulfillment_mode, delivery_address, delivery_fee_pkr, accepted_at, out_for_delivery_at, delivered_at, shops(name, name_ur), vehicles!delivery_vehicle_id(owner_name, owner_mobile, vehicle_type, vehicle_number)')
      .eq('id', params.orderId).maybeSingle()
      .then(({ data }) => { setOrder(data as unknown as Order); setLoading(false) })

  useEffect(() => { if (user) load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // The shop (or a biker's acceptance) can move this along at any time —
  // poll while the order is still active so an open tab catches up
  // without needing a page refresh.
  useEffect(() => {
    if (!order || order.fulfillment_status === 'delivered' || order.fulfillment_status === 'cancelled') return
    const id = setInterval(load, 12000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.fulfillment_status])

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!order) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('ot.orderNotFound')}</div>

  const currentStepIndex = STEPS.indexOf(order.fulfillment_status as typeof STEPS[number])
  const isPickup = order.fulfillment_mode === 'pickup'
  const isCancelled = order.fulfillment_status === 'cancelled'
  const stepDates: Record<string, string | null> = { accepted: order.accepted_at, out_for_delivery: order.out_for_delivery_at, delivered: order.delivered_at }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto">
      <Link href="/portal/marketplace" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.pageTitle')}
      </Link>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
        <div className="flex items-start justify-between gap-3">
          <p className="font-heading text-[19px] font-bold text-dp-primary flex items-center gap-1.5"><StoreIcon size={16} /> {isUrdu && order.shops?.name_ur ? order.shops.name_ur : order.shops?.name ?? '—'}</p>
          <span className="font-heading text-[18px] font-bold text-dp-secondary shrink-0">{fmt(order.total_amount_pkr)}</span>
        </div>
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{new Date(order.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
        {order.status === 'rejected' && (
          <p className="flex items-center gap-1.5 font-sans text-[12.5px] mt-2 pt-2 border-t border-dp-outline-variant" style={{ color: '#b3261e' }}><XCircle size={13} /> {t('mp.rejectedStatus')}{order.rejected_reason ? ` — ${order.rejected_reason}` : ''}</p>
        )}
      </div>

      {isCancelled ? (
        <div className="rounded-lg p-4 mb-4 text-center border-2" style={{ borderColor: '#6b6560', background: '#f0eded' }}>
          <Ban size={18} style={{ color: '#6b6560' }} className="mx-auto mb-1.5" />
          <p className="font-sans text-[13px] font-semibold" style={{ color: '#6b6560' }}>{t('ot.orderCancelledHint')}</p>
        </div>
      ) : isPickup ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4 text-center">
          <StoreIcon size={20} className="text-dp-secondary mx-auto mb-1.5" />
          <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{t(order.fulfillment_status === 'delivered' ? 'ot.readyAndCollectedHint' : 'ot.readyForPickupHint')}</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
          <div className="space-y-3">
            {STEPS.map((step, i) => {
              const Icon = STEP_ICON[step]
              const done = i <= currentStepIndex
              const isCurrent = i === currentStepIndex
              return (
                <div key={step} className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${done ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>
                    <Icon size={13} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`font-sans text-[13px] ${isCurrent ? 'font-bold text-dp-secondary' : done ? 'font-semibold text-dp-on-surface' : 'text-dp-on-surface-variant'}`}>{t(`of.status.${step}`)}</p>
                  </div>
                  {stepDates[step] && <span className="font-sans text-[11px] text-dp-on-surface-variant shrink-0">{new Date(stepDates[step]!).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!isPickup && order.delivery_address && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant mb-1.5">{t('ot.deliveringToLabel')}</p>
          <p className="font-sans text-[13px] text-dp-on-surface flex items-start gap-1.5"><MapPin size={13} className="shrink-0 mt-0.5" /> {order.delivery_address}</p>
          {order.delivery_fee_pkr != null && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{t('ot.deliveryFeeLabel')}: <span className="font-semibold ltr-num">{fmt(order.delivery_fee_pkr)}</span></p>}
        </div>
      )}

      {order.vehicles && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant mb-1">{t('ot.deliveryPersonLabel')}</p>
            <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{order.vehicles.owner_name}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant">{order.vehicles.vehicle_type}{order.vehicles.vehicle_number ? ` · ${order.vehicles.vehicle_number}` : ''}</p>
          </div>
          {order.vehicles.owner_mobile && (
            <a href={`tel:${order.vehicles.owner_mobile}`} className="shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-dp-secondary-container/50 text-dp-secondary hover:bg-dp-secondary hover:text-white transition-colors">
              <Phone size={16} />
            </a>
          )}
        </div>
      )}

      {['out_for_delivery', 'delivered', 'cancelled'].includes(order.fulfillment_status) && (
        <div className="flex justify-center mt-4">
          <ReportProblemButton refType="shop_order" refId={order.id} kindOptions={['damaged_goods', 'no_show']} />
        </div>
      )}
    </div>
  )
}
