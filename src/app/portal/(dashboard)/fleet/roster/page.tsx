'use client'

// 2026-11-21: Job Calendar — real ask, given live: "who adjusts drivers
// for a route, and if a driver goes on leave, reassign against the
// already-booked schedule, so every driver has a clear day-wise job
// calendar telling them when and where their next job is." Audited
// what existed first (942's own migration comment has the full trail):
// a permanent one-driver-per-vehicle assignment, a same-day emergency
// vehicle swap, and a past-tense duty-shift log — nothing forward-
// looking, and no way to record a driver's leave at all. This is the
// admin half: a day-by-day list (not a literal month grid — this app
// is phone-portrait throughout, and a 30-column grid doesn't fit one),
// matching this app's own established pattern (date picker + list,
// same as the Fleet dashboard's own "Today's Schedule" and Terminal
// Schedule) rather than inventing a new layout idiom.
//
// This explicitly reverses fleet/drivers/page.tsx's own standing
// comment that there should be no second allotment system — a direct,
// specific ask after reviewing exactly that boundary, the same way
// migration 879 reversed an earlier "don't touch driver shuffle" rule.
// route_run_substitutions (that page's own system) stays exactly as-is
// for same-day emergencies; this is the planned, ahead-of-time layer,
// and effective_route_driver() (942) makes the two compose instead of
// fight.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ChevronLeft, CalendarDays, AlertTriangle, Users2, X } from 'lucide-react'
import { toast } from 'sonner'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetFormGrid, FleetFormField } from '@/components/portal/FleetPanel'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface RosterRow {
  route_id: string; origin: string; destination: string; departure_time: string | null
  vehicle_number: string | null; vehicle_type: string; the_date: string
  driver_fleet_staff_id: string | null; driver_name: string | null; via: string
  is_override: boolean; override_note: string | null; driver_on_leave: boolean
}
interface LeaveRow { fleet_staff_id: string; driver_name: string; leave_date: string; reason: string | null }
interface DriverOption { id: string; full_name: string }

function today() { return new Date().toISOString().slice(0, 10) }
function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
function fmtTime(t: string | null) {
  if (!t) return null
  const [h, m] = t.split(':')
  const hour = Number(h); const ampm = hour >= 12 ? 'PM' : 'AM'; const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${m} ${ampm}`
}
function fmtDateHeading(dateStr: string, isUrdu: boolean) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(isUrdu ? 'ur-PK' : 'en-PK', { weekday: 'short', day: 'numeric', month: 'short' })
}
const VIA_STYLE: Record<string, { bg: string; fg: string }> = {
  default: { bg: '#F1F5F9', fg: '#64748b' },
  same_day_substitute: { bg: '#EFF6FF', fg: '#1d4ed8' },
  roster_override: { bg: '#FFFBEB', fg: '#b45309' },
  needs_cover: { bg: '#FEF2F2', fg: '#b91c1c' },
  default_unregistered: { bg: '#FEF2F2', fg: '#b91c1c' },
}

export default function FleetRosterPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [drivers, setDrivers] = useState<DriverOption[]>([])
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [leaveList, setLeaveList] = useState<LeaveRow[]>([])
  const [anchorDate, setAnchorDate] = useState(today())
  const [rangeDays, setRangeDays] = useState(7)

  const [reassignKey, setReassignKey] = useState<string | null>(null)
  const [reassignDriver, setReassignDriver] = useState('')
  const [reassignNote, setReassignNote] = useState('')
  const [saving, setSaving] = useState(false)

  const [leaveDriver, setLeaveDriver] = useState('')
  const [leaveFrom, setLeaveFrom] = useState(today())
  const [leaveTo, setLeaveTo] = useState(today())
  const [leaveReason, setLeaveReason] = useState('')
  const [savingLeave, setSavingLeave] = useState(false)

  const dateFrom = anchorDate
  const dateTo = addDays(anchorDate, rangeDays - 1)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f) {
      const [{ data: s }, { data: r }, { data: l }] = await Promise.all([
        supabase.rpc('my_fleet_staff', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_route_roster', { p_fleet_id: f.fleet_id, p_date_from: dateFrom, p_date_to: dateTo }),
        supabase.rpc('fleet_driver_leave_list', { p_fleet_id: f.fleet_id, p_date_from: dateFrom, p_date_to: dateTo }),
      ])
      setDrivers(((s ?? []) as { id: string; full_name: string; role: string }[]).filter((x) => x.role === 'driver').map((x) => ({ id: x.id, full_name: x.full_name })))
      setRoster((r ?? []) as RosterRow[])
      setLeaveList((l ?? []) as LeaveRow[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, anchorDate, rangeDays])

  const openReassign = (row: RosterRow) => {
    const key = `${row.route_id}|${row.the_date}`
    setReassignKey(key)
    setReassignDriver(row.driver_fleet_staff_id ?? '')
    setReassignNote(row.override_note ?? '')
  }

  const saveReassign = async (row: RosterRow) => {
    setSaving(true)
    const { error } = await supabase.rpc('set_route_day_driver', {
      p_route_id: row.route_id, p_date: row.the_date, p_fleet_staff_id: reassignDriver || null, p_note: reassignNote.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.rosterUpdatedToast'))
    setReassignKey(null)
    load()
  }

  const clearOverride = async (row: RosterRow) => {
    setSaving(true)
    const { error } = await supabase.rpc('clear_route_day_override', { p_route_id: row.route_id, p_date: row.the_date })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.rosterUpdatedToast'))
    setReassignKey(null)
    load()
  }

  const saveLeave = async () => {
    if (!fleetId || !leaveDriver) { toast.error(t('mv.pickDriverError')); return }
    setSavingLeave(true)
    const { error } = await supabase.rpc('set_driver_leave', {
      p_fleet_id: fleetId, p_fleet_staff_id: leaveDriver, p_date_from: leaveFrom, p_date_to: leaveTo, p_reason: leaveReason.trim() || null,
    })
    setSavingLeave(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.leaveRecordedToast'))
    setLeaveReason('')
    load()
  }

  const clearLeaveDay = async (row: LeaveRow) => {
    const { error } = await supabase.rpc('clear_driver_leave', { p_fleet_staff_id: row.fleet_staff_id, p_date_from: row.leave_date, p_date_to: row.leave_date })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  const dates = Array.from({ length: rangeDays }, (_, i) => addDays(anchorDate, i))
  const conflicts = roster.filter((r) => r.driver_on_leave)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><CalendarDays size={17} /> {t('mv.jobCalendarHeading')}</h1>
      </div>
      <p className="font-sans text-[11px] text-[#64748b] -mt-2">{t('mv.panelDesc.jobCalendar')}</p>

      <div className="flex items-center gap-2">
        <input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} className="px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
        <select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))} className="px-2 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[12px]">
          <option value={7}>{t('mv.rosterRange7')}</option>
          <option value={14}>{t('mv.rosterRange14')}</option>
          <option value={30}>{t('mv.rosterRange30')}</option>
        </select>
      </div>

      {/* The real point of the whole page: surface exactly which
          already-booked routes have a driver conflict right now, so
          the owner never has to scan the whole list to find it. */}
      {conflicts.length > 0 && (
        <FleetPanel tone="danger">
          <FleetPanelHead tone="danger" icon={<AlertTriangle size={14} />} title={t('mv.rosterConflictsHeading')} description={t('mv.panelDesc.rosterConflicts')}
            action={<span className="px-2 py-0.5 rounded-full bg-[#FEF2F2] text-[#b91c1c] font-sans text-[10px] font-bold ltr-num">{conflicts.length}</span>} />
          <div className="flex flex-col divide-y divide-[#f1f5f9]">
            {conflicts.map((r) => (
              <div key={`${r.route_id}|${r.the_date}`} className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="font-sans text-[12.5px] font-bold text-[#1e293b] truncate">{fmtDateHeading(r.the_date, isUrdu)} · {r.origin} → {r.destination}</p>
                  <p className="font-sans text-[11px] text-[#b91c1c]">{t('mv.rosterDriverOnLeaveLabel').replace('{name}', r.driver_name ?? '—')}</p>
                </div>
                <button onClick={() => openReassign(r)} className="shrink-0 px-2.5 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-bold cursor-pointer">{t('mv.reassignBtn')}</button>
              </div>
            ))}
          </div>
        </FleetPanel>
      )}

      {/* Driver leave — owner only, matching set_staff_home_terminal's
          own gate (staff-HR actions are owner-gated throughout). */}
      {isOwner && (
        <FleetPanel>
          <FleetPanelHead icon={<Users2 size={14} />} title={t('mv.driverLeaveHeading')} description={t('mv.panelDesc.driverLeave')} />
          <FleetPanelBody>
            <FleetFormGrid>
              <FleetFormField label={t('mv.driverLabel')} full>
                <select value={leaveDriver} onChange={(e) => setLeaveDriver(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                  <option value="">{t('mv.pickDriverOption')}</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                </select>
              </FleetFormField>
              <FleetFormField label={t('mv.leaveFromLabel')}>
                <input type="date" value={leaveFrom} onChange={(e) => setLeaveFrom(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </FleetFormField>
              <FleetFormField label={t('mv.leaveToLabel')}>
                <input type="date" value={leaveTo} onChange={(e) => setLeaveTo(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </FleetFormField>
              <FleetFormField label={t('mv.leaveReasonLabel')} full>
                <input value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} placeholder={t('mv.leaveReasonPlaceholder')} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
              </FleetFormField>
              <button onClick={saveLeave} disabled={savingLeave} className="col-span-2 w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
                {savingLeave ? t('action.saving') : t('mv.setLeaveBtn')}
              </button>
            </FleetFormGrid>
            {leaveList.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-3 pt-3 border-t border-[#f1f5f9]">
                {leaveList.map((l) => (
                  <div key={`${l.fleet_staff_id}|${l.leave_date}`} className="flex items-center justify-between gap-2 bg-[#F9F9F6] rounded-lg px-2.5 py-1.5">
                    <p className="font-sans text-[11.5px] text-[#1e293b] truncate"><span className="font-bold">{l.driver_name}</span> · {fmtDateHeading(l.leave_date, isUrdu)}{l.reason ? ` · ${l.reason}` : ''}</p>
                    <button onClick={() => clearLeaveDay(l)} className="shrink-0 p-1 text-[#94a3b8] cursor-pointer"><X size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </FleetPanelBody>
        </FleetPanel>
      )}

      {/* Day-by-day roster — every scheduled route, its effective
          driver, and an inline reassign control. */}
      {dates.map((d) => {
        const dayRows = roster.filter((r) => r.the_date === d)
        if (dayRows.length === 0) return null
        return (
          <FleetPanel key={d}>
            <FleetPanelHead title={fmtDateHeading(d, isUrdu)} />
            <div className="flex flex-col divide-y divide-[#f1f5f9]">
              {dayRows.map((r) => {
                const key = `${r.route_id}|${r.the_date}`
                const style = VIA_STYLE[r.via] ?? VIA_STYLE.default
                return (
                  <div key={key} className="px-3.5 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-sans text-[12.5px] font-bold text-[#1e293b] ltr-num">{fmtTime(r.departure_time) ?? '—'} · {r.origin} → {r.destination}</p>
                      <span className="shrink-0 font-sans text-[11px] text-[#64748b] ltr-num">{r.vehicle_number || r.vehicle_type}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="px-2 py-0.5 rounded-full font-sans text-[10.5px] font-bold" style={{ background: style.bg, color: style.fg }}>
                        {r.driver_name ?? t('mv.rosterNeedsCoverLabel')}
                      </span>
                      {r.driver_on_leave && <span className="px-2 py-0.5 rounded-full bg-[#FEF2F2] text-[#b91c1c] font-sans text-[10px] font-bold">{t('mv.onLeaveBadge')}</span>}
                      {r.is_override && <span className="font-sans text-[10px] text-[#94a3b8]">{t('mv.rosterOverrideBadge')}</span>}
                    </div>
                    {reassignKey === key ? (
                      <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-[#f1f5f9]">
                        <select value={reassignDriver} onChange={(e) => setReassignDriver(e.target.value)} className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]">
                          <option value="">{t('mv.rosterMarkNeedsCoverOption')}</option>
                          {drivers.map((dr) => <option key={dr.id} value={dr.id}>{dr.full_name}</option>)}
                        </select>
                        <input value={reassignNote} onChange={(e) => setReassignNote(e.target.value)} placeholder={t('mv.rosterNotePlaceholder')} className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
                        <div className="flex gap-2">
                          <button onClick={() => saveReassign(r)} disabled={saving} className="flex-1 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">{saving ? t('action.saving') : t('action.save')}</button>
                          {r.is_override && <button onClick={() => clearOverride(r)} disabled={saving} className="flex-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#64748b] cursor-pointer disabled:opacity-50">{t('mv.rosterRevertToDefaultBtn')}</button>}
                          <button onClick={() => setReassignKey(null)} className="flex-1 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#64748b] cursor-pointer">{t('action.cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => openReassign(r)} className="font-sans text-[11px] font-semibold text-[#166534] mt-1.5 cursor-pointer">{t('mv.reassignBtn')}</button>
                    )}
                  </div>
                )
              })}
            </div>
          </FleetPanel>
        )
      })}
    </div>
  )
}
