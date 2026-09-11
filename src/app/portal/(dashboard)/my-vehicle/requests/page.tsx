'use client'

// Incoming Requests — its own screen. The design zip only ever specified
// the older, dispatch-only broadcast concept here; this app has since
// built a second, newer system (City Purchase — a villager asks a
// driver already headed to a city to buy something and bring it back,
// the driver offers his own fee) that didn't exist when the zip was
// drawn. Per direct instruction: don't follow the zip blindly where the
// backend has moved past it — both request kinds are shown here,
// clearly labeled as separate sections, not just the old one.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Truck, ShoppingBag, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { TrustPill, type Trust } from '@/components/shared/TrustBadge'

interface DispatchInvite { call_id: string; item: string; address: string; goods_budget_pkr: number; tier: number; shop_name: string; city_name: string; customer_trust: Trust | null }
interface CityPurchaseInvite { request_id: string; item: string; goods_budget_pkr: number; pickup_label: string | null; source: string; reference_destination: string | null; city_name: string; city_name_ur: string | null }

export default function MyVehicleRequestsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const router = useRouter()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [vpSaving, setVpSaving] = useState(false)
  const [dispatchInvites, setDispatchInvites] = useState<DispatchInvite[]>([])
  const [cityPurchaseInvites, setCityPurchaseInvites] = useState<CityPurchaseInvite[]>([])

  const reload = async (id: string) => {
    const [{ data: invites }, { data: cpInvites }] = await Promise.all([
      supabase.rpc('my_dispatch_invitations', { p_vehicle_id: id }),
      supabase.rpc('my_city_purchase_invitations', { p_vehicle_id: id }),
    ])
    setDispatchInvites((invites ?? []) as DispatchInvite[])
    setCityPurchaseInvites((cpInvites ?? []) as CityPurchaseInvite[])
  }

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) { setVehicleId(data.id); await reload(data.id) }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!vehicleId) return
    const iv = setInterval(() => reload(vehicleId), 15000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId])

  const respondDispatchInvite = async (callId: string, action: 'accept' | 'decline') => {
    if (!vehicleId) return
    setVpSaving(true)
    const { error } = await supabase.rpc(action === 'accept' ? 'accept_dispatch_call' : 'decline_dispatch_call', { p_call_id: callId, p_vehicle_id: vehicleId })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    if (action === 'accept') router.push(`/portal/marketplace/dispatch/${callId}`)
    else reload(vehicleId)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicleId) return null

  const nothingIncoming = dispatchInvites.length === 0 && cityPurchaseInvites.length === 0

  return (
    <div>
      {nothingIncoming && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.noIncomingRequestsYet')}</p>}

      {dispatchInvites.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Truck size={13} /> {t('vp.incomingDeliveryCallsHeading')}</p>
          <div className="space-y-2">
            {dispatchInvites.map((c) => (
              <div key={c.call_id} className="bg-amber-50 border border-amber-200 rounded-lg p-3.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{c.item}</p>
                  <TrustPill trust={c.customer_trust} />
                </div>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{c.shop_name} · {c.city_name} · {t('vp.tierLabel')} {c.tier}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1"><MapPin size={11} /> {c.address}</p>
                <div className="flex items-center gap-1.5 mt-2">
                  <button onClick={() => respondDispatchInvite(c.call_id, 'decline')} disabled={vpSaving} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('vp.declineDeliveryBtn')}</button>
                  <button onClick={() => respondDispatchInvite(c.call_id, 'accept')} disabled={vpSaving} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('vp.acceptDeliveryBtn')}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {cityPurchaseInvites.length > 0 && (
        <div>
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><ShoppingBag size={13} /> {t('vp.incomingCityPurchaseHeading')}</p>
          <div className="space-y-2">
            {cityPurchaseInvites.map((r) => (
              <Link key={r.request_id} href={`/portal/marketplace/city-purchase/${r.request_id}`} className="block bg-amber-50 border border-amber-200 rounded-lg p-3.5 hover:border-amber-400 transition-colors">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{r.item}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{isUrdu && r.city_name_ur ? r.city_name_ur : r.city_name}{r.pickup_label ? ` · ${r.pickup_label}` : ''}</p>
                <p className="font-sans text-[12px] text-dp-secondary font-semibold mt-1">{t('vp.tapToRespondHint')}</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
