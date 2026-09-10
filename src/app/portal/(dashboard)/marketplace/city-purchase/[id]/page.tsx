'use client'

// Live status for one City Purchase request. Same shared-screen shape as
// dispatch/[callId] (villager and driver both land here, each sees the
// actions their role allows), with two real additions dispatch doesn't
// have: a driver-entered add-on fee at accept time, and a genuine two-
// sided close (driver marks delivered, the villager separately confirms
// received — dispatch lets the driver alone mark completion).

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, MapPin, Phone, Clock, CheckCircle2, XCircle, Truck, PackageCheck, Paperclip, ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarketplaceBottomNav } from '@/components/portal/MarketplaceBottomNav'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface RequestDetail {
  id: string; item: string; has_item_attachment: boolean; pickup_label: string | null
  pickup_lat: number | null; pickup_lng: number | null; goods_budget_pkr: number; status: string
  distance_fare_pkr: number | null; addon_fee_pkr: number | null; total_fare_pkr: number | null
  actual_goods_cost_pkr: number | null; has_bill_attachment: boolean
  city_name: string; city_name_ur: string | null; city_km: number
  accepted_vehicle_id: string | null; accepted_owner_name: string | null; accepted_owner_mobile: string | null; accepted_vehicle_type: string | null
  created_at: string
}
interface Invitation { vehicle_id: string; owner_name: string; source: string; reference_destination: string | null; status: string; invited_at: string; responded_at: string | null }
interface MyVehicleLite { id: string; owner_name: string }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function CityPurchaseDetailPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const params = useParams()
  const requestId = params.id as string
  const supabase = createClient()

  const [request, setRequest] = useState<RequestDetail | null>(null)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [myVehicle, setMyVehicle] = useState<MyVehicleLite | null>(null)
  const [busy, setBusy] = useState(false)
  const [addonInput, setAddonInput] = useState('')
  const [purchaseCostInput, setPurchaseCostInput] = useState('')
  const [billPath, setBillPath] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => setMyVehicle(data))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async () => {
    const { data, error } = await supabase.rpc('city_purchase_request_detail', { p_request_id: requestId })
    if (error) { setLoading(false); return }
    setRequest(data.request); setInvitations(data.invitations)
    setLoading(false)
  }
  useEffect(() => { if (user) reload() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user || !request) return
    if (request.status !== 'ringing') return
    const iv = setInterval(reload, 5000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, request?.status])

  const myInvitation = invitations.find((i) => myVehicle && i.vehicle_id === myVehicle.id)
  const canRespond = myInvitation?.status === 'ringing'
  const isAcceptedDriver = !!(myVehicle && request?.accepted_vehicle_id === myVehicle.id)

  const decline = async () => {
    if (!myVehicle) return
    setBusy(true)
    const { error } = await supabase.rpc('decline_city_purchase_invitation', { p_request_id: requestId, p_vehicle_id: myVehicle.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reload()
  }
  const accept = async () => {
    if (!myVehicle) return
    const addon = Number(addonInput)
    if (!addon || addon <= 0) { toast.error(t('vp.enterServiceFeeError')); return }
    setBusy(true)
    const { error } = await supabase.rpc('accept_city_purchase_request', { p_request_id: requestId, p_vehicle_id: myVehicle.id, p_addon_fee_pkr: addon })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.deliveryAcceptedToast'))
    reload()
  }
  const approve = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('approve_city_purchase_price', { p_request_id: requestId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.priceApprovedToast'))
    reload()
  }
  const markPurchased = async () => {
    const cost = Number(purchaseCostInput)
    if (!purchaseCostInput || cost < 0) { toast.error(t('vp.enterActualCostError')); return }
    setBusy(true)
    const { error } = await supabase.rpc('mark_city_purchase_purchased', { p_request_id: requestId, p_actual_goods_cost_pkr: cost, p_bill_attachment_path: billPath })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.markedPurchasedToast'))
    reload()
  }
  const markDelivered = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('mark_city_purchase_delivered', { p_request_id: requestId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.markDeliveredToast'))
    reload()
  }
  const confirmReceived = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('confirm_city_purchase_received', { p_request_id: requestId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.confirmedReceivedToast'))
    reload()
  }
  const cancel = async () => {
    if (!window.confirm(t('vp.cancelCityPurchaseConfirm'))) return
    setBusy(true)
    const { error } = await supabase.rpc('cancel_city_purchase_request', { p_request_id: requestId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reload()
  }
  const viewAttachment = async (which: 'item' | 'bill') => {
    const { data: path, error } = await supabase.rpc('city_purchase_attachment_path', { p_request_id: requestId, p_which: which })
    if (error || !path) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const { data: signed } = await supabase.storage.from('city_purchase_attachments').createSignedUrl(path, 300)
    if (signed?.signedUrl) window.open(signed.signedUrl, '_blank')
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!request) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('vp.callNotFound')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16 max-w-lg mx-auto">
      <button onClick={() => router.push('/portal/marketplace/city-purchase')} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:text-dp-secondary mb-3 cursor-pointer">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.backToCityPurchase')}
      </button>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-4">
        <p className="font-sans text-[14px] font-bold text-dp-on-surface flex items-center gap-1.5"><ShoppingBag size={14} className="text-dp-secondary" /> {isUrdu && request.city_name_ur ? request.city_name_ur : request.city_name}</p>
        <p className="font-sans text-[13px] text-dp-on-surface mt-1.5">{request.item}</p>
        {request.pickup_label && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><MapPin size={11} /> {request.pickup_label}</p>}
        {request.has_item_attachment && (
          <button onClick={() => viewAttachment('item')} className="mt-2 inline-flex items-center gap-1 font-sans text-[12px] text-dp-secondary hover:underline cursor-pointer"><Paperclip size={11} /> {t('vp.viewAttachmentBtn')}</button>
        )}
      </div>

      {request.status === 'ringing' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 mb-4">
          <p className="font-sans text-[13px] font-bold text-amber-800 flex items-center gap-1.5"><Clock size={13} className="animate-pulse" /> {t('vp.ringingCityPurchaseLabel')}</p>
          <div className="mt-2 space-y-1">
            {invitations.map((i) => (
              <div key={i.vehicle_id} className="flex items-center justify-between font-sans text-[12px]">
                <span className="text-dp-on-surface">{i.owner_name}{i.reference_destination ? ` — ${i.reference_destination}` : ''}</span>
                <span className={i.status === 'ringing' ? 'text-amber-700 font-semibold' : i.status === 'declined' ? 'text-dp-error' : 'text-dp-on-surface-variant'}>{t(`vp.inviteStatus.${i.status}`)}</span>
              </div>
            ))}
            {invitations.length === 0 && <p className="text-dp-on-surface-variant font-sans text-[12px]">{t('vp.noOneInvitedYetNote')}</p>}
          </div>
          {canRespond && (
            <div className="mt-3 pt-3 border-t border-amber-200 space-y-2">
              <input type="number" value={addonInput} onChange={(e) => setAddonInput(e.target.value)} placeholder={t('vp.yourServiceFeePlaceholder')} className="input-field !bg-white" />
              <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('vp.serviceFeeBandHint')}</p>
              <div className="flex items-center gap-1.5">
                <button onClick={decline} disabled={busy} className="px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('vp.declineDeliveryBtn')}</button>
                <button onClick={accept} disabled={busy} className="px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('vp.acceptDeliveryBtn')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {request.status === 'no_answer' && (
        <div className="bg-dp-surface-container border border-dp-outline-variant rounded-lg p-3.5 mb-4 text-center">
          <XCircle size={18} className="text-dp-error mx-auto mb-1" />
          <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{t('vp.noAnswerNote')}</p>
        </div>
      )}

      {['priced', 'approved', 'purchased', 'delivered', 'completed'].includes(request.status) && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-4">
          <p className="font-sans text-[13px] font-bold text-dp-on-surface flex items-center gap-1.5"><Truck size={13} className="text-dp-secondary" /> {request.accepted_owner_name} · {request.accepted_vehicle_type}</p>
          {request.accepted_owner_mobile && <a href={`tel:${request.accepted_owner_mobile}`} className="inline-flex items-center gap-1 font-sans text-[12px] text-dp-secondary mt-1 hover:underline"><Phone size={11} /> {request.accepted_owner_mobile}</a>}

          <div className="mt-2.5 pt-2.5 border-t border-dp-outline-variant/60 space-y-1 font-sans text-[12.5px]">
            <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.distanceFareLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(request.distance_fare_pkr ?? 0)}</span></div>
            <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.driverServiceFeeLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(request.addon_fee_pkr ?? 0)}</span></div>
            <div className="flex justify-between font-bold text-[14px] pt-1 border-t border-dp-outline-variant/60"><span className="text-dp-on-surface">{t('vp.totalLabel')}</span><span className="ltr-num text-dp-secondary">{fmt(request.total_fare_pkr ?? 0)}</span></div>
            {request.goods_budget_pkr > 0 && <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.goodsBudgetEstimateLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(request.goods_budget_pkr)}</span></div>}
            {request.actual_goods_cost_pkr != null && <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.actualGoodsCostLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(request.actual_goods_cost_pkr)}</span></div>}
          </div>

          {request.has_bill_attachment && (
            <button onClick={() => viewAttachment('bill')} className="mt-2 inline-flex items-center gap-1 font-sans text-[12px] text-dp-secondary hover:underline cursor-pointer"><Paperclip size={11} /> {t('vp.viewBillBtn')}</button>
          )}

          {request.status === 'priced' && !isAcceptedDriver && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('vp.approveBeforeDepartNote')}</p>
              <button onClick={approve} disabled={busy} className="shrink-0 px-3.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('vp.approvePriceBtn')}</button>
            </div>
          )}
          {request.status === 'priced' && isAcceptedDriver && (
            <p className="mt-3 font-sans text-[12px] text-dp-secondary font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.waitingForApprovalNote')}</p>
          )}

          {request.status === 'approved' && isAcceptedDriver && (
            <div className="mt-3 pt-3 border-t border-dp-outline-variant/60 space-y-2">
              <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{t('vp.markPurchasedHeading')}</p>
              <input type="number" value={purchaseCostInput} onChange={(e) => setPurchaseCostInput(e.target.value)} placeholder={t('vp.actualGoodsCostPlaceholder')} className="input-field" />
              <DonationReceiptUpload bucket="city_purchase_attachments" label={t('vp.attachBillLabel')} onUpload={setBillPath} />
              <button onClick={markPurchased} disabled={busy} className="w-full flex items-center justify-center gap-1.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('vp.markPurchasedBtn')}</button>
            </div>
          )}
          {request.status === 'approved' && !isAcceptedDriver && (
            <p className="mt-3 font-sans text-[12px] text-dp-secondary font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.onTheWayNote')}</p>
          )}

          {request.status === 'purchased' && isAcceptedDriver && (
            <button onClick={markDelivered} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-emerald-700 disabled:opacity-50"><PackageCheck size={14} /> {t('vp.markDeliveredBtn')}</button>
          )}
          {request.status === 'purchased' && !isAcceptedDriver && (
            <p className="mt-3 font-sans text-[12px] text-dp-secondary font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.itemPurchasedNote')}</p>
          )}

          {request.status === 'delivered' && !isAcceptedDriver && (
            <button onClick={confirmReceived} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-emerald-700 disabled:opacity-50"><CheckCircle2 size={14} /> {t('vp.confirmReceivedBtn')}</button>
          )}
          {request.status === 'delivered' && isAcceptedDriver && (
            <p className="mt-3 font-sans text-[12px] text-dp-secondary font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.awaitingConfirmationNote')}</p>
          )}

          {request.status === 'completed' && (
            <p className="mt-3 font-sans text-[12.5px] text-emerald-700 font-bold flex items-center gap-1"><CheckCircle2 size={13} /> {t('vp.deliveredNote')}</p>
          )}
        </div>
      )}

      {!isAcceptedDriver && ['ringing', 'priced'].includes(request.status) && (
        <button onClick={cancel} disabled={busy} className="font-sans text-[12px] text-dp-on-surface-variant hover:text-dp-error cursor-pointer disabled:opacity-50">{t('vp.cancelCallBtn')}</button>
      )}
      <MarketplaceBottomNav />
    </div>
  )
}
