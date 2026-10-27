'use client'

// One screen, two roles — the rider who sent a category-wise ride
// request (746) watches it go from "waiting for a driver" to
// "accepted" here; a driver who got the broadcast notification lands
// here from that notification's own link and sees an Accept button.
// First to call accept_ride_dispatch() wins (race-safe FOR UPDATE
// server-side) — everyone else just sees "someone else already
// accepted" if they're a beat too late.

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, CheckCircle2, XCircle, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface RequestDetail {
  id: string; status: string; pickup_label: string; dropoff_label: string
  distance_km: number; fare_pkr: number; created_at: string
  category_name: string; category_name_ur: string | null; category_emoji: string
  is_mine_as_rider: boolean; trip_offer_id: string | null
}

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function RideDispatchPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const params = useParams()
  const requestId = params.requestId as string
  const supabase = createClient()

  const [req, setReq] = useState<RequestDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [bookingId, setBookingId] = useState<string | null>(null)

  const reload = async () => {
    const { data } = await supabase.rpc('ride_dispatch_request_detail', { p_request_id: requestId })
    setReq((data as RequestDetail) ?? null)
    setLoading(false)
  }

  useEffect(() => { if (user) reload() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user || !req || req.status !== 'open') return
    const iv = setInterval(reload, 4000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, req?.status])

  useEffect(() => {
    if (!req?.is_mine_as_rider || req.status !== 'accepted' || !req.trip_offer_id) return
    supabase.from('vehicle_trip_bookings').select('id').eq('trip_offer_id', req.trip_offer_id).maybeSingle()
      .then(({ data }) => { if (data) setBookingId(data.id) })
  }, [req?.is_mine_as_rider, req?.status, req?.trip_offer_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async () => {
    setAccepting(true)
    const { error } = await supabase.rpc('accept_ride_dispatch', { p_request_id: requestId })
    setAccepting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); reload(); return }
    toast.success(t('mb.rideAcceptedToast'))
    router.push('/portal/my-vehicle/trips')
  }

  const cancel = async () => {
    if (!window.confirm(t('mb.confirmCancelRideRequest'))) return
    const { error } = await supabase.rpc('cancel_ride_dispatch_request', { p_request_id: requestId })
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reload()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!req) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('p.couldNotLoad')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex flex-col gap-3 max-w-lg mx-auto">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#64748b] cursor-pointer w-fit">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('action.back')}
      </button>

      <div className="bg-gradient-to-r from-[#005A36] to-[#166534] rounded-2xl p-4 text-white">
        <p className="text-[12px] font-bold text-white/75 uppercase tracking-[0.05em]">{req.category_emoji} {isUrdu && req.category_name_ur ? req.category_name_ur : req.category_name}</p>
        <div className="flex items-center gap-1.5 mt-1 text-[14px] font-bold">
          <MapPin size={14} className="shrink-0" /> {req.pickup_label} → {req.dropoff_label}
        </div>
        <p className="text-[12px] text-white/80 mt-1 ltr-num">{req.distance_km.toFixed(1)} km</p>
        <p className="font-extrabold text-[22px] mt-2 ltr-num">{fmt(req.fare_pkr)}</p>
      </div>

      {req.status === 'open' && req.is_mine_as_rider && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-5 text-center flex flex-col items-center gap-2">
          <Loader2 size={28} className="animate-spin text-[#166534]" />
          <p className="font-bold text-[14px] text-[#1e293b]">{t('mb.waitingForDriverHeading')}</p>
          <p className="text-[12.5px] text-[#64748b]">{t('mb.waitingForDriverHint')}</p>
          <button onClick={cancel} className="mt-2 text-[12.5px] font-semibold text-[#b91c1c] cursor-pointer">{t('mb.cancelRideRequestBtn')}</button>
        </div>
      )}

      {req.status === 'open' && !req.is_mine_as_rider && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 flex flex-col gap-3">
          <p className="text-[12.5px] text-[#64748b]">{t('mb.acceptRideHint')}</p>
          <button onClick={accept} disabled={accepting} className="w-full bg-[#166534] text-white rounded-xl py-3 font-bold text-[14px] cursor-pointer disabled:opacity-50">
            {accepting ? t('action.saving') : t('mb.acceptRideBtn').replace('{price}', fmt(req.fare_pkr))}
          </button>
        </div>
      )}

      {req.status === 'accepted' && (
        <div className="bg-[#F0FDF4] border border-[#bbf7d0] rounded-2xl p-4 flex flex-col items-center gap-2 text-center">
          <CheckCircle2 size={28} className="text-[#166534]" />
          <p className="font-bold text-[14px] text-[#166534]">{req.is_mine_as_rider ? t('mb.rideAcceptedHeading') : t('mb.youAcceptedThisRideHeading')}</p>
          {req.is_mine_as_rider && bookingId && (
            <Link href={`/portal/marketplace/trip/${bookingId}`} className="mt-1 px-4 py-2 bg-[#166534] text-white rounded-xl text-[13px] font-bold">
              {t('cm.trackLocationBtn')}
            </Link>
          )}
        </div>
      )}

      {(req.status === 'cancelled' || req.status === 'expired') && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 flex flex-col items-center gap-2 text-center">
          <XCircle size={24} className="text-[#94a3b8]" />
          <p className="text-[13px] text-[#64748b]">{req.status === 'cancelled' ? t('mb.rideRequestCancelledNote') : t('mb.rideRequestExpiredNote')}</p>
        </div>
      )}
    </div>
  )
}
