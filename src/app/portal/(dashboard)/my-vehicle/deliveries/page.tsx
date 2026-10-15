'use client'

// "How would a biker get the call?" — this page IS the call. Every
// shop_delivery_invitation still ringing for this vehicle (472), first
// accept wins, everyone else's invite closes automatically. No phone
// call, no SMS — a real in-app notification (the ring itself, fired by
// start_shop_delivery_ring) already pointed here.
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Jobs tab's delivery rows.

import { useEffect, useState } from 'react'
import { Truck, MapPin, Check, X, Loader2, RefreshCw } from 'lucide-react'
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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('cm.noVehicleLinked')}</div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><Truck size={19} /> {t('mv.deliveriesHeading')}</h1>
        <button onClick={() => loadInvitations(vehicle.id)} className="p-2 rounded-lg border border-[#e5e2d0] text-[#64748b] cursor-pointer">
          <RefreshCw size={15} />
        </button>
      </div>
      <p className="font-sans text-[12.5px] text-[#64748b] -mt-2">{t('mv.deliveriesSubtitle')}</p>

      {!vehicle.delivers && (
        <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-3.5">
          <p className="font-sans text-[13px] text-[#b91c1c]">{t('mv.deliversOffHint')}</p>
        </div>
      )}

      {invitations.length === 0 ? (
        <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('mv.noDeliveriesHint')}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {invitations.map((r) => (
            <div key={r.order_id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[14px] font-semibold text-[#1e293b] truncate">{isUrdu && r.shop_name_ur ? r.shop_name_ur : r.shop_name}</p>
                  <p className="font-sans text-[12px] text-[#64748b] mt-1 flex items-start gap-1"><MapPin size={12} className="shrink-0 mt-0.5" /> {r.delivery_address}</p>
                  {r.village_name && (
                    <p className="font-sans text-[11.5px] text-[#64748b] mt-0.5">{isUrdu && r.village_name_ur ? r.village_name_ur : r.village_name}</p>
                  )}
                </div>
                <p className="font-bold text-[18px] text-[#166534] shrink-0 ltr-num">{fmt(r.delivery_fee_pkr)}</p>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button onClick={() => decline(r.order_id)} disabled={busyOrderId === r.order_id}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 border border-[#e5e2d0] rounded-xl font-sans text-[13px] font-semibold text-[#64748b] cursor-pointer disabled:opacity-50">
                  <X size={14} /> {t('mv.declineBtn')}
                </button>
                <button onClick={() => accept(r.order_id)} disabled={busyOrderId === r.order_id}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-[#166534] text-white rounded-xl font-sans text-[13px] font-semibold cursor-pointer disabled:opacity-50">
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
