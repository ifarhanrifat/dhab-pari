'use client'

// Shared shell for every driver screen, rebuilt to the new "Dhab Pari
// Mobility" design (dhab-pari-mobility.html) — the file's own driver app
// has exactly 4 tabs (Home / Jobs / Earnings / Vehicle, its own
// `nav()` function for `S.role==='driver'`), reached via a header +
// bottom nav identical in spirit to the rider side's MobilityHeader/
// MobilityBottomNav. The old wide tab-rail (one tab per booking type:
// adda/routes/trips/requests/delivery/weekend/catalog/hourly/shadi/
// equipment/deliveries) is gone — those screens still exist at their own
// routes, now reached by tapping a row on the new Jobs tab (or a link
// from Vehicle for the settings-only ones), exactly how the file's own
// order rows open a detail page rather than living on the nav itself.
//
// The vehicle-name/online-toggle/city-presence header that used to be
// persistent chrome on every tab moved into the new Home page's body —
// the file's own driver:home screen owns that card, not its chrome.

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Clock3 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityHeader } from '@/components/mobility/MobilityHeader'
import { DriverMobilityNav } from '@/components/mobility/DriverMobilityNav'
import { DriverJobsBadgeProvider, useDriverJobsBadge } from '@/components/mobility/DriverJobsBadgeContext'

interface Vehicle {
  id: string; owner_name: string; vehicle_type: string; commission_mode: string
  delivers: boolean; offers_hourly: boolean; offers_shadi: boolean; is_online: boolean
  offers_equipment: boolean; offers_rental: boolean
}

function Chrome({ children }: { children: React.ReactNode }) {
  const { isUrdu } = useLocale()
  const { count } = useDriverJobsBadge()
  return (
    // Same desktop-width fix as marketplace/(mobility)/layout.tsx — see
    // its comment. Kept in sync deliberately rather than factored into a
    // shared wrapper, matching this file's own existing precedent of a
    // section owning its full chrome rather than sharing a generic shell.
    <div className="min-h-[calc(100vh-1px)] bg-[#e5e2d0] sm:py-5 -m-6 md:-m-10">
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="sm:max-w-[460px] sm:mx-auto bg-[#F9F9F6] min-h-[calc(100vh-1px)] sm:min-h-[calc(100vh-40px)] sm:shadow-[0_25px_50px_-12px_rgba(0,0,0,.35)]">
        <MobilityHeader />
        <div className="p-3.5 pb-24">{children}</div>
      </div>
      <DriverMobilityNav jobsBadge={count} />
    </div>
  )
}

export default function MyVehicleLayout({ children }: { children: React.ReactNode }) {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const pathname = usePathname()
  const supabase = createClient()
  // The registration form is its own standalone page — a driver with no
  // vehicle yet lands here deliberately, so it must render on its own
  // (no shared chrome, and none of this layout's own "you need to
  // register" guard, which would otherwise just show the same prompt
  // again instead of the actual form).
  const isRegisterPage = pathname === '/portal/my-vehicle/register'

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [loading, setLoading] = useState(true)
  const [regStatus, setRegStatus] = useState<{ status: string; rejection_reason: string | null } | null>(null)

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, vehicle_type, commission_mode, delivers, offers_hourly, offers_shadi, offers_rental, is_online, offers_machinery, offers_tractor, offers_loader').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      // Shown behind one combined flag — the 3 equipment verticals share
      // a single driver-side screen (my-vehicle/equipment), not a tab
      // each, since most vehicles only ever offer one or two of them.
      setVehicle(data ? { ...data, offers_equipment: !!(data.offers_machinery || data.offers_tractor || data.offers_loader) } : data)
      if (!data) supabase.rpc('my_vehicle_registration_status').then(({ data: rs }) => setRegStatus(rs ?? null))
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isRegisterPage) return <>{children}</>

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  if (!vehicle) {
    if (regStatus?.status === 'pending') {
      return (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="text-center py-12 max-w-md mx-auto">
          <Clock3 size={28} className="text-amber-600 mx-auto mb-2" />
          <p className="font-sans text-[14px] font-bold text-[#1e293b]">{t('vr.pendingTitle')}</p>
          <p className="font-sans text-[13px] text-[#64748b] mt-1">{t('vr.pendingBody')}</p>
        </div>
      )
    }
    return (
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="text-center py-12 max-w-md mx-auto">
        {regStatus?.status === 'rejected' && (
          <p className="font-sans text-[12.5px] text-[#b91c1c] mb-3">{t('vr.previouslyRejectedTitle')}: {regStatus.rejection_reason}</p>
        )}
        <p className="font-sans text-[13.5px] text-[#64748b] mb-3">{t('cm.noVehicleLinked')}</p>
        <Link href="/portal/my-vehicle/register" className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-[#166534] text-white rounded-xl font-sans text-[13.5px] font-semibold">
          {t('vr.registerBtn')}
        </Link>
      </div>
    )
  }

  return (
    <DriverJobsBadgeProvider vehicleId={vehicle.id} vehicle={vehicle}>
      <Chrome>{children}</Chrome>
    </DriverJobsBadgeProvider>
  )
}
