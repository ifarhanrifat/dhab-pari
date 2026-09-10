'use client'

// The rider bottom nav's "آرڈر" (Orders) tab destination — a single
// combined feed across every booking kind, matching the design's own
// home-screen "MY ORDERS & BOOKINGS" preview, just as its own full
// list. Each source already has its own detail screen (order tracking,
// route booking, trip tracking, hourly, shadi); this page is purely a
// normalized, merged, chronological index into them — no new backend,
// every query already exists elsewhere in this codebase.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Store, Bus, Car, Clock3, Users2, CheckCircle2, XCircle, Clock, Ban } from 'lucide-react'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarketplaceBottomNav } from '@/components/portal/MarketplaceBottomNav'

type Kind = 'shop' | 'route' | 'trip' | 'hourly'
interface FeedItem {
  id: string; kind: Kind; title: string; subtitle: string; amount: number; status: string; date: string; href: string
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

const KIND_ICON: Record<Kind, typeof Store> = { shop: Store, route: Bus, trip: Car, hourly: Clock3 }

export default function MarketplaceOrdersPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [items, setItems] = useState<FeedItem[] | null>(null)

  useEffect(() => {
    if (!user) return
    Promise.all([
      supabase.from('shop_orders').select('id, status, total_amount_pkr, fulfillment_status, created_at, shops(name, name_ur)')
        .eq('portal_user_id', user.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('ride_bookings').select('id, status, total_amount_pkr, travel_date, created_at, vehicle_routes(origin, origin_ur, destination, destination_ur)')
        .eq('portal_user_id', user.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('vehicle_trip_bookings').select('id, status, total_amount_pkr, created_at, vehicle_trip_offers(origin, origin_ur, destination, destination_ur)')
        .eq('portal_user_id', user.id).order('created_at', { ascending: false }).limit(20),
      supabase.rpc('my_hourly_bookings'),
    ]).then(([{ data: shop }, { data: routes }, { data: trips }, { data: hourly }]) => {
      const feed: FeedItem[] = [
        ...((shop ?? []) as unknown as { id: string; status: string; total_amount_pkr: number; fulfillment_status: string; created_at: string; shops: { name: string; name_ur: string | null } | null }[]).map((o) => ({
          id: o.id, kind: 'shop' as Kind, title: isUrdu && o.shops?.name_ur ? o.shops.name_ur : o.shops?.name ?? '—',
          subtitle: t(`of.status.${o.fulfillment_status}`, o.status), amount: o.total_amount_pkr, status: o.status, date: o.created_at,
          href: `/portal/marketplace/order/${o.id}`,
        })),
        ...((routes ?? []) as unknown as { id: string; status: string; total_amount_pkr: number; travel_date: string; created_at: string; vehicle_routes: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null }[]).map((b) => ({
          id: b.id, kind: 'route' as Kind,
          title: b.vehicle_routes ? `${isUrdu && b.vehicle_routes.origin_ur ? b.vehicle_routes.origin_ur : b.vehicle_routes.origin} → ${isUrdu && b.vehicle_routes.destination_ur ? b.vehicle_routes.destination_ur : b.vehicle_routes.destination}` : '—',
          subtitle: new Date(b.travel_date).toLocaleDateString('en-GB'), amount: b.total_amount_pkr, status: b.status, date: b.created_at,
          href: `/portal/marketplace`,
        })),
        ...((trips ?? []) as unknown as { id: string; status: string; total_amount_pkr: number; created_at: string; vehicle_trip_offers: { origin: string; origin_ur: string | null; destination: string; destination_ur: string | null } | null }[]).map((b) => ({
          id: b.id, kind: 'trip' as Kind,
          title: b.vehicle_trip_offers ? `${isUrdu && b.vehicle_trip_offers.origin_ur ? b.vehicle_trip_offers.origin_ur : b.vehicle_trip_offers.origin} → ${isUrdu && b.vehicle_trip_offers.destination_ur ? b.vehicle_trip_offers.destination_ur : b.vehicle_trip_offers.destination}` : '—',
          subtitle: t(`mp.feedStatus.${b.status}`), amount: b.total_amount_pkr, status: b.status, date: b.created_at,
          href: `/portal/marketplace/trips`,
        })),
        ...((hourly ?? []) as unknown as { id: string; status: string; total_amount_pkr: number | null; base_amount_pkr: number; owner_name: string; requested_at: string }[]).map((b) => ({
          id: b.id, kind: 'hourly' as Kind, title: b.owner_name, subtitle: t(`vp.hourlyStatus.${b.status}`),
          amount: b.total_amount_pkr ?? b.base_amount_pkr, status: b.status, date: b.requested_at,
          href: `/portal/marketplace/hourly`,
        })),
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      setItems(feed)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const StatusPill = ({ status }: { status: string }) => {
    if (['confirmed', 'accepted', 'completed', 'in_progress'].includes(status)) return <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t(`mp.feedStatus.${status}`)}</span>
    if (['rejected', 'declined'].includes(status)) return <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold"><XCircle size={11} /> {t(`mp.feedStatus.${status}`)}</span>
    if (['cancelled', 'withdrawn'].includes(status)) return <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[11px] font-bold"><Ban size={11} /> {t(`mp.feedStatus.${status}`)}</span>
    return <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t(`mp.feedStatus.${status}`)}</span>
  }

  if (userLoading || items === null) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <Link href="/portal/marketplace" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.pageTitle')}
      </Link>
      <h1 className="font-heading text-[24px] font-bold text-dp-primary mb-1 flex items-center gap-2"><Users2 size={20} /> {t('mp.ordersPageTitle')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('mp.ordersPageSubtitle')}</p>

      {items.length === 0 ? (
        <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('mp.noOrdersYet')}</p>
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const Icon = KIND_ICON[it.kind]
            return (
              <Link key={`${it.kind}-${it.id}`} href={it.href} className="flex items-center gap-3 bg-white border border-dp-outline-variant rounded-lg p-3 hover:border-dp-secondary transition-colors">
                <div className="w-9 h-9 rounded-lg bg-dp-surface-container flex items-center justify-center shrink-0"><Icon size={16} className="text-dp-secondary" /></div>
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{it.title}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{new Date(it.date).toLocaleDateString('en-GB')} · {it.subtitle}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[13.5px] font-bold text-dp-on-surface ltr-num">{fmt(it.amount)}</p>
                  <StatusPill status={it.status} />
                </div>
              </Link>
            )
          })}
        </div>
      )}
      <MarketplaceBottomNav />
    </div>
  )
}
