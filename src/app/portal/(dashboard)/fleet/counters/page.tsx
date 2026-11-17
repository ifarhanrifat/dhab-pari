'use client'

// 860: Counters sub-page, reached from the Dashboard tab's quick links.
// Same create-a-city-counter form as the old single-page fleet.tsx
// (855), unchanged logic, just moved to its own route.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Building2, Plus, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetFormGrid, FleetFormField, FleetStatusPill } from '@/components/portal/FleetPanel'

interface Counter {
  id: string; city: string; name: string | null; cash_office_code: string | null; manager_name: string | null
  today_bookings_count: number; lat: number | null; lng: number | null; cash_in_hand_pkr: number
}
function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

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
          <FleetFormGrid>
            <FleetFormField label={t('mv.counterCityPlaceholder')}>
              <input value={newCity} onChange={(e) => setNewCity(e.target.value)} placeholder={t('mv.counterCityPlaceholder')}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('mv.counterNameOptionalPlaceholder')}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('mv.counterNameOptionalPlaceholder')}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            {/* 883: real gap — a counter was just a city+name label, with
                no cash-office identity and no visibility into who manages
                it or what it's actually doing today. */}
            <FleetFormField label={t('mv.cashOfficeCodeLabel')} full>
              <input value={newCashOfficeCode} onChange={(e) => setNewCashOfficeCode(e.target.value)} placeholder={t('mv.cashOfficeCodePlaceholder')}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <button onClick={createCounter} disabled={creating} className="col-span-2 w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {creating ? t('action.loading') : t('mv.addCounterBtn')}
            </button>
          </FleetFormGrid>
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
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] bg-[#F9F9F6] border-b border-[#f1f5f9]">
                    <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.bookingCountersHeading')}</th>
                    <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.managedByLabel')}</th>
                    <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.cashOfficeCodeLabel')}</th>
                    <th className="px-3.5 py-1.5 text-start whitespace-nowrap">{t('mv.cashInHandLabel')}</th>
                    <th className="px-3.5 py-1.5 text-start whitespace-nowrap"></th>
                    <th className="px-3.5 py-1.5 text-end whitespace-nowrap">{t('mv.todayLabel')}</th>
                  </tr>
                </thead>
                <tbody>
                  {counters.map((c) => (
                    <tr key={c.id} className="border-t border-[#f1f5f9] align-middle">
                      <td className="px-3.5 py-2.5 font-sans text-[13px] font-semibold text-[#1e293b] whitespace-nowrap">
                        {c.city}{c.name ? ` · ${c.name}` : ''}
                        {c.lat != null && c.lng != null && (
                          <a href={`https://www.google.com/maps?q=${c.lat},${c.lng}`} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 font-sans text-[10px] font-semibold text-[#166534] mt-0.5">
                            <MapPin size={10} /> {t('mv.viewOnMapLink')}
                          </a>
                        )}
                      </td>
                      <td className="px-3.5 py-2.5 font-sans text-[11px] text-[#64748b] whitespace-nowrap">{c.manager_name || '—'}</td>
                      <td className="px-3.5 py-2.5 font-sans text-[11px] text-[#64748b] ltr-num whitespace-nowrap">{c.cash_office_code || '—'}</td>
                      <td className="px-3.5 py-2.5 font-sans text-[11px] text-[#1e293b] ltr-num whitespace-nowrap font-semibold">₨{fmt(c.cash_in_hand_pkr)}</td>
                      <td className="px-3.5 py-2.5 whitespace-nowrap">
                        <FleetStatusPill tone={c.cash_in_hand_pkr > 0 ? 'amber' : 'green'}>
                          {t(c.cash_in_hand_pkr > 0 ? 'mv.counterStatusCashPendingLabel' : 'mv.counterStatusActiveLabel')}
                        </FleetStatusPill>
                      </td>
                      <td className="px-3.5 py-2.5 text-end">
                        <span className="inline-block px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10.5px] font-bold ltr-num whitespace-nowrap">{c.today_bookings_count} {t('mv.todayLabel')}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </FleetPanel>
    </div>
  )
}
