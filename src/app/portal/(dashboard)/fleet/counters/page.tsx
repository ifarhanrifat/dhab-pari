'use client'

// 860: Counters sub-page, reached from the Dashboard tab's quick links.
// Same create-a-city-counter form as the old single-page fleet.tsx
// (855), unchanged logic, just moved to its own route.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Building2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetColumnLabels } from '@/components/portal/FleetPanel'

interface Counter { id: string; city: string; name: string | null; cash_office_code: string | null; manager_name: string | null; today_bookings_count: number }

export default function FleetCountersPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [counters, setCounters] = useState<Counter[]>([])
  const [newCity, setNewCity] = useState('')
  const [newName, setNewName] = useState('')
  const [newCashOfficeCode, setNewCashOfficeCode] = useState('')
  const [creating, setCreating] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f) {
      const { data } = await supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id })
      setCounters((data ?? []) as Counter[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const createCounter = async () => {
    if (!fleetId || !newCity.trim()) { toast.error(t('mv.enterCounterCityError')); return }
    setCreating(true)
    const { error } = await supabase.rpc('create_fleet_counter', {
      p_fleet_id: fleetId, p_city: newCity, p_name: newName || null, p_cash_office_code: newCashOfficeCode || null,
    })
    setCreating(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.counterCreatedToast'))
    setNewCity(''); setNewName(''); setNewCashOfficeCode('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><Building2 size={17} /> {t('mv.bookingCountersHeading')}</h1>
      </div>

      {isOwner && (
        <FleetPanel>
          <FleetPanelHead icon={<Plus size={14} />} title={t('mv.addCounterBtn')} description={t('mv.panelDesc.newCounter')} />
          <FleetPanelBody>
          <div className="flex gap-2 mb-2.5">
            <input value={newCity} onChange={(e) => setNewCity(e.target.value)} placeholder={t('mv.counterCityPlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('mv.counterNameOptionalPlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          {/* 883: real gap — a counter was just a city+name label, with
              no cash-office identity and no visibility into who manages
              it or what it's actually doing today. */}
          <input value={newCashOfficeCode} onChange={(e) => setNewCashOfficeCode(e.target.value)} placeholder={t('mv.cashOfficeCodePlaceholder')}
            className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5 ltr-num" />
          <button onClick={createCounter} disabled={creating} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {creating ? t('action.loading') : t('mv.addCounterBtn')}
          </button>
          </FleetPanelBody>
        </FleetPanel>
      )}

      <FleetPanel>
        <FleetPanelHead icon={<Building2 size={14} />} title={t('mv.bookingCountersHeading')} description={t('mv.panelDesc.counters')}
          action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{counters.length}</span>} />
        {counters.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noCountersYetHint')}</p>
        ) : (
          <>
            <FleetColumnLabels labels={[t('mv.bookingCountersHeading'), t('mv.todayLabel')]} />
            <div className="divide-y divide-[#f1f5f9]">
              {counters.map((c) => (
                <div key={c.id} className="px-3.5 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[13px] font-semibold text-[#1e293b] truncate min-w-0">{c.city}{c.name ? ` · ${c.name}` : ''}</span>
                    <span className="shrink-0 px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10.5px] font-bold ltr-num">{c.today_bookings_count} {t('mv.todayLabel')}</span>
                  </div>
                  {(c.manager_name || c.cash_office_code) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                      {c.manager_name && <p className="font-sans text-[11px] text-[#64748b]"><span className="text-[#94a3b8]">{t('mv.managedByLabel')}:</span> {c.manager_name}</p>}
                      {c.cash_office_code && <p className="font-sans text-[11px] text-[#64748b] ltr-num"><span className="text-[#94a3b8]">{t('mv.cashOfficeCodeLabel')}:</span> {c.cash_office_code}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </FleetPanel>
    </div>
  )
}
