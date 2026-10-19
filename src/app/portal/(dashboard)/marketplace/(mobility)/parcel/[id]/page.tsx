'use client'

// Live status for one Parcel Delivery — same shared-screen shape as
// City Purchase's own detail page (villager and driver both land here,
// each sees the actions their role allows), minus the "purchase" step
// (nothing is being bought, so ringing→priced→approved→picked_up→
// delivered→completed instead of City Purchase's extra "purchased"
// stage) and minus the add-on fee (there's no goods-budget tip concept
// for carrying an existing item — the fare is the distance fare plus
// any detour-fuel surcharge, both backend-computed, no driver input).

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, MapPin, Phone, Clock, CheckCircle2, XCircle, Truck, PackageCheck, Package } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { RateAndReport } from '@/components/portal/RateAndReport'

interface DeliveryDetail {
  id: string; description: string; recipient_name: string | null; recipient_mobile: string | null
  pickup_label: string | null; pickup_lat: number | null; pickup_lng: number | null
  dropoff_label: string | null; dropoff_lat: number | null; dropoff_lng: number | null
  status: string
  distance_fare_pkr: number | null; detour_fuel_pkr: number | null; total_fare_pkr: number | null
  city_name: string; city_name_ur: string | null; city_km: number
  accepted_vehicle_id: string | null; accepted_owner_name: string | null; accepted_owner_mobile: string | null; accepted_vehicle_type: string | null
  initiator_portal_user_id: string
  created_at: string
}
interface Invitation { vehicle_id: string; owner_name: string; source: string; reference_destination: string | null; status: string; invited_at: string; responded_at: string | null }
interface MyVehicleLite { id: string; owner_name: string }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function ParcelDeliveryDetailPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const params = useParams()
  const deliveryId = params.id as string
  const supabase = createClient()

  const [delivery, setDelivery] = useState<DeliveryDetail | null>(null)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [myVehicle, setMyVehicle] = useState<MyVehicleLite | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => setMyVehicle(data))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async () => {
    const { data, error } = await supabase.rpc('parcel_delivery_detail', { p_delivery_id: deliveryId })
    if (error) { setLoading(false); return }
    setDelivery(data.delivery); setInvitations(data.invitations)
    setLoading(false)
  }
  useEffect(() => { if (user) reload() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user || !delivery) return
    if (delivery.status !== 'ringing') return
    const iv = setInterval(reload, 5000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, delivery?.status])

  const myInvitation = invitations.find((i) => myVehicle && i.vehicle_id === myVehicle.id)
  const canRespond = myInvitation?.status === 'ringing'
  const isAcceptedDriver = !!(myVehicle && delivery?.accepted_vehicle_id === myVehicle.id)

  const decline = async () => {
    if (!myVehicle) return
    setBusy(true)
    const { error } = await supabase.rpc('decline_parcel_delivery_invitation', { p_delivery_id: deliveryId, p_vehicle_id: myVehicle.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reload()
  }
  const accept = async () => {
    if (!myVehicle) return
    setBusy(true)
    const { error } = await supabase.rpc('accept_parcel_delivery', { p_delivery_id: deliveryId, p_vehicle_id: myVehicle.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.deliveryAcceptedToast'))
    reload()
  }
  const approve = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('approve_parcel_delivery_price', { p_delivery_id: deliveryId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.priceApprovedToast'))
    reload()
  }
  const markPickedUp = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('mark_parcel_picked_up', { p_delivery_id: deliveryId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.markedPickedUpToast'))
    reload()
  }
  const markDelivered = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('mark_parcel_delivered', { p_delivery_id: deliveryId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.markDeliveredToast'))
    reload()
  }
  const confirmReceived = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('confirm_parcel_delivery_received', { p_delivery_id: deliveryId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.confirmedReceivedToast'))
    reload()
  }
  const cancel = async () => {
    if (!window.confirm(t('vp.cancelParcelConfirm'))) return
    setBusy(true)
    const { error } = await supabase.rpc('cancel_parcel_delivery', { p_delivery_id: deliveryId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reload()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!delivery) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('vp.callNotFound')}</div>

  return (
    <div className="flex flex-col gap-3">
      <button onClick={() => router.push('/portal/marketplace/parcel')} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#64748b] cursor-pointer w-fit">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.backToParcel')}
      </button>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
        <p className="text-[14px] font-bold text-[#1e293b] flex items-center gap-1.5"><Package size={14} className="text-[#166534]" /> {isUrdu && delivery.city_name_ur ? delivery.city_name_ur : delivery.city_name}</p>
        <p className="text-[13px] text-[#1e293b] mt-1.5">{delivery.description}</p>
        {delivery.recipient_name && <p className="text-[12px] text-[#64748b] mt-1">{t('vp.recipientNamePlaceholder').replace(' (optional)', '')}: {delivery.recipient_name}{delivery.recipient_mobile ? ` · ${delivery.recipient_mobile}` : ''}</p>}
        {delivery.pickup_label && <p className="text-[12px] text-[#64748b] mt-1 flex items-center gap-1"><MapPin size={11} /> {delivery.pickup_label}</p>}
        {delivery.dropoff_label && <p className="text-[12px] text-[#64748b] mt-1 flex items-center gap-1"><MapPin size={11} /> {delivery.dropoff_label}</p>}
      </div>

      {delivery.status === 'ringing' && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3.5">
          <p className="text-[13px] font-bold text-amber-800 flex items-center gap-1.5"><Clock size={13} className="animate-pulse" /> {t('vp.ringingParcelLabel')}</p>
          <div className="mt-2 flex flex-col gap-1">
            {invitations.map((i) => (
              <div key={i.vehicle_id} className="flex items-center justify-between text-[12px]">
                <span className="text-[#1e293b]">{i.owner_name}{i.reference_destination ? ` — ${i.reference_destination}` : ''}</span>
                <span className={i.status === 'ringing' ? 'text-amber-700 font-semibold' : i.status === 'declined' ? 'text-red-600' : 'text-[#64748b]'}>{t(`vp.inviteStatus.${i.status}`)}</span>
              </div>
            ))}
            {invitations.length === 0 && <p className="text-[#64748b] text-[12px]">{t('vp.noOneInvitedYetNote')}</p>}
          </div>
          {canRespond && (
            <div className="mt-3 pt-3 border-t border-amber-200 flex items-center gap-1.5">
              <button onClick={decline} disabled={busy} className="px-3 py-1.5 rounded-xl text-[12.5px] font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b] disabled:opacity-50">{t('vp.declineDeliveryBtn')}</button>
              <button onClick={accept} disabled={busy} className="px-3 py-1.5 rounded-xl text-[12.5px] font-semibold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{t('vp.acceptDeliveryBtn')}</button>
            </div>
          )}
        </div>
      )}

      {delivery.status === 'no_answer' && (
        <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-2xl p-3.5 text-center">
          <XCircle size={18} className="text-red-600 mx-auto mb-1" />
          <p className="text-[13px] font-semibold text-[#1e293b]">{t('vp.noAnswerNote')}</p>
        </div>
      )}

      {['priced', 'approved', 'picked_up', 'delivered', 'completed'].includes(delivery.status) && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
          <p className="text-[13px] font-bold text-[#1e293b] flex items-center gap-1.5"><Truck size={13} className="text-[#166534]" /> {delivery.accepted_owner_name} · {delivery.accepted_vehicle_type}</p>
          {delivery.accepted_owner_mobile && <a href={`tel:${delivery.accepted_owner_mobile}`} className="inline-flex items-center gap-1 text-[12px] text-[#166534] mt-1"><Phone size={11} /> {delivery.accepted_owner_mobile}</a>}

          <div className="mt-2.5 pt-2.5 border-t border-[#f1f5f9] flex flex-col gap-1 text-[12.5px]">
            <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.distanceFareLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(delivery.distance_fare_pkr ?? 0)}</span></div>
            {!!delivery.detour_fuel_pkr && (
              <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.detourFuelLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(delivery.detour_fuel_pkr)}</span></div>
            )}
            <div className="flex justify-between font-bold text-[14px] pt-1 border-t border-[#f1f5f9]"><span className="text-[#1e293b]">{t('vp.totalLabel')}</span><span className="ltr-num text-[#166534]">{fmt(delivery.total_fare_pkr ?? 0)}</span></div>
          </div>

          {delivery.status === 'priced' && !isAcceptedDriver && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-[11.5px] text-[#64748b]">{t('vp.approveBeforeDepartNote')}</p>
              <button onClick={approve} disabled={busy} className="shrink-0 px-3.5 py-1.5 bg-[#166534] text-white rounded-xl text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">{t('vp.approvePriceBtn')}</button>
            </div>
          )}
          {delivery.status === 'priced' && isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.waitingForApprovalNote')}</p>
          )}

          {delivery.status === 'approved' && isAcceptedDriver && (
            <button onClick={markPickedUp} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-[#166534] text-white rounded-xl text-[13px] font-semibold cursor-pointer disabled:opacity-50"><PackageCheck size={14} /> {t('vp.markPickedUpBtn')}</button>
          )}
          {delivery.status === 'approved' && !isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.awaitingPickupNote')}</p>
          )}

          {delivery.status === 'picked_up' && isAcceptedDriver && (
            <button onClick={markDelivered} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white rounded-xl text-[13px] font-semibold cursor-pointer disabled:opacity-50"><PackageCheck size={14} /> {t('vp.markDeliveredBtn')}</button>
          )}
          {delivery.status === 'picked_up' && !isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.pickedUpNote')}</p>
          )}

          {delivery.status === 'delivered' && !isAcceptedDriver && (
            <button onClick={confirmReceived} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white rounded-xl text-[13px] font-semibold cursor-pointer disabled:opacity-50"><CheckCircle2 size={14} /> {t('vp.confirmReceivedBtn')}</button>
          )}
          {delivery.status === 'delivered' && isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.awaitingConfirmationNote')}</p>
          )}

          {delivery.status === 'completed' && (
            <p className="mt-3 text-[12.5px] text-emerald-700 font-bold flex items-center gap-1"><CheckCircle2 size={13} /> {t('vp.deliveredNote')}</p>
          )}
        </div>
      )}

      {delivery.status === 'completed' && delivery.accepted_vehicle_id && (
        <RateAndReport
          refType="parcel_delivery" refId={deliveryId}
          againstPartyType={isAcceptedDriver ? 'portal_user' : 'vehicle'}
          againstPartyId={isAcceptedDriver ? delivery.initiator_portal_user_id : delivery.accepted_vehicle_id}
        />
      )}

      {!isAcceptedDriver && ['ringing', 'priced'].includes(delivery.status) && (
        <button onClick={cancel} disabled={busy} className="text-[12px] text-[#64748b] cursor-pointer disabled:opacity-50 w-fit">{t('vp.cancelCallBtn')}</button>
      )}
    </div>
  )
}
