'use client'

// 2026-11-18: Rentals & charters (design-first plan, remaining batch)
// — from safar_admin_dashboard-1.html's "Rentals & private charters"
// view, the only screen with genuinely no dhab-pari equivalent. Not
// a new concept though: dhab-pari already has three real, separate
// rental systems (hourly_bookings, rental_bookings, shadi_vehicle_
// requests+shadi_events), each with its own real backend, just never
// surfaced on one fleet-wide admin view. fleet_rental_bookings (916)
// unions all three, scoped to this fleet's own vehicles.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ChevronLeft, CalendarClock, Search } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetStat, FleetStatusPill } from '@/components/portal/FleetPanel'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

type RentalKind = 'hourly' | 'point_to_point' | 'shadi'
interface RentalRow {
  kind: RentalKind; id: string; vehicle_id: string; vehicle_number: string | null; vehicle_type: string
  customer_name: string; status: string; amount_pkr: number; detail: string; created_at: string
}
function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
const KIND_LABEL_KEY: Record<RentalKind, string> = { hourly: 'mv.rentalKindHourly', point_to_point: 'mv.rentalKindPointToPoint', shadi: 'mv.rentalKindShadi' }
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'gray'> = {
  requested: 'amber', accepted: 'blue', declined: 'red', in_progress: 'blue', completed: 'green', cancelled: 'gray',
  collecting: 'amber', advance_announced: 'amber', confirmed: 'green',
}
const STATUS_LABEL_KEY: Record<string, string> = {
  requested: 'mv.rentalStatusRequested', accepted: 'mv.rentalStatusAccepted', declined: 'mv.rentalStatusDeclined',
  in_progress: 'mv.rentalStatusInProgress', completed: 'mv.rentalStatusCompleted', cancelled: 'mv.rentalStatusCancelled',
}

export default function FleetRentalsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [rentals, setRentals] = useState<RentalRow[]>([])
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (!user) return
    const load = async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string } | null
      if (f) {
        const { data } = await supabase.rpc('fleet_rental_bookings', { p_fleet_id: f.fleet_id })
        setRentals((data ?? []) as RentalRow[])
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const activeCount = rentals.filter((r) => ['requested', 'accepted', 'in_progress', 'collecting', 'advance_announced'].includes(r.status)).length
  const now = new Date()
  const revenueThisMonth = rentals.filter((r) => {
    if (r.status !== 'completed' && r.status !== 'confirmed') return false
    const d = new Date(r.created_at)
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  }).reduce((sum, r) => sum + Number(r.amount_pkr), 0)

  const q = searchQuery.trim().toLowerCase()
  const filteredRentals = rentals.filter((r) => !q || r.customer_name.toLowerCase().includes(q) || (r.vehicle_number ?? '').toLowerCase().includes(q) || r.detail.toLowerCase().includes(q))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><CalendarClock size={17} /> {t('mv.rentalsHeading')}</h1>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <FleetStat label={t('mv.statActiveRentalsLabel')} icon={<CalendarClock size={12} />} value={activeCount} />
        <FleetStat label={t('mv.statRentalRevenueMonthLabel')} value={`₨${fmt(revenueThisMonth)}`} valueClassName="text-[#166534]" />
      </div>

      <FleetPanel>
        <FleetPanelHead icon={<CalendarClock size={14} />} title={t('mv.rentalsHeading')} description={t('mv.panelDesc.rentals')}
          action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{rentals.length}</span>} />
        {rentals.length > 0 && (
          <div className="relative p-3 pb-0">
            <Search size={13} className="absolute top-1/2 -translate-y-1/2 start-[22px] text-[#94a3b8]" />
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={t('mv.searchStaffPlaceholder')}
              className="w-full ps-8 pe-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
          </div>
        )}
        {rentals.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noRentalsYetHint')}</p>
        ) : filteredRentals.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noMatchingStaffHint')}</p>
        ) : (
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {filteredRentals.map((r) => (
              <div key={`${r.kind}-${r.id}`} className="px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-sans text-[13px] font-bold text-[#1e293b]">{r.customer_name}</p>
                  <FleetStatusPill tone={STATUS_TONE[r.status] ?? 'gray'}>{t(STATUS_LABEL_KEY[r.status] ?? r.status)}</FleetStatusPill>
                </div>
                <p className="font-sans text-[11px] text-[#64748b] mt-0.5">
                  <span className="px-1.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#64748b] font-sans text-[9.5px] font-bold me-1">{t(KIND_LABEL_KEY[r.kind])}</span>
                  {r.vehicle_number || r.vehicle_type}
                </p>
                <p className="font-sans text-[11px] text-[#64748b] mt-1 truncate">{r.detail}</p>
                <p className="font-sans text-[12px] font-semibold text-[#166534] mt-1 ltr-num">₨{fmt(r.amount_pkr)}</p>
              </div>
            ))}
          </div>
        )}
      </FleetPanel>
    </div>
  )
}
