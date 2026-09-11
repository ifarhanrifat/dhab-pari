'use client'

// Shared shell for every driver screen — mirrors the zip's own driver
// portal structure exactly: one persistent header (name, online/offline,
// city presence) plus a screen rail underneath it that switches which
// screen is showing (dScreen in the original mockup). The zip did this
// as client-side state inside one SPA screen; this app has real routing,
// so the equivalent is a layout (this file) wrapping one page per screen
// — same visual effect (persistent header, no full reload feel), real
// URLs, back button works, and each screen's own state stays scoped to
// its own page instead of one 1200-line file.
//
// Previously all of this — dashboard, adda, routes, trips, dispatch/
// city-purchase requests, delivery settings, weekend offers — lived on
// one /portal/my-vehicle page. Split apart per direct instruction: the
// zip had these as separate screens, and consolidating them made the
// driver dashboard both visually cramped and harder to find things on.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bus, MapPin, Clock3 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Vehicle {
  id: string; owner_name: string; vehicle_type: string; commission_mode: string
  delivers: boolean; offers_hourly: boolean; offers_shadi: boolean; is_online: boolean
}
interface City { id: string; name: string; name_ur: string | null }
interface Presence { city_id: string; city_name: string; city_name_ur: string | null }

const TABS = [
  { href: '/portal/my-vehicle', key: 'dashboard' as const },
  { href: '/portal/my-vehicle/adda', key: 'adda' as const },
  { href: '/portal/my-vehicle/routes', key: 'routes' as const },
  { href: '/portal/my-vehicle/trips', key: 'trips' as const },
  { href: '/portal/my-vehicle/requests', key: 'requests' as const },
  { href: '/portal/my-vehicle/delivery', key: 'delivery' as const, requires: 'delivers' as const },
  { href: '/portal/my-vehicle/weekend', key: 'weekend' as const },
  { href: '/portal/my-vehicle/catalog', key: 'catalog' as const },
  { href: '/portal/my-vehicle/hourly', key: 'hourly' as const, requires: 'offers_hourly' as const },
  { href: '/portal/my-vehicle/shadi', key: 'shadi' as const, requires: 'offers_shadi' as const },
  { href: '/portal/my-vehicle/deliveries', key: 'deliveries' as const, requires: 'delivers' as const },
]

export default function MyVehicleLayout({ children }: { children: React.ReactNode }) {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const pathname = usePathname()
  const supabase = createClient()
  // The registration form is its own standalone page — a driver with no
  // vehicle yet lands here deliberately, so it must render on its own
  // (no shared header/rail, and none of this layout's own "you need to
  // register" guard, which would otherwise just show the same prompt
  // again instead of the actual form).
  const isRegisterPage = pathname === '/portal/my-vehicle/register'

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [regStatus, setRegStatus] = useState<{ status: string; rejection_reason: string | null } | null>(null)
  const [vpSaving, setVpSaving] = useState(false)
  const [cities, setCities] = useState<City[]>([])
  const [presence, setPresence] = useState<Presence | null>(null)
  const [showScrollHint, setShowScrollHint] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, vehicle_type, commission_mode, delivers, offers_hourly, offers_shadi, is_online').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      setVehicle(data)
      if (!data) supabase.rpc('my_vehicle_registration_status').then(({ data: rs }) => setRegStatus(rs ?? null))
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const reloadPresence = async (vehicleId: string) => {
    const { data: p } = await supabase.from('vehicle_city_presence').select('city_id, expected_return_at, cities(name, name_ur)').eq('vehicle_id', vehicleId).eq('is_active', true).maybeSingle()
    setPresence(p ? { city_id: p.city_id, city_name: (p.cities as unknown as { name: string; name_ur: string | null })?.name ?? '', city_name_ur: (p.cities as unknown as { name: string; name_ur: string | null })?.name_ur ?? null } : null)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { if (vehicle) reloadPresence(vehicle.id) }, [vehicle])

  useEffect(() => {
    const timer = setTimeout(() => setShowScrollHint(true), 900)
    return () => clearTimeout(timer)
  }, [])

  const toggleOnline = async () => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = await supabase.rpc('set_vehicle_online_status', { p_vehicle_id: vehicle.id, p_is_online: !vehicle.is_online })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setVehicle({ ...vehicle, is_online: !vehicle.is_online })
    toast.success(vehicle.is_online ? t('vp.wentOfflineToast') : t('vp.wentOnlineToast'))
  }

  // City presence — a quick tap-a-chip switcher in the header, on every
  // screen, matching the zip's driver header exactly ("CITY PRESENCE —
  // PUTS YOU IN THE CHEAP TIER" under the online toggle). Tapping the
  // already-active city checks out; tapping another checks in there.
  const pickCity = async (cityId: string) => {
    if (!vehicle) return
    setVpSaving(true)
    const { error } = presence?.city_id === cityId
      ? await supabase.rpc('vehicle_check_out_city', { p_vehicle_id: vehicle.id })
      : await supabase.rpc('vehicle_check_in_city', { p_vehicle_id: vehicle.id, p_city_id: cityId })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    reloadPresence(vehicle.id)
  }

  if (isRegisterPage) return <>{children}</>

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  if (!vehicle) {
    if (regStatus?.status === 'pending') {
      return (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme text-center py-12 max-w-md mx-auto">
          <Clock3 size={28} className="text-amber-600 mx-auto mb-2" />
          <p className="font-sans text-[14px] font-bold text-dp-on-surface">{t('vr.pendingTitle')}</p>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1">{t('vr.pendingBody')}</p>
        </div>
      )
    }
    return (
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme text-center py-12 max-w-md mx-auto">
        {regStatus?.status === 'rejected' && (
          <p className="font-sans text-[12.5px] text-dp-error mb-3">{t('vr.previouslyRejectedTitle')}: {regStatus.rejection_reason}</p>
        )}
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-3">{t('cm.noVehicleLinked')}</p>
        <Link href="/portal/my-vehicle/register" className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all">
          {t('vr.registerBtn')}
        </Link>
      </div>
    )
  }

  const visibleTabs = TABS.filter((tab) => !tab.requires || vehicle[tab.requires])

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <h1 className="font-heading text-[26px] font-bold leading-[34px] text-dp-primary flex items-center gap-2 min-w-0 flex-1">
          <Bus size={22} className="shrink-0" /> <span className="truncate">{vehicle.owner_name}</span>
        </h1>
        <button onClick={toggleOnline} disabled={vpSaving} className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer border transition-colors disabled:opacity-50 whitespace-nowrap ${vehicle.is_online ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700' : 'border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container'}`}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${vehicle.is_online ? 'bg-white' : 'bg-dp-on-surface-variant'}`} />
          {vehicle.is_online ? t('vp.onlineLabel') : t('vp.offlineLabel')}
        </button>
      </div>
      <p className={`font-sans text-[13px] text-dp-on-surface-variant ${vehicle.is_online ? 'mb-3' : 'mb-1'}`}>{vehicle.vehicle_type}</p>
      {!vehicle.is_online && <p className="font-sans text-[12px] text-amber-700 mb-3">{t('vp.offlineHint')}</p>}

      {/* City presence chips — moved here from the old Delivery Settings
          section, matching the zip's own driver header exactly (a row of
          city pills directly under the online toggle, on every screen). */}
      <div className="mb-3">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-1.5">{t('vp.cityPresenceLabel')}</p>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5">
          {cities.map((c) => {
            const active = presence?.city_id === c.id
            return (
              <button key={c.id} onClick={() => pickCity(c.id)} disabled={vpSaving} className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-[12px] font-sans font-semibold cursor-pointer border transition-colors disabled:opacity-50 ${active ? 'bg-dp-secondary text-white border-dp-secondary' : 'bg-white text-dp-on-surface-variant border-dp-outline-variant hover:bg-dp-surface-container'}`}>
                {active && <MapPin size={11} className="inline me-1 -mt-0.5" />}
                {isUrdu && c.name_ur ? c.name_ur : c.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* Screen rail — same one-shot scroll-hint nudge as the action strip
          this replaced, since this row can run just as long. */}
      <div className="overflow-x-auto pb-1 mb-5 -mx-0.5 px-0.5 border-b border-dp-outline-variant">
        <div className={`flex items-center gap-1 w-max ${showScrollHint ? 'scroll-hint-nudge' : ''}`}>
          {visibleTabs.map((tab) => {
            const active = pathname === tab.href
            return (
              <Link key={tab.href} href={tab.href} className={`shrink-0 whitespace-nowrap px-3 py-2 text-[12.5px] font-sans font-semibold cursor-pointer border-b-2 -mb-px transition-colors ${active ? 'border-dp-secondary text-dp-secondary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}>
                {t(`mv.tab.${tab.key}`)}
              </Link>
            )
          })}
        </div>
      </div>

      {children}
    </div>
  )
}
