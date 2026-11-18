'use client'

// 860: Counters sub-page, reached from the Dashboard tab's quick links.
// Same create-a-city-counter form as the old single-page fleet.tsx
// (855), unchanged logic, just moved to its own route.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Building2, Plus, MapPin, Search, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetFormGrid, FleetFormField, FleetStatusPill } from '@/components/portal/FleetPanel'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

interface Counter {
  id: string; city: string; name: string | null; cash_office_code: string | null; manager_name: string | null
  today_bookings_count: number; lat: number | null; lng: number | null; cash_in_hand_pkr: number
}
function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
const emptyEditForm = { city: '', name: '', lat: '', lng: '', cash_office_code: '' }

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
  const [newLat, setNewLat] = useState('')
  const [newLng, setNewLng] = useState('')
  const [newCashOfficeCode, setNewCashOfficeCode] = useState('')
  const [creating, setCreating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [editingCounter, setEditingCounter] = useState<Counter | null>(null)
  const [editForm, setEditForm] = useState(emptyEditForm)
  const [savingEdit, setSavingEdit] = useState(false)

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
      p_fleet_id: fleetId, p_city: newCity, p_name: newName || null,
      p_lat: newLat ? Number(newLat) : null, p_lng: newLng ? Number(newLng) : null,
      p_cash_office_code: newCashOfficeCode || null,
    })
    setCreating(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.counterCreatedToast'))
    setNewCity(''); setNewName(''); setNewLat(''); setNewLng(''); setNewCashOfficeCode('')
    load()
  }

  // 2026-11-18: real gap caught on review — there was no "Manage"
  // action anywhere, and no RPC existed to edit a counter once it was
  // created (only create_fleet_counter). New update_fleet_counter (910).
  const openEdit = (c: Counter) => {
    setEditingCounter(c)
    setEditForm({ city: c.city, name: c.name ?? '', lat: c.lat != null ? String(c.lat) : '', lng: c.lng != null ? String(c.lng) : '', cash_office_code: c.cash_office_code ?? '' })
  }
  const saveEdit = async () => {
    if (!editingCounter || !editForm.city.trim()) { toast.error(t('mv.enterCounterCityError')); return }
    setSavingEdit(true)
    const { error } = await supabase.rpc('update_fleet_counter', {
      p_counter_id: editingCounter.id, p_city: editForm.city, p_name: editForm.name || null,
      p_lat: editForm.lat ? Number(editForm.lat) : null, p_lng: editForm.lng ? Number(editForm.lng) : null,
      p_cash_office_code: editForm.cash_office_code || null,
    })
    setSavingEdit(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.counterUpdatedToast'))
    setEditingCounter(null)
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const q = searchQuery.trim().toLowerCase()
  const filteredCounters = counters.filter((c) => !q || c.city.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q))

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
            <FleetFormField label={t('mv.latitudeLabel')}>
              <input type="number" step="0.000001" value={newLat} onChange={(e) => setNewLat(e.target.value)}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('mv.longitudeLabel')}>
              <input type="number" step="0.000001" value={newLng} onChange={(e) => setNewLng(e.target.value)}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
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
        {counters.length > 0 && (
          <div className="relative p-3 pb-0">
            <Search size={13} className="absolute top-1/2 -translate-y-1/2 start-[22px] text-[#94a3b8]" />
            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={t('mv.searchTerminalsPlaceholder')}
              className="w-full ps-8 pe-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
          </div>
        )}
        {counters.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noCountersYetHint')}</p>
        ) : filteredCounters.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noMatchingTerminalsHint')}</p>
        ) : (
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {/* 2026-11-17: Terminals screen rebuild — this used to be a
                4-column <table>; adding the real cash-status pill and
                cash-in-hand amount pushed it to 6 columns, which just
                squeezed illegibly on a phone width (confirmed live).
                Switched to the same card-list pattern as Vehicles/
                Dashboard instead of cramming more into the table. */}
            {filteredCounters.map((c) => (
              <div key={c.id} className="px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate">{c.city}{c.name ? ` · ${c.name}` : ''}</p>
                    <p className="font-sans text-[11px] text-[#64748b] mt-0.5">{t('mv.managedByLabel')}: {c.manager_name || '—'}</p>
                  </div>
                  <span className="shrink-0 inline-block px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10.5px] font-bold ltr-num whitespace-nowrap">{c.today_bookings_count} {t('mv.todayLabel')}</span>
                </div>
                <div className="flex items-center flex-wrap gap-1.5 mt-2">
                  <FleetStatusPill tone={c.cash_in_hand_pkr > 0 ? 'amber' : 'green'}>
                    {t(c.cash_in_hand_pkr > 0 ? 'mv.counterStatusCashPendingLabel' : 'mv.counterStatusActiveLabel')}
                  </FleetStatusPill>
                  <span className="font-sans text-[11px] text-[#1e293b] font-semibold ltr-num">{t('mv.cashInHandLabel')}: ₨{fmt(c.cash_in_hand_pkr)}</span>
                  {c.cash_office_code && <span className="font-sans text-[11px] text-[#64748b] ltr-num">· {t('mv.cashOfficeCodeLabel')}: {c.cash_office_code}</span>}
                </div>
                <div className="flex items-center justify-between mt-2">
                  {c.lat != null && c.lng != null ? (
                    <a href={`https://www.google.com/maps?q=${c.lat},${c.lng}`} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 font-sans text-[11px] font-semibold text-[#166534]">
                      <MapPin size={11} /> {t('mv.viewOnMapLink')}
                    </a>
                  ) : <span />}
                  {isOwner && (
                    <button onClick={() => openEdit(c)} className="flex items-center gap-1 font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">
                      <Settings2 size={11} /> {t('mv.manageTerminalBtn')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </FleetPanel>

      {editingCounter && (
        <MobilityBottomSheet title={`${t('mv.manageTerminalBtn')} · ${editingCounter.city}`} onClose={() => setEditingCounter(null)}>
          <FleetFormGrid>
            <FleetFormField label={t('mv.counterCityPlaceholder')}>
              <input value={editForm.city} onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('mv.counterNameOptionalPlaceholder')}>
              <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            </FleetFormField>
            <FleetFormField label={t('mv.latitudeLabel')}>
              <input type="number" step="0.000001" value={editForm.lat} onChange={(e) => setEditForm((f) => ({ ...f, lat: e.target.value }))}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('mv.longitudeLabel')}>
              <input type="number" step="0.000001" value={editForm.lng} onChange={(e) => setEditForm((f) => ({ ...f, lng: e.target.value }))}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <FleetFormField label={t('mv.cashOfficeCodeLabel')} full>
              <input value={editForm.cash_office_code} onChange={(e) => setEditForm((f) => ({ ...f, cash_office_code: e.target.value }))}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            </FleetFormField>
            <button onClick={saveEdit} disabled={savingEdit} className="col-span-2 w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
              {savingEdit ? t('action.saving') : t('action.save')}
            </button>
          </FleetFormGrid>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
