'use client'

// Admin "Overview & Fleet Map" (489) — the v2 design handoff's Admin-12
// item #1 (خلاصہ اور نقشہ), confirmed missing by checking the prototype
// directly: per-screen queues (wallet topups, shadi advance, disputes)
// already existed, but no single home screen tied today's activity,
// what needs action, and the fleet map together. Reuses the same
// admin_fleet_locations_guarded() and LeafletMap /admin/fleet-map
// already uses — this screen's map is not a separate implementation.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { LayoutDashboard, Briefcase, Car, AlertTriangle, Wallet, HandCoins, Scale } from 'lucide-react'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Overview {
  jobs_today: number; cash_today_pkr: number; vehicles_live: number
  wallets_negative_count: number; wallets_negative_total_pkr: number; advance_held_pkr: number
  needs_action: { pending_wallet_topups: number; pending_shadi_advance: number; open_disputes: number }
}
interface FleetPin {
  source: 'trip' | 'hourly'; ref_id: string; owner_name: string; owner_mobile: string | null
  vehicle_type: string; vehicle_number: string | null; context: string; lat: number; lng: number; updated_at: string
}

function fmt(n: number) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function AdminMarketplaceOverviewPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [overview, setOverview] = useState<Overview | null>(null)
  const [pins, setPins] = useState<FleetPin[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [{ data: o }, { data: p }] = await Promise.all([
      supabase.rpc('admin_marketplace_overview'),
      supabase.rpc('admin_fleet_locations_guarded'),
    ])
    setOverview(o as Overview)
    setPins((p ?? []) as FleetPin[])
    setLoading(false)
  }
  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (access.loading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('mo.noAccessMessage')}</p></div>
  }

  const mapPins: MapPin[] = pins.map((p) => ({
    lat: p.lat, lng: p.lng, emoji: p.source === 'hourly' ? '🚖' : '🚐',
    popupHtml: `<strong>${p.owner_name}</strong><br/>${p.vehicle_type}${p.vehicle_number ? ` · ${p.vehicle_number}` : ''}<br/>${p.context}`,
  }))

  const needsAction = [
    { count: overview?.needs_action.pending_wallet_topups ?? 0, label: t('mo.needsWalletTopups'), href: '/admin/vehicles', icon: Wallet },
    { count: overview?.needs_action.pending_shadi_advance ?? 0, label: t('mo.needsShadiAdvance'), href: '/admin/shadi-bookings', icon: HandCoins },
    { count: overview?.needs_action.open_disputes ?? 0, label: t('mo.needsDisputes'), href: '/admin/disputes', icon: Scale },
  ].filter((n) => n.count > 0)

  return (
    <div className="shop-ink-theme">
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><LayoutDashboard size={26} /> {t('mo.pageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('mo.pageSubtitle')}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant flex items-center gap-1"><Briefcase size={11} /> {t('mo.jobsTodayLabel')}</p>
          <p className="font-heading text-[24px] font-bold text-dp-primary mt-1 ltr-num">{overview?.jobs_today ?? 0}</p>
        </div>
        <div className="bg-dp-primary rounded-lg p-4">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.06em] text-white/75 flex items-center gap-1"><Car size={11} /> {t('mo.vehiclesLiveLabel')}</p>
          <p className="font-heading text-[24px] font-bold text-white mt-1 ltr-num">{overview?.vehicles_live ?? 0}</p>
        </div>
        <div className={`rounded-lg p-4 ${(overview?.wallets_negative_count ?? 0) > 0 ? 'bg-dp-secondary' : 'bg-white border border-dp-outline-variant'}`}>
          <p className={`font-sans text-[10px] font-bold uppercase tracking-[0.06em] flex items-center gap-1 ${(overview?.wallets_negative_count ?? 0) > 0 ? 'text-white/75' : 'text-dp-on-surface-variant'}`}><AlertTriangle size={11} /> {t('mo.commissionDueLabel')}</p>
          <p className={`font-heading text-[24px] font-bold mt-1 ltr-num ${(overview?.wallets_negative_count ?? 0) > 0 ? 'text-white' : 'text-dp-primary'}`}>{fmt(overview?.wallets_negative_total_pkr ?? 0)}</p>
          <p className={`font-sans text-[11px] mt-0.5 ltr-num ${(overview?.wallets_negative_count ?? 0) > 0 ? 'text-white/75' : 'text-dp-on-surface-variant'}`}>{overview?.wallets_negative_count ?? 0} {t('mo.walletsNegativeSuffix')}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant flex items-center gap-1"><Wallet size={11} /> {t('mo.cashMovedLabel')}</p>
          <p className="font-heading text-[24px] font-bold text-dp-primary mt-1 ltr-num">{fmt(overview?.cash_today_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
          <p className="font-sans text-[10px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant flex items-center gap-1"><HandCoins size={11} /> {t('mo.advanceHeldLabel')}</p>
          <p className="font-heading text-[24px] font-bold text-dp-primary mt-1 ltr-num">{fmt(overview?.advance_held_pkr ?? 0)}</p>
        </div>
      </div>

      {needsAction.length > 0 && (
        <div className="mb-6">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mo.needsActionHeading')}</p>
          <div className="space-y-2">
            {needsAction.map((n) => (
              <Link key={n.label} href={n.href} className="flex items-center gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors">
                <div className="w-8 h-8 rounded-full bg-dp-secondary text-white flex items-center justify-center shrink-0 font-sans text-[13px] font-bold ltr-num">{n.count}</div>
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface flex items-center gap-1.5"><n.icon size={14} className="text-dp-secondary" /> {n.label}</p>
              </Link>
            ))}
          </div>
        </div>
      )}

      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('mo.liveFleetHeading')}</p>
      {pins.length === 0 ? (
        <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[13.5px] bg-white border border-dp-outline-variant rounded-lg">{t('fm.noVehiclesLive')}</p>
      ) : (
        <LeafletMap pins={mapPins} height={360} className="rounded-lg border border-dp-outline-variant" />
      )}
    </div>
  )
}
