'use client'

// A vehicle owner's own side of the hourly rental / shadi catalog (474):
// photos, colour, model, AC, and the two opt-in switches — everything
// EXCEPT the actual rate, which stays committee-set (a deliberate
// departure from per_km_pkr's own self-service precedent, confirmed
// directly — bigger, less frequent bookings warranting more oversight).
// Turning either switch on is refused server-side until the committee
// has actually set a rate, so a vehicle can never list itself bookable
// at a null price.
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, reached
// from the Vehicle tab's settings list.
//
// 875: the actual form now lives in VehicleCatalogForm (shared with the
// Fleet "Bus Management" bottom-sheet version) — this page just resolves
// which vehicle to show and renders it full-page, unchanged behavior.

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { VehicleCatalogForm } from '@/components/mobility/VehicleCatalogForm'

export default function MyVehicleCatalogPage() {
  return (
    <Suspense fallback={<div className="text-center py-12"><LoadingDots /></div>}>
      <MyVehicleCatalogInner />
    </Suspense>
  )
}

function MyVehicleCatalogInner() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  // "Bus Management" (fleet/vehicles) used to link here with ?vehicle=<id>
  // — now opens VehicleCatalogForm directly in a bottom sheet instead, but
  // this param is kept so a bookmarked/shared link still works the same.
  const vehicleIdParam = useSearchParams().get('vehicle')
  const [resolvedVehicleId, setResolvedVehicleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    if (vehicleIdParam) { setResolvedVehicleId(vehicleIdParam); setLoading(false); return }
    supabase.from('vehicles').select('id').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      setResolvedVehicleId(data?.id ?? null)
      setLoading(false)
    })
  }, [user, vehicleIdParam]) // eslint-disable-line react-hooks/exhaustive-deps

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      {vehicleIdParam && (
        <Link href="/portal/fleet/vehicles" className="inline-flex items-center gap-1 font-sans text-[12px] font-semibold text-[#166534] -mb-2">
          <ArrowLeft size={13} className={isUrdu ? 'rotate-180' : ''} /> {t('mv.busManagementHeading')}
        </Link>
      )}
      {resolvedVehicleId ? <VehicleCatalogForm vehicleId={resolvedVehicleId} /> : <div className="text-center py-12 text-[#64748b] text-[14px]">{t('cm.noVehicleLinked')}</div>}
    </div>
  )
}
