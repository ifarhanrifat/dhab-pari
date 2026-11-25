'use client'

// 860: the fleet owner/staff shell, a direct sibling of my-vehicle's own
// layout.tsx — same MobilityHeader + padded phone-width body, but (as of
// 2026-11-17) navigated only through the header's hamburger drawer
// (PortalSidebar's fleetChildren), not a second bottom tab bar — see the
// comment on Chrome below. No vehicle-registration/online-toggle concerns
// at all (those are driver concepts, not fleet-owner ones). This is the
// actual fix for "admin is mentioned as a driver" — an owner/staff member
// lands here, never inside my-vehicle's single-vehicle driver shell,
// regardless of whether they also happen to personally drive one of the
// fleet's vehicles (my-vehicle/layout.tsx's old "fall back to the fleet's
// first vehicle" hack is removed in the same pass as this file's addition).

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityHeader } from '@/components/mobility/MobilityHeader'

function Chrome({ children }: { children: React.ReactNode }) {
  const { isUrdu } = useLocale()
  return (
    <div className="min-h-[calc(100vh-1px)] bg-[#e5e2d0] sm:py-5 -m-4 sm:-m-6 md:-m-10">
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="sm:max-w-[460px] md:max-w-none bg-[#F9F9F6] min-h-[calc(100vh-1px)] sm:min-h-[calc(100vh-40px)] sm:shadow-[0_25px_50px_-12px_rgba(0,0,0,.35)]">
        <MobilityHeader />
        {/* 2026-11-17: real complaint, confirmed against the SAFAR
            mockup directly — it has no bottom tab bar at all, just the
            one sidebar nav. FleetBottomNav's 5 tabs (Dashboard/
            Bookings/Expenses/Cash/Reports) were already fully
            duplicated inside PortalSidebar's fleetChildren list (which
            also has the other 10 fleet destinations the tab bar never
            had room for) — reachable from this same header's hamburger
            button (MobilityHeader's openMobileNav). Removing the
            second, narrower nav instead of maintaining two competing
            ones; pb reduced since content no longer needs to clear a
            bottom nav bar. */}
        <div className="p-3.5 pb-8">{children}</div>
      </div>
    </div>
  )
}

export default function FleetLayout({ children }: { children: React.ReactNode }) {
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()
  const [checked, setChecked] = useState(false)
  const [isManager, setIsManager] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.rpc('my_managed_fleet').then(({ data }) => {
      setIsManager(!!(data as { fleet_id: string } | null)?.fleet_id)
      setChecked(true)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // my_managed_fleet() returns null for someone with no fleet at all — the
  // Fleet tab in PortalSidebar only ever shows for a fleet owner/staff
  // member, but a stale link or bookmark could still land anyone here.
  //
  // Real bug found live, 2026-11-25: this redirect fired on the fleet
  // home page too, which is the ONLY place create_my_fleet's own form
  // lives (page.tsx's own `if (!fleetId)` branch) — so a brand new
  // portal_user had no way to ever create their first fleet at all; the
  // one page meant to onboard them bounced them straight back out
  // before it could render. Scoped the redirect to every OTHER fleet
  // page, which do assume an existing fleet_id and would otherwise show
  // a broken/empty state for someone with none.
  const isFleetHome = pathname === '/portal/fleet'
  useEffect(() => {
    if (checked && !isManager && !isFleetHome) router.replace('/portal')
  }, [checked, isManager, isFleetHome]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || !checked) return <div className="text-center py-12"><LoadingDots /></div>
  if (!isManager && !isFleetHome) return <div className="text-center py-12"><LoadingDots /></div>

  return <Chrome>{children}</Chrome>
}
