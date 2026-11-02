'use client'

// Live status for one City Purchase request. Same shared-screen shape as
// dispatch/[callId] (villager and driver both land here, each sees the
// actions their role allows), with two real additions dispatch doesn't
// have: a driver-entered add-on fee at accept time, and a genuine two-
// sided close (driver marks delivered, the villager separately confirms
// received — dispatch lets the driver alone mark completion).
//
// Phase 4: re-skinned to the new design + moved under marketplace/
// (mobility)/ — same RPCs throughout.

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, MapPin, Phone, Clock, CheckCircle2, XCircle, Truck, PackageCheck, Paperclip, ShoppingBag, Pencil } from 'lucide-react'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'
import { RateAndReport } from '@/components/portal/RateAndReport'
import { ReportProblemButton } from '@/components/shared/ReportProblemButton'

interface RequestDetail {
  id: string; item: string; has_item_attachment: boolean; pickup_label: string | null
  pickup_lat: number | null; pickup_lng: number | null; goods_budget_pkr: number; status: string
  distance_fare_pkr: number | null; addon_fee_pkr: number | null; detour_fuel_pkr: number | null; total_fare_pkr: number | null; tip_pkr: number
  actual_goods_cost_pkr: number | null; has_bill_attachment: boolean
  city_name: string; city_name_ur: string | null; city_km: number
  accepted_vehicle_id: string | null; accepted_owner_name: string | null; accepted_owner_mobile: string | null; accepted_vehicle_type: string | null
  initiator_portal_user_id: string
  created_at: string
  // 777
  urgency?: string; trip_mode?: 'carry_back' | 'dedicated' | null; urgency_premium_pkr?: number; detour_km?: number | null
  approved_at?: string | null; driver_confirmed_at?: string | null; deliver_by?: string | null
  trip_preference?: 'one_way' | 'two_way'; service_fee_floor_pkr?: number | null; area?: string
  scheduled_date?: string | null; scheduled_time?: string | null
}
interface PriceQuote {
  trip_mode: 'carry_back' | 'dedicated'; leg_pkr: number; distance_fare_pkr: number; urgency_premium_pkr: number; urgency_premium_pct: number
  detour_km: number | null; detour_free_km: number; on_route: boolean; detour_fuel_pkr: number; addon_fee_pkr: number; tip_pkr: number
  total_fare_pkr: number; deliver_within_hours: number | null; addon_min_pkr: number; addon_max_pkr: number; fee_floor_pkr?: number
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
  const [quote, setQuote] = useState<PriceQuote | null>(null)
  const [riderChecked, setRiderChecked] = useState(false)
  // Editing a request nobody has accepted yet (777's update_city_purchase_request).
  const [editing, setEditing] = useState(false)
  const [eItem, setEItem] = useState('')
  const [eBudget, setEBudget] = useState('')
  const [eUrgency, setEUrgency] = useState('standard')
  const [eTip, setETip] = useState('0')
  const [eDate, setEDate] = useState('')
  const [eTime, setETime] = useState('')
  const [ePref, setEPref] = useState<'one_way' | 'two_way'>('one_way')

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
  // The invited driver sees exactly what he'd be paid before accepting —
  // carry-back (one leg) or special trip (two legs), any urgency premium,
  // and whether the shop is on his way (777).
  useEffect(() => {
    if (!canRespond || !myVehicle) return
    let live = true
    const id = setTimeout(() => {
      supabase.rpc('city_purchase_quote_for_vehicle', { p_request_id: requestId, p_vehicle_id: myVehicle.id, p_addon_fee_pkr: addonInput ? Number(addonInput) : null })
        .then(({ data }) => {
          if (!live || !data) return
          const q = data as PriceQuote
          setQuote(q)
          // Start the driver at the committee's floor — he may ask more.
          setAddonInput((cur) => cur || String(q.fee_floor_pkr ?? q.addon_min_pkr))
        })
    }, 300)
    return () => { live = false; clearTimeout(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRespond, myVehicle?.id, addonInput, requestId])
  const isAcceptedDriver = !!(myVehicle && request?.accepted_vehicle_id === myVehicle.id)
  const isInitiator = !!(user && request?.initiator_portal_user_id === user.id)

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
  const openEdit = () => {
    if (!request) return
    setEItem(request.item); setEBudget(String(request.goods_budget_pkr ?? 0)); setEUrgency(request.urgency ?? 'standard')
    setETip(String(request.tip_pkr ?? 0)); setEDate(request.scheduled_date ?? new Date().toISOString().slice(0, 10))
    setETime((request.scheduled_time ?? '').slice(0, 5)); setEPref(request.trip_preference ?? 'one_way')
    setEditing(true)
  }
  const saveEdit = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('update_city_purchase_request', {
      p_request_id: requestId, p_item: eItem, p_goods_budget_pkr: Number(eBudget || 0), p_urgency: eUrgency, p_tip_pkr: Number(eTip || 0),
      p_scheduled_date: eDate, p_scheduled_time: eTime || null, p_trip_preference: ePref,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cpx.editedToast'))
    setEditing(false)
    reload()
  }

  const confirmDeal = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('confirm_city_purchase_deal', { p_request_id: requestId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('cpx.dealLockedToast'))
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
    // Real gap fixed, 2026-10-29: this RPC used to let a rider cancel
    // even after the driver had already purchased the goods (or even
    // after delivery, now blocked server-side entirely) with zero fee.
    // Mirrors cancel_trip_booking's warn-before-confirm + toast-the-
    // returned-fee pattern (770/771).
    const feeWarning = request?.status === 'purchased'
      ? t('vp.cancelFeeWarningPurchased').replace('{amount}', String(request.actual_goods_cost_pkr ?? request.goods_budget_pkr ?? 0))
      : ''
    if (!window.confirm(`${t('vp.cancelCityPurchaseConfirm')}${feeWarning ? '\n\n' + feeWarning : ''}`)) return
    setBusy(true)
    const { data, error } = await supabase.rpc('cancel_city_purchase_request', { p_request_id: requestId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const fee = (data as { fee_pkr?: number } | null)?.fee_pkr
    toast.success(fee ? t('vp.cancelFeeAppliesToast').replace('{amount}', String(fee)) : t('vp.cityPurchaseCancelledToast'))
    reload()
  }
  const viewAttachment = async (which: 'item' | 'bill') => {
    const { data: path, error } = await supabase.rpc('city_purchase_attachment_path', { p_request_id: requestId, p_which: which })
    if (error || !path) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    const { data: signed } = await supabase.storage.from('city_purchase_attachments').createSignedUrl(path, 300)
    if (signed?.signedUrl) window.open(signed.signedUrl, '_blank')
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!request) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('vp.callNotFound')}</div>

  return (
    <div className="flex flex-col gap-3">
      <button onClick={() => router.push('/portal/marketplace/city-purchase')} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#64748b] cursor-pointer w-fit">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.backToCityPurchase')}
      </button>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
        <p className="text-[14px] font-bold text-[#1e293b] flex items-center gap-1.5"><ShoppingBag size={14} className="text-[#166534]" /> {isUrdu && request.city_name_ur ? request.city_name_ur : request.city_name}</p>
        <p className="text-[13px] text-[#1e293b] mt-1.5">{request.item}</p>
        {request.pickup_label && <p className="text-[12px] text-[#64748b] mt-1 flex items-center gap-1"><MapPin size={11} /> {request.pickup_label}</p>}
        {request.has_item_attachment && (
          <button onClick={() => viewAttachment('item')} className="mt-2 inline-flex items-center gap-1 text-[12px] text-[#166534] cursor-pointer"><Paperclip size={11} /> {t('vp.viewAttachmentBtn')}</button>
        )}
      </div>

      {(request.status === 'ringing' || request.status === 'no_answer') && !canRespond && !isAcceptedDriver && (
        <div className="rounded-[24px] overflow-hidden text-white text-center px-5 py-6" style={{ backgroundImage: 'linear-gradient(160deg,#0f3d2e,#166534)' }}>
          <div className="relative w-24 h-24 mx-auto flex items-center justify-center">
            {request.status === 'ringing' && (
              <>
                <span className="absolute inset-0 rounded-full border-2 border-white/40 animate-ping [animation-duration:2.2s]" />
                <span className="absolute inset-3 rounded-full border-2 border-white/30 animate-ping [animation-duration:2.2s] [animation-delay:.7s]" />
              </>
            )}
            <div className="relative w-14 h-14 rounded-full bg-white text-[#166534] flex items-center justify-center shadow-lg"><ShoppingBag size={26} /></div>
          </div>
          <p className="font-sans text-[18px] font-extrabold mt-2">{request.status === 'ringing' ? t('cpx.searchingHeading') : t('cpx.savedHeading')}</p>
          <p className="font-sans text-[12.5px] text-white/85 mt-1">
            {(request.status === 'ringing' ? t('cpx.searchingHint') : t('cpx.savedHint')).replace('{city}', isUrdu && request.city_name_ur ? request.city_name_ur : request.city_name)}
          </p>
        </div>
      )}

      {isInitiator && (request.status === 'ringing' || request.status === 'no_answer') && (
        <div className="flex gap-2">
          <button onClick={openEdit} disabled={busy} className="flex-1 h-11 rounded-2xl bg-white border border-[#e5e2d0] text-[#0f172a] text-[13.5px] font-bold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"><Pencil size={14} /> {t('cpx.editBtn')}</button>
          <button onClick={cancel} disabled={busy} className="flex-1 h-11 rounded-2xl bg-[#fef2f2] text-[#b91c1c] text-[13.5px] font-bold cursor-pointer disabled:opacity-50">{t('vp.cancelCallBtn')}</button>
        </div>
      )}

      {request.status === 'ringing' && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3.5">
          <p className="text-[13px] font-bold text-amber-800 flex items-center gap-1.5"><Clock size={13} className="animate-pulse" /> {t('vp.ringingCityPurchaseLabel')}</p>
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
            <div className="mt-3 pt-3 border-t border-amber-200 flex flex-col gap-2">
              <input type="number" value={addonInput} onChange={(e) => setAddonInput(e.target.value)} placeholder={t('vp.yourServiceFeePlaceholder')} className="dp2-input text-[13.5px] bg-white" />
              <p className="text-[11px] text-[#64748b]">{quote ? t('cpx.driverFeeHint').replace('{min}', fmt(quote.fee_floor_pkr ?? quote.addon_min_pkr)) : t('vp.serviceFeeBandHint')}</p>
              {quote && (
                <div className="rounded-xl bg-white border border-amber-200 p-3 flex flex-col gap-1 text-[12px]">
                  <p className="font-bold text-[12.5px] text-[#1e293b]">{quote.trip_mode === 'carry_back' ? `🚗↩ ${t('cpx.carryTitle')}` : `🚗⇄ ${t('cpx.dedicatedTitle')}`}</p>
                  <p className="text-[11px] text-[#64748b] mb-1">{t(quote.trip_mode === 'carry_back' ? 'cpx.driverCarryHint' : 'cpx.driverDedicatedHint').replace('{h}', String(quote.deliver_within_hours))}</p>
                  <div className="flex justify-between"><span className="text-[#64748b]">{quote.trip_mode === 'carry_back' ? t('cpx.oneLeg') : t('cpx.twoLegs')}</span><span className="ltr-num">{fmt(quote.distance_fare_pkr)}</span></div>
                  {quote.urgency_premium_pkr > 0 && <div className="flex justify-between text-[#b45309] font-semibold"><span>{t('cpx.urgencyPremium')} ({quote.urgency_premium_pct}%)</span><span className="ltr-num">{fmt(quote.urgency_premium_pkr)}</span></div>}
                  <div className="flex justify-between"><span className="text-[#64748b]">{quote.on_route ? t('cpx.onRoute') : t('cpx.detourLine').replace('{km}', String(quote.detour_km ?? 0))}</span><span className="ltr-num">{fmt(quote.detour_fuel_pkr)}</span></div>
                  <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.driverServiceFeeLabel')}</span><span className="ltr-num">{fmt(quote.addon_fee_pkr)}</span></div>
                  {quote.tip_pkr > 0 && <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.additionalTipLabel')}</span><span className="ltr-num">{fmt(quote.tip_pkr)}</span></div>}
                  <div className="flex justify-between font-extrabold text-[13.5px] pt-1 border-t border-[#f1f5f9]"><span>{t('cpx.youEarn')}</span><span className="ltr-num text-[#166534]">₨{fmt(quote.total_fare_pkr)}</span></div>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <button onClick={decline} disabled={busy} className="px-3 py-1.5 rounded-xl text-[12.5px] font-semibold cursor-pointer border border-[#e5e2d0] text-[#64748b] disabled:opacity-50">{t('vp.declineDeliveryBtn')}</button>
                <button onClick={accept} disabled={busy} className="px-3 py-1.5 rounded-xl text-[12.5px] font-semibold cursor-pointer bg-[#166534] text-white disabled:opacity-50">{t('vp.acceptDeliveryBtn')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {request.status === 'no_answer' && isAcceptedDriver && (
        <div className="bg-[#F9F9F6] border border-[#e5e2d0] rounded-2xl p-3.5 text-center">
          <XCircle size={18} className="text-red-600 mx-auto mb-1" />
          <p className="text-[13px] font-semibold text-[#1e293b]">{t('vp.noAnswerNote')}</p>
        </div>
      )}

      {['priced', 'approved', 'purchased', 'delivered', 'completed'].includes(request.status) && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
          <p className="text-[13px] font-bold text-[#1e293b] flex items-center gap-1.5"><Truck size={13} className="text-[#166534]" /> {request.accepted_owner_name} · {request.accepted_vehicle_type}</p>
          {request.accepted_owner_mobile && <a href={`tel:${request.accepted_owner_mobile}`} className="inline-flex items-center gap-1 text-[12px] text-[#166534] mt-1"><Phone size={11} /> {request.accepted_owner_mobile}</a>}

          {request.trip_mode && (
            <span className={`inline-block mt-2 text-[11px] font-bold px-2 py-0.5 rounded-full ${request.trip_mode === 'carry_back' ? 'bg-[#dcfce7] text-[#166534]' : 'bg-[#e0e7ff] text-[#3730a3]'}`}>
              {request.trip_mode === 'carry_back' ? `🚗↩ ${t('cpx.carryTitle')}` : `🚗⇄ ${t('cpx.dedicatedTitle')}`}
            </span>
          )}
          <div className="mt-2.5 pt-2.5 border-t border-[#f1f5f9] flex flex-col gap-1 text-[12.5px]">
            {!!request.urgency_premium_pkr && <div className="flex justify-between"><span className="text-[#b45309]">{t('cpx.urgencyPremium')}</span><span className="ltr-num text-[#b45309]">{fmt(request.urgency_premium_pkr)}</span></div>}
            <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.distanceFareLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(request.distance_fare_pkr ?? 0)}</span></div>
            <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.driverServiceFeeLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(request.addon_fee_pkr ?? 0)}</span></div>
            {!!request.detour_fuel_pkr && (
              <div className="flex justify-between"><span className="text-[#64748b]">{request.detour_km != null ? t('cpx.detourLine').replace('{km}', String(request.detour_km)) : t('vp.detourFuelLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(request.detour_fuel_pkr)}</span></div>
            )}
            {!!request.tip_pkr && (
              <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.additionalTipLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(request.tip_pkr)}</span></div>
            )}
            <div className="flex justify-between font-bold text-[14px] pt-1 border-t border-[#f1f5f9]"><span className="text-[#1e293b]">{t('vp.totalLabel')}</span><span className="ltr-num text-[#166534]">{fmt(request.total_fare_pkr ?? 0)}</span></div>
            {request.goods_budget_pkr > 0 && <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.goodsBudgetEstimateLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(request.goods_budget_pkr)}</span></div>}
            {request.actual_goods_cost_pkr != null && <div className="flex justify-between"><span className="text-[#64748b]">{t('vp.actualGoodsCostLabel')}</span><span className="ltr-num text-[#1e293b]">{fmt(request.actual_goods_cost_pkr)}</span></div>}
          </div>

          {request.has_bill_attachment && (
            <button onClick={() => viewAttachment('bill')} className="mt-2 inline-flex items-center gap-1 text-[12px] text-[#166534] cursor-pointer"><Paperclip size={11} /> {t('vp.viewBillBtn')}</button>
          )}

          {request.status === 'priced' && !isAcceptedDriver && (
            <div className="mt-3 rounded-xl bg-[#fffbeb] border border-[#fde68a] p-3 flex flex-col gap-2">
              <p className="text-[12.5px] font-bold text-[#92400e]">{t('cpx.stage1Heading')}</p>
              <label className="flex items-start gap-2 text-[12px] text-[#78350f] cursor-pointer">
                <input type="checkbox" checked={riderChecked} onChange={(e) => setRiderChecked(e.target.checked)} className="mt-0.5 accent-[#166534]" />
                <span>{t('cpx.riderCheck').replace('{total}', fmt(request.total_fare_pkr ?? 0)).replace('{goods}', fmt(request.goods_budget_pkr))}</span>
              </label>
              <button onClick={approve} disabled={busy || !riderChecked} className="w-full py-2.5 bg-[#166534] text-white rounded-xl text-[13px] font-bold cursor-pointer disabled:opacity-50">{t('vp.approvePriceBtn')}</button>
            </div>
          )}
          {request.status === 'priced' && isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.waitingForApprovalNote')}</p>
          )}

          {request.status === 'approved' && isAcceptedDriver && !request.driver_confirmed_at && (
            <div className="mt-3 rounded-xl bg-[#eff6ff] border border-[#bfdbfe] p-3 flex flex-col gap-2">
              <p className="text-[12.5px] font-bold text-[#1e3a8a]">{t('cpx.stage2Heading')}</p>
              <p className="text-[12px] text-[#1e3a8a]">{t('cpx.driverCheck').replace('{total}', fmt(request.total_fare_pkr ?? 0))}</p>
              <div className="flex gap-2">
                <button onClick={confirmDeal} disabled={busy} className="flex-1 py-2.5 bg-[#1d4ed8] text-white rounded-xl text-[13px] font-bold cursor-pointer disabled:opacity-50">{t('cpx.lockDealBtn')}</button>
              </div>
            </div>
          )}
          {request.status === 'approved' && isAcceptedDriver && request.driver_confirmed_at && (
            <div className="mt-3 pt-3 border-t border-[#f1f5f9] flex flex-col gap-2">
              <p className="text-[12.5px] font-semibold text-[#1e293b]">{t('vp.markPurchasedHeading')}</p>
              <input type="number" value={purchaseCostInput} onChange={(e) => setPurchaseCostInput(e.target.value)} placeholder={t('vp.actualGoodsCostPlaceholder')} className="dp2-input text-[13.5px]" />
              <DonationReceiptUpload bucket="city_purchase_attachments" label={t('vp.attachBillLabel')} onUpload={setBillPath} />
              <button onClick={markPurchased} disabled={busy} className="w-full flex items-center justify-center gap-1.5 py-2 bg-[#166534] text-white rounded-xl text-[13px] font-semibold cursor-pointer disabled:opacity-50">{t('vp.markPurchasedBtn')}</button>
            </div>
          )}
          {request.status === 'approved' && !isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {request.driver_confirmed_at ? t('vp.onTheWayNote') : t('cpx.waitingDriverLock')}</p>
          )}
          {request.deliver_by && ['approved', 'purchased'].includes(request.status) && (
            <p className="mt-2 text-[12px] font-semibold flex items-center gap-1 text-[#92400e]">
              <Clock size={11} /> {t('cpx.deliverBy').replace('{time}', new Date(request.deliver_by).toLocaleTimeString(isUrdu ? 'ur-PK' : 'en-PK', { hour: 'numeric', minute: '2-digit' }))}
            </p>
          )}

          {request.status === 'purchased' && isAcceptedDriver && (
            <button onClick={markDelivered} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white rounded-xl text-[13px] font-semibold cursor-pointer disabled:opacity-50"><PackageCheck size={14} /> {t('vp.markDeliveredBtn')}</button>
          )}
          {request.status === 'purchased' && !isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.itemPurchasedNote')}</p>
          )}

          {request.status === 'delivered' && !isAcceptedDriver && (
            <button onClick={confirmReceived} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white rounded-xl text-[13px] font-semibold cursor-pointer disabled:opacity-50"><CheckCircle2 size={14} /> {t('vp.confirmReceivedBtn')}</button>
          )}
          {request.status === 'delivered' && isAcceptedDriver && (
            <p className="mt-3 text-[12px] text-[#166534] font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.awaitingConfirmationNote')}</p>
          )}
          {/* Real gap fixed, 2026-10-29: once delivered, "cancel" is
              blocked server-side — this is the real remedy the backend
              error message now points both sides to instead. */}
          {request.status === 'delivered' && (
            <div className="mt-3 flex justify-center">
              <ReportProblemButton refType="city_purchase_request" refId={requestId} kindOptions={['damaged_goods', 'fare_dispute']} />
            </div>
          )}

          {request.status === 'completed' && (
            <p className="mt-3 text-[12.5px] text-emerald-700 font-bold flex items-center gap-1"><CheckCircle2 size={13} /> {t('vp.deliveredNote')}</p>
          )}
        </div>
      )}

      {request.status === 'completed' && request.accepted_vehicle_id && (
        <RateAndReport
          refType="city_purchase_request" refId={requestId}
          againstPartyType={isAcceptedDriver ? 'portal_user' : 'vehicle'}
          againstPartyId={isAcceptedDriver ? request.initiator_portal_user_id : request.accepted_vehicle_id}
        />
      )}

      {/* Real gap fixed, 2026-10-29: used to only show up through
          'priced' — the two states where a real cancellation-fee tier
          now applies (approved: free, purchased: driver's sunk cost)
          never had a cancel entry point at all. 'delivered' stays out
          on purpose — cancelling is blocked server-side there, the
          ReportProblemButton above is the real path once goods have
          actually changed hands. */}
      {isInitiator && ['priced', 'approved', 'purchased'].includes(request.status) && (
        <button onClick={cancel} disabled={busy} className="text-[12px] text-[#64748b] cursor-pointer disabled:opacity-50 w-fit">{t('vp.cancelCallBtn')}</button>
      )}
      {editing && (
        <MobilityBottomSheet title={t('cpx.editTitle')} onClose={() => setEditing(false)}>
          <div className="flex flex-col gap-2.5">
            <textarea value={eItem} onChange={(e) => setEItem(e.target.value)} rows={3} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px] resize-none" />
            <input type="number" value={eBudget} onChange={(e) => setEBudget(e.target.value)} placeholder={t('vp.goodsBudgetPlaceholder')} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
            {request.area !== 'out_of_city' && (
              <div className="grid grid-cols-4 gap-1.5">
                {(['standard', '3hr', '2hr', 'urgent'] as const).map((u) => (
                  <button key={u} onClick={() => setEUrgency(u)} className="py-2 rounded-xl text-[12px] font-bold cursor-pointer border"
                    style={{ background: eUrgency === u ? '#166534' : '#fff', color: eUrgency === u ? '#fff' : '#334155', borderColor: eUrgency === u ? '#166534' : '#e5e2d0' }}>{t(`cpx.time.${u}`)}</button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              {(['one_way', 'two_way'] as const).map((pref) => (
                <button key={pref} onClick={() => setEPref(pref)} className="py-2 rounded-xl text-[12px] font-bold cursor-pointer border"
                  style={{ background: ePref === pref ? '#166534' : '#fff', color: ePref === pref ? '#fff' : '#334155', borderColor: ePref === pref ? '#166534' : '#e5e2d0' }}>
                  {pref === 'one_way' ? t('cpx.carryTitle') : t('cpx.dedicatedTitle')}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={eDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setEDate(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13px]" />
              <input type="time" value={eTime} onChange={(e) => setETime(e.target.value)} className="w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13px]" />
            </div>
            <label className="text-[12px] font-semibold text-[#64748b]">{t('vp.additionalTipLabel')}
              <input type="number" value={eTip} onChange={(e) => setETip(e.target.value)} className="mt-1 w-full border border-[#e5e2d0] rounded-xl p-2.5 text-[13.5px]" />
            </label>
            <p className="text-[11px] text-[#64748b]">{t('cpx.editHint')}</p>
            <button onClick={saveEdit} disabled={busy} className="w-full h-12 bg-[#166534] text-white rounded-2xl font-bold text-[14px] cursor-pointer disabled:opacity-50">{t('cpx.saveChanges')}</button>
          </div>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
