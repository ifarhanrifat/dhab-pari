'use client'

// Live status for one dispatch call. Polls advance_dispatch_call (the
// client-driven "check elapsed time, advance if needed" sweep — there is
// no server timer, see migration 423) every few seconds while the call is
// still ringing, which both progresses tier1→tier2→no_answer on schedule
// AND refreshes the invitation log; once accepted, switches to reading
// dispatch_call_detail plainly (nothing left to advance). Same screen
// serves the requesting villager and any invited driver — each sees the
// actions their role allows.

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Store, MapPin, Phone, Clock, CheckCircle2, XCircle, Truck, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface CallDetail {
  id: string; item: string; address: string; goods_budget_pkr: number; status: string
  fare_outbound_pkr: number | null; fare_return_pkr: number | null; wait_fee_pkr: number | null
  purchase_fee_pkr: number | null; accepted_tier: number | null; total_pkr: number | null
  shop_name: string; shop_name_ur: string | null; shop_is_general: boolean; city_name: string; city_km: number
  accepted_vehicle_id: string | null; accepted_owner_name: string | null; accepted_owner_mobile: string | null; accepted_vehicle_type: string | null
}
interface Invitation { vehicle_id: string; owner_name: string; tier: number; status: string; invited_at: string; responded_at: string | null }
interface MyVehicleLite { id: string; owner_name: string }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function DispatchCallDetailPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const params = useParams()
  const callId = params.callId as string
  const supabase = createClient()

  const [call, setCall] = useState<CallDetail | null>(null)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [myVehicle, setMyVehicle] = useState<MyVehicleLite | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => setMyVehicle(data))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async (advancing: boolean) => {
    const rpcName = advancing ? 'advance_dispatch_call' : 'dispatch_call_detail'
    const { data, error } = await supabase.rpc(rpcName, { p_call_id: callId })
    if (error) { setLoading(false); return }
    setCall(data.call); setInvitations(data.invitations)
    setLoading(false)
  }

  useEffect(() => { if (user) reload(true) }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user || !call) return
    const stillRinging = call.status === 'tier1' || call.status === 'tier2'
    if (!stillRinging) return
    const iv = setInterval(() => reload(true), 4000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, call?.status])

  const myInvitation = invitations.find((i) => myVehicle && i.vehicle_id === myVehicle.id)
  const canRespond = myInvitation?.status === 'ringing'

  const respond = async (action: 'accept' | 'decline') => {
    if (!myVehicle) return
    setBusy(true)
    const { error } = await supabase.rpc(action === 'accept' ? 'accept_dispatch_call' : 'decline_dispatch_call', { p_call_id: callId, p_vehicle_id: myVehicle.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    if (action === 'accept') toast.success(t('vp.deliveryAcceptedToast'))
    reload(false)
  }
  const approve = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('approve_dispatch_price', { p_call_id: callId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.priceApprovedToast'))
    reload(false)
  }
  const complete = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('complete_dispatch_call', { p_call_id: callId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.deliveryCompletedToast'))
    reload(false)
  }
  const cancel = async () => {
    if (!window.confirm(t('vp.cancelDispatchConfirm'))) return
    setBusy(true)
    const { error } = await supabase.rpc('cancel_dispatch_call', { p_call_id: callId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reload(false)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!call) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('vp.callNotFound')}</div>

  const ringingTier1 = invitations.filter((i) => i.tier === 1)
  const ringingTier2 = invitations.filter((i) => i.tier === 2)

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto">
      <button onClick={() => router.push('/portal/marketplace/order-city')} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:text-dp-secondary mb-3 cursor-pointer">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('vp.backToDispatch')}
      </button>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-4">
        <p className="font-sans text-[14px] font-bold text-dp-on-surface flex items-center gap-1.5">
          <Store size={14} className="text-dp-secondary" /> {call.shop_is_general ? call.city_name : `${isUrdu && call.shop_name_ur ? call.shop_name_ur : call.shop_name} — ${call.city_name}`}
        </p>
        <p className="font-sans text-[13px] text-dp-on-surface mt-1.5">{call.item}</p>
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 flex items-center gap-1"><MapPin size={11} /> {call.address}</p>
      </div>

      {(call.status === 'tier1' || call.status === 'tier2') && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 mb-4">
          <p className="font-sans text-[13px] font-bold text-amber-800 flex items-center gap-1.5"><Clock size={13} className="animate-pulse" /> {t(call.status === 'tier1' ? 'vp.ringingTier1Label' : 'vp.ringingTier2Label')}</p>
          <div className="mt-2 space-y-1">
            {[...ringingTier1, ...ringingTier2].map((i) => (
              <div key={i.vehicle_id} className="flex items-center justify-between font-sans text-[12px]">
                <span className="text-dp-on-surface">{i.owner_name} <span className="text-dp-on-surface-variant">({t('vp.tierLabel')} {i.tier})</span></span>
                <span className={i.status === 'ringing' ? 'text-amber-700 font-semibold' : i.status === 'declined' ? 'text-dp-error' : 'text-dp-on-surface-variant'}>{t(`vp.inviteStatus.${i.status}`)}</span>
              </div>
            ))}
            {invitations.length === 0 && <p className="text-dp-on-surface-variant font-sans text-[12px]">{t('vp.noOneInvitedYetNote')}</p>}
          </div>
          {canRespond && (
            <div className="flex items-center gap-1.5 mt-2.5">
              <button onClick={() => respond('decline')} disabled={busy} className="px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('vp.declineDeliveryBtn')}</button>
              <button onClick={() => respond('accept')} disabled={busy} className="px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('vp.acceptDeliveryBtn')}</button>
            </div>
          )}
        </div>
      )}

      {call.status === 'no_answer' && (
        <div className="bg-dp-surface-container border border-dp-outline-variant rounded-lg p-3.5 mb-4 text-center">
          <XCircle size={18} className="text-dp-error mx-auto mb-1" />
          <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{t('vp.noAnswerNote')}</p>
        </div>
      )}

      {(call.status === 'priced' || call.status === 'approved' || call.status === 'completed') && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-4">
          <p className="font-sans text-[13px] font-bold text-dp-on-surface flex items-center gap-1.5"><Truck size={13} className="text-dp-secondary" /> {call.accepted_owner_name} · {call.accepted_vehicle_type}</p>
          {call.accepted_owner_mobile && <a href={`tel:${call.accepted_owner_mobile}`} className="inline-flex items-center gap-1 font-sans text-[12px] text-dp-secondary mt-1 hover:underline"><Phone size={11} /> {call.accepted_owner_mobile}</a>}
          {call.accepted_tier != null && (
            <span className={`inline-block mt-2 text-[10px] font-bold px-2 py-0.5 rounded-full ${call.accepted_tier === 1 ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800'}`}>
              {t(call.accepted_tier === 1 ? 'vp.tier1AcceptedBadge' : 'vp.tier2AcceptedBadge')}
            </span>
          )}
          <div className="mt-2.5 pt-2.5 border-t border-dp-outline-variant/60 space-y-1 font-sans text-[12.5px]">
            <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.goodsLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(call.goods_budget_pkr)}</span></div>
            {call.accepted_tier === 1 ? (
              <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.purchaseFeeLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(call.purchase_fee_pkr ?? 0)}</span></div>
            ) : (
              <>
                <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.outboundFareLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(call.fare_outbound_pkr ?? 0)}</span></div>
                <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.returnFareLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(call.fare_return_pkr ?? 0)}</span></div>
                <div className="flex justify-between"><span className="text-dp-on-surface-variant">{t('vp.waitFeeLabel')}</span><span className="ltr-num text-dp-on-surface">{fmt(call.wait_fee_pkr ?? 0)}</span></div>
              </>
            )}
            <div className="flex justify-between font-bold text-[14px] pt-1 border-t border-dp-outline-variant/60"><span className="text-dp-on-surface">{t('vp.totalLabel')}</span><span className="ltr-num text-dp-secondary">{fmt(call.total_pkr ?? 0)}</span></div>
          </div>

          {call.status === 'priced' && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('vp.approveBeforeDepartNote')}</p>
              <button onClick={approve} disabled={busy} className="shrink-0 px-3.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{t('vp.approvePriceBtn')}</button>
            </div>
          )}
          {call.status === 'approved' && myVehicle && myVehicle.id === call.accepted_vehicle_id && (
            <button onClick={complete} disabled={busy} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 bg-emerald-600 text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-emerald-700 disabled:opacity-50"><PackageCheck size={14} /> {t('vp.markDeliveredBtn')}</button>
          )}
          {call.status === 'approved' && (!myVehicle || myVehicle.id !== call.accepted_vehicle_id) && (
            <p className="mt-3 font-sans text-[12px] text-dp-secondary font-semibold flex items-center gap-1"><Clock size={11} /> {t('vp.onTheWayNote')}</p>
          )}
          {call.status === 'completed' && (
            <p className="mt-3 font-sans text-[12.5px] text-emerald-700 font-bold flex items-center gap-1"><CheckCircle2 size={13} /> {t('vp.deliveredNote')}</p>
          )}
        </div>
      )}

      {(call.status === 'tier1' || call.status === 'tier2' || call.status === 'priced') && (
        <button onClick={cancel} disabled={busy} className="font-sans text-[12px] text-dp-on-surface-variant hover:text-dp-error cursor-pointer disabled:opacity-50">{t('vp.cancelCallBtn')}</button>
      )}
    </div>
  )
}
