'use client'

// 860: the fleet owner/staff shell, a direct sibling of my-vehicle's own
// layout.tsx — same Chrome structure (MobilityHeader + a bottom nav +
// padded phone-width body), but with FleetBottomNav instead of
// DriverMobilityNav, and no vehicle-registration/online-toggle concerns
// at all (those are driver concepts, not fleet-owner ones). This is the
// actual fix for "admin is mentioned as a driver" — an owner/staff member
// lands here, never inside my-vehicle's single-vehicle driver shell,
// regardless of whether they also happen to personally drive one of the
// fleet's vehicles (my-vehicle/layout.tsx's old "fall back to the fleet's
// first vehicle" hack is removed in the same pass as this file's addition).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityHeader } from '@/components/mobility/MobilityHeader'
import { FleetBottomNav } from '@/components/mobility/FleetBottomNav'

function Chrome({ children }: { children: React.ReactNode }) {
  const { isUrdu } = useLocale()
  return (
    <div className="min-h-[calc(100vh-1px)] bg-[#e5e2d0] sm:py-5 -m-4 sm:-m-6 md:-m-10">
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="sm:max-w-[460px] md:max-w-none bg-[#F9F9F6] min-h-[calc(100vh-1px)] sm:min-h-[calc(100vh-40px)] sm:shadow-[0_25px_50px_-12px_rgba(0,0,0,.35)]">
        <MobilityHeader />
        <div className="p-3.5 pb-24">{children}</div>
      </div>
      <FleetBottomNav />
    </div>
  )
}

export default function FleetLayout({ children }: { children: React.ReactNode }) {
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
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
  useEffect(() => {
    if (checked && !isManager) router.replace('/portal')
  }, [checked, isManager]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || !checked) return <div className="text-center py-12"><LoadingDots /></div>
  if (!isManager) return <div className="text-center py-12"><LoadingDots /></div>

  return <Chrome>{children}</Chrome>
}
