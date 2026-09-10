'use client'

// "How would a biker get the call?" — this page IS the call. Every
// shop_delivery_invitation still ringing for this vehicle (472), first
// accept wins, everyone else's invite closes automatically. No phone
// call, no SMS — a real in-app notification (the ring itself, fired by
// start_shop_delivery_ring) already pointed here.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Truck, MapPin, ArrowLeft, Check, X, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Vehicle { id: string; owner_name: string; delivers: boolean }
interface Invitation {
  order_id: string; shop_name: string; shop_name_ur: string | null
  delivery_address: string; village_name: string | null; village_name_ur: string | null
  delivery_fee_pkr: number; invited_at: string
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyDeliveriesPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null)

  const loadInvitations = (vehicleId: string) =>
    supabase.rpc('my_shop_delivery_invitations', { p_vehicle_id: vehicleId }).then(({ data }) => setInvitations((data ?? []) as Invitation[]))

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, delivers').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setVehicle(data)
      if (data) await loadInvitations(data.id)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Someone else may accept a job this vehicle was also rung for, or a
  // ring may time out — 20s poll while this screen is open keeps the
  // list honest without needing a server push for something this
  // low-stakes.
  useEffect(() => {
    if (!vehicle) return
    const id = setInterval(() => loadInvitations(vehicle.id), 20000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle])

  const accept = async (orderId: string) => {
    if (!vehicle) return
    setBusyOrderId(orderId)
    const { error } = await supabase.rpc('accept_shop_delivery', { p_order_id: orderId, p_vehicle_id: vehicle.id })
    setBusyOrderId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.deliveryAcceptedToast'))
    loadInvitations(vehicle.id)
  }

  const decline = async (orderId: string) => {
    if (!vehicle) return
    setBusyOrderId(orderId)
    const { error } = await supabase.rpc('decline_shop_delivery', { p_order_id: orderId, p_vehicle_id: vehicle.id })
    setBusyOrderId(null)
    if (error) { toast.error(friendlyError(error)); return }
    setInvitations((rows) => rows.filter((r) => r.order_id !== orderId))
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('cm.noVehicleLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <Link href="/portal/my-vehicle" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {vehicle.owner_name}
      </Link>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h1 className="font-heading text-[24px] font-bold text-dp-primary flex items-center gap-2"><Truck size={22} /> {t('mv.deliveriesHeading')}</h1>
        <button onClick={() => loadInvitations(vehicle.id)} className="p-2 rounded-lg border border-dp-outline-variant text-dp-on-surface-variant cursor-pointer hover:bg-dp-surface-container-low">
          <RefreshCw size={15} />
        </button>
      </div>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('mv.deliveriesSubtitle')}</p>

      {!vehicle.delivers && (
        <div className="border-2 rounded-lg p-3.5 mb-4" style={{ borderColor: '#ec3013', background: '#fce3dc' }}>
          <p className="font-sans text-[13px]" style={{ color: '#ae1800' }}>{t('mv.deliversOffHint')}</p>
        </div>
      )}

      {invitations.length === 0 ? (
        <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('mv.noDeliveriesHint')}</p>
      ) : (
        <div className="space-y-2.5">
          {invitations.map((r) => (
            <div key={r.order_id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[14px] font-semibold text-dp-on-surface truncate">{isUrdu && r.shop_name_ur ? r.shop_name_ur : r.shop_name}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 flex items-start gap-1"><MapPin size={12} className="shrink-0 mt-0.5" /> {r.delivery_address}</p>
                  {r.village_name && (
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{isUrdu && r.village_name_ur ? r.village_name_ur : r.village_name}</p>
                  )}
                </div>
                <p className="font-heading text-[18px] font-bold text-dp-secondary shrink-0 ltr-num">{fmt(r.delivery_fee_pkr)}</p>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button onClick={() => decline(r.order_id)} disabled={busyOrderId === r.order_id}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface-variant cursor-pointer disabled:opacity-50">
                  <X size={14} /> {t('mv.declineBtn')}
                </button>
                <button onClick={() => accept(r.order_id)} disabled={busyOrderId === r.order_id}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50 hover:bg-dp-primary transition-all">
                  {busyOrderId === r.order_id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('mv.acceptBtn')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
