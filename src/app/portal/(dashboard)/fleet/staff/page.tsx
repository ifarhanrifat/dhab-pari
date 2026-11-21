'use client'

// 860: Fleet Staff sub-page, reached from the Dashboard tab's quick
// links. Carries over the existing staff add/remove/counter-assign UI
// (854/855) unchanged, plus the new salary tracking (migration 860):
// set a monthly salary and record a payment, both owner-only, same
// "full equal access, minus staff/salary management" split fleet_staff
// has always had.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, UserPlus, Users2, ShieldCheck, History, Search, Wallet, Clock, Repeat2 } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat, FleetFormGrid, FleetFormField } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface StaffMember {
  id: string; portal_user_id: string; full_name: string; counter_id: string | null; counter_city: string | null; counter_name: string | null
  home_terminal_id: string | null; home_terminal_city: string | null; home_terminal_name: string | null
  role: string; commission_amount_pkr: number | null; commission_this_month_pkr: number; current_monthly_salary_pkr: number | null
  overtime_this_month_pkr: number; on_duty_since: string | null; on_duty_shift_id: string | null
  license_number: string | null; license_expiry: string | null; cnic_number: string | null
  date_of_birth: string | null; blood_group: string | null; medical_report_url: string | null; photo_url: string | null
}
function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const
interface Counter { id: string; city: string; name: string | null }
interface RolePermission { role: string; module: string; can_edit: boolean }
interface AuditEntry { id: string; actor_name: string | null; action: string; details: Record<string, unknown> | null; created_at: string }
interface FleetVehicle { id: string; vehicle_number: string | null; vehicle_type: string }
interface PayrollSettings {
  pay_frequency: 'monthly' | 'weekly' | 'per_trip'; overtime_calculation: 'hourly_rate' | 'fixed_shift' | 'manual'
  overtime_hourly_rate_pkr: number | null; overtime_fixed_shift_pkr: number | null
  commission_eligibility: 'confirmed_paid' | 'completed_journey'; default_commission_per_seat_pkr: number | null
}
interface RosterShift {
  id: string; driver_name: string; vehicle_number: string | null; vehicle_type: string; route_label: string | null
  shift_start: string; shift_end: string | null; incident_note: string | null; handover_from_shift_id: string | null; rest_break_count: number
}
const PAY_FREQUENCY_SUFFIX_KEY: Record<string, string> = { monthly: 'mv.perMonthSuffixLabel', weekly: 'mv.perWeekSuffixLabel', per_trip: 'mv.perTripSuffixLabel' }

const PERMISSION_ROLES = ['booking_officer', 'terminal_manager', 'accountant', 'other'] as const
const PERMISSION_MODULES = ['staff_payroll', 'cash', 'bookings', 'schedule'] as const
// 2026-11-21: real complaint, given live — "huge page, don't know what
// it's for," next to a direct comparison to how professional HR/staff
// tools organize this (separate Directory/Payroll/Permissions areas,
// not one long scroll). Nothing here changes what any control does —
// every handler/RPC below is untouched — this only regroups the exact
// same sections behind tabs, same pattern /portal/drive's own
// Home/Trip/Cash/Pay tabs already use in this codebase.
type StaffTab = 'directory' | 'payroll' | 'drivers' | 'permissions'

export default function FleetStaffPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [counters, setCounters] = useState<Counter[]>([])
  const [phone, setPhone] = useState('')
  const [adding, setAdding] = useState(false)
  const [salaryDraft, setSalaryDraft] = useState<Record<string, string>>({})
  const [paymentDraft, setPaymentDraft] = useState<Record<string, string>>({})
  const [commissionDraft, setCommissionDraft] = useState<Record<string, string>>({})
  const [permissions, setPermissions] = useState<RolePermission[]>([])
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([])
  const [showAudit, setShowAudit] = useState(false)
  const [driverDraft, setDriverDraft] = useState<Record<string, { license_number: string; license_expiry: string; cnic_number: string; date_of_birth: string; blood_group: string }>>({})
  // 2026-11-18: real gap caught on review — the mockup's Employee
  // register panel has a search box + role filter; this page had neither.
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [payrollSettings, setPayrollSettings] = useState<PayrollSettings | null>(null)
  const [payrollDraft, setPayrollDraft] = useState<PayrollSettings | null>(null)
  const [savingPayroll, setSavingPayroll] = useState(false)
  const [overtimeDraft, setOvertimeDraft] = useState<Record<string, { date: string; hours: string; amount: string }>>({})
  const [shiftDraft, setShiftDraft] = useState<Record<string, { vehicle_id: string; start: string }>>({})
  const [handoverDraft, setHandoverDraft] = useState<Record<string, string>>({})
  const [showRoster, setShowRoster] = useState(false)
  const [roster, setRoster] = useState<RosterShift[]>([])
  const [tab, setTab] = useState<StaffTab>('directory')

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f?.is_owner) {
      const [{ data: s }, { data: c }, { data: p }, { data: a }, { data: v }, { data: ps }] = await Promise.all([
        supabase.rpc('my_fleet_staff', { p_fleet_id: f.fleet_id }),
        supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_role_permissions_matrix', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_audit_log_recent', { p_fleet_id: f.fleet_id, p_limit: 50 }),
        supabase.rpc('my_fleet_vehicles'),
        supabase.rpc('my_fleet_payroll_settings', { p_fleet_id: f.fleet_id }),
      ])
      setStaff((s ?? []) as StaffMember[])
      setCounters((c ?? []) as Counter[])
      setPermissions((p ?? []) as RolePermission[])
      setAuditLog((a ?? []) as AuditEntry[])
      setVehicles((v ?? []) as FleetVehicle[])
      setPayrollSettings((ps ?? null) as PayrollSettings | null)
      setPayrollDraft((ps ?? null) as PayrollSettings | null)
    }
    setLoading(false)
  }

  const loadRoster = async () => {
    if (!fleetId) return
    const { data } = await supabase.rpc('fleet_driver_duty_roster', { p_fleet_id: fleetId })
    setRoster((data ?? []) as RosterShift[])
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const addStaff = async () => {
    if (!fleetId || !phone.trim()) { toast.error(t('mv.enterDriverPhoneError')); return }
    setAdding(true)
    const { error } = await supabase.rpc('add_fleet_staff', { p_fleet_id: fleetId, p_phone: phone })
    setAdding(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.staffAddedToast'))
    setPhone('')
    load()
  }

  const removeStaff = async (portalUserId: string) => {
    if (!fleetId || !confirm(t('mv.confirmRemoveStaffHint'))) return
    const { error } = await supabase.rpc('remove_fleet_staff', { p_fleet_id: fleetId, p_portal_user_id: portalUserId })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const assignCounter = async (portalUserId: string, counterId: string) => {
    if (!fleetId) return
    const { error } = await supabase.rpc('assign_staff_to_counter', { p_fleet_id: fleetId, p_portal_user_id: portalUserId, p_counter_id: counterId || null })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  // 932: a driver's home terminal (for GPS attendance check-in) is a
  // separate concept from counter_id (terminal-desk write scoping) —
  // assigning one must never narrow the other.
  const assignHomeTerminal = async (portalUserId: string, terminalId: string) => {
    if (!fleetId) return
    const { error } = await supabase.rpc('set_staff_home_terminal', { p_fleet_id: fleetId, p_portal_user_id: portalUserId, p_home_terminal_id: terminalId || null })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const saveSalary = async (fleetStaffId: string) => {
    const amount = salaryDraft[fleetStaffId]
    if (!amount) return
    const { error } = await supabase.rpc('set_fleet_staff_salary', { p_fleet_staff_id: fleetStaffId, p_monthly_salary_pkr: Number(amount) })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.salarySetToast'))
    setSalaryDraft((d) => ({ ...d, [fleetStaffId]: '' }))
  }

  const recordPayment = async (fleetStaffId: string) => {
    const amount = paymentDraft[fleetStaffId]
    if (!amount) return
    const { error } = await supabase.rpc('record_staff_salary_payment', { p_fleet_staff_id: fleetStaffId, p_amount_pkr: Number(amount) })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.paymentRecordedToast'))
    setPaymentDraft((d) => ({ ...d, [fleetStaffId]: '' }))
  }

  const setRole = async (fleetStaffId: string, role: string) => {
    const { error } = await supabase.rpc('set_fleet_staff_role', { p_fleet_staff_id: fleetStaffId, p_role: role })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const saveCommission = async (fleetStaffId: string) => {
    const amount = commissionDraft[fleetStaffId]
    const { error } = await supabase.rpc('set_fleet_staff_commission', { p_fleet_staff_id: fleetStaffId, p_commission_amount_pkr: amount ? Number(amount) : null })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.commissionSetToast'))
    setCommissionDraft((d) => ({ ...d, [fleetStaffId]: '' }))
    load()
  }

  // 888: "driver" is now a real role with the fields an actual driver
  // registration needs, so adding one lives inside this page instead
  // of a disconnected invite-and-self-register flow.
  const driverField = (s: StaffMember, key: 'license_number' | 'license_expiry' | 'cnic_number' | 'date_of_birth' | 'blood_group') =>
    driverDraft[s.id]?.[key] ?? (s[key] ?? '')
  const setDriverField = (fleetStaffId: string, key: 'license_number' | 'license_expiry' | 'cnic_number' | 'date_of_birth' | 'blood_group', value: string) =>
    setDriverDraft((d) => {
      const base = d[fleetStaffId] ?? { license_number: '', license_expiry: '', cnic_number: '', date_of_birth: '', blood_group: '' }
      return { ...d, [fleetStaffId]: { ...base, [key]: value } }
    })
  const saveDriverDetails = async (s: StaffMember) => {
    const draft = driverDraft[s.id]
    const { error } = await supabase.rpc('set_fleet_staff_driver_details', {
      p_fleet_staff_id: s.id,
      p_license_number: draft?.license_number ?? s.license_number ?? null,
      p_license_expiry: (draft?.license_expiry ?? s.license_expiry) || null,
      p_cnic_number: draft?.cnic_number ?? s.cnic_number ?? null,
      p_date_of_birth: (draft?.date_of_birth ?? s.date_of_birth) || null,
      p_blood_group: (draft?.blood_group ?? s.blood_group) || null,
    })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.driverDetailsSavedToast'))
    load()
  }
  const uploadDriverFile = async (fleetStaffId: string, field: 'medical_report_url' | 'photo_url', path: string) => {
    const { error } = await supabase.rpc('set_fleet_staff_driver_details', {
      p_fleet_staff_id: fleetStaffId, p_medical_report_url: field === 'medical_report_url' ? path : null, p_photo_url: field === 'photo_url' ? path : null,
    })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.driverDetailsSavedToast'))
    load()
  }

  // 885: a trusted role can be granted a specific capability the owner
  // would otherwise have to do personally — payroll or cash handling.
  // No permission row at all = today's exact behavior (owner-only), so
  // this can only ever widen access, never take something away.
  const togglePermission = async (role: string, module: string, canEdit: boolean) => {
    if (!fleetId) return
    const { error } = await supabase.rpc('set_fleet_role_permission', { p_fleet_id: fleetId, p_role: role, p_module: module, p_can_edit: canEdit })
    if (error) { toast.error(friendlyError(error)); return }
    setPermissions((perms) => perms.map((p) => (p.role === role && p.module === module ? { ...p, can_edit: canEdit } : p)))
  }

  // 2026-11-18: Payroll configuration that actually changes computed
  // behavior, not the mockup's own "Illustrative" placeholder.
  const savePayrollSettings = async () => {
    if (!fleetId || !payrollDraft) return
    setSavingPayroll(true)
    const { error } = await supabase.rpc('set_fleet_payroll_settings', {
      p_fleet_id: fleetId, p_pay_frequency: payrollDraft.pay_frequency, p_overtime_calculation: payrollDraft.overtime_calculation,
      p_overtime_hourly_rate_pkr: payrollDraft.overtime_hourly_rate_pkr, p_overtime_fixed_shift_pkr: payrollDraft.overtime_fixed_shift_pkr,
      p_commission_eligibility: payrollDraft.commission_eligibility, p_default_commission_per_seat_pkr: payrollDraft.default_commission_per_seat_pkr,
    })
    setSavingPayroll(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.payrollSettingsSavedToast'))
    setPayrollSettings(payrollDraft)
  }

  const recordOvertime = async (fleetStaffId: string) => {
    const d = overtimeDraft[fleetStaffId]
    if (!d?.date) { toast.error(t('mv.enterExpiryDateError')); return }
    const { error } = await supabase.rpc('record_staff_overtime', {
      p_fleet_staff_id: fleetStaffId, p_work_date: d.date,
      p_hours: d.hours ? Number(d.hours) : null, p_manual_amount_pkr: d.amount ? Number(d.amount) : null,
    })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.overtimeRecordedToast'))
    setOvertimeDraft((m) => ({ ...m, [fleetStaffId]: { date: '', hours: '', amount: '' } }))
    load()
  }

  // 2026-11-18: real duty-interval tracking — admin/dispatcher-
  // recorded, not driver self-service (that stays with the parked
  // driver-app rebuild).
  const recordShift = async (fleetStaffId: string) => {
    const d = shiftDraft[fleetStaffId]
    if (!d?.vehicle_id || !d?.start) { toast.error(t('mv.fillManualBookingError')); return }
    const { error } = await supabase.rpc('record_duty_shift', {
      p_fleet_staff_id: fleetStaffId, p_vehicle_id: d.vehicle_id, p_route_id: null, p_shift_start: new Date(d.start).toISOString(),
    })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.dutyShiftRecordedToast'))
    setShiftDraft((m) => ({ ...m, [fleetStaffId]: { vehicle_id: '', start: '' } }))
    load()
  }

  const endShift = async (shiftId: string) => {
    const { error } = await supabase.rpc('end_duty_shift', { p_shift_id: shiftId })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.shiftEndedToast'))
    load()
    if (showRoster) loadRoster()
  }

  const handover = async (shiftId: string, toFleetStaffId: string) => {
    if (!toFleetStaffId) return
    const { error } = await supabase.rpc('record_duty_handover', { p_shift_id: shiftId, p_to_fleet_staff_id: toFleetStaffId })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.handoverCompleteToast'))
    load()
    if (showRoster) loadRoster()
  }

  const toggleRoster = () => {
    const next = !showRoster
    setShowRoster(next)
    if (next) loadRoster()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  const q = searchQuery.trim().toLowerCase()
  const filteredStaff = staff.filter((s) => (!roleFilter || s.role === roleFilter) && (!q || s.full_name.toLowerCase().includes(q)))
  const driverStaff = staff.filter((s) => s.role === 'driver')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><UserPlus size={17} /> {t('mv.fleetStaffHeading')}</h1>
      </div>

      {!isOwner ? (
        <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.ownerOnlySectionHint')}</p>
      ) : (
        <>
          <div className="flex gap-1.5 bg-white border border-[#e5e2d0] rounded-xl p-1">
            {([
              ['directory', t('mv.staffTabDirectory')], ['payroll', t('mv.staffTabPayroll')],
              ['drivers', t('mv.staffTabDrivers')], ['permissions', t('mv.staffTabPermissions')],
            ] as [StaffTab, string][]).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} className={`flex-1 py-2 rounded-lg font-sans text-[11.5px] font-bold cursor-pointer ${tab === key ? 'bg-[#166534] text-white' : 'text-[#64748b]'}`}>{label}</button>
            ))}
          </div>

          {tab === 'directory' && (
          <>
          <div className="grid grid-cols-2 gap-2.5">
            <FleetStat label={t('mv.statActiveEmployeesLabel')} value={staff.length} icon={<Users2 size={12} />} />
            <FleetStat label={t('mv.statDriversLabel')} value={driverStaff.length} />
          </div>

          <FleetPanel>
            <FleetPanelHead icon={<UserPlus size={14} />} title={t('mv.addStaffBtn')} description={t('mv.panelDesc.addStaff')} />
            <FleetPanelBody>
              <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.fleetStaffHint')}</p>
              <div className="flex gap-2">
                <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('mv.driverPhonePlaceholder')}
                  className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                <button onClick={addStaff} disabled={adding} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                  {adding ? t('action.loading') : t('mv.addStaffBtn')}
                </button>
              </div>
              {/* 2026-11-21: real gap, found live while comparing this
                  page to a professional invite flow — this box only
                  ever works for a phone that already has an account
                  ("they need to sign up first" otherwise); a genuinely
                  new person has to go through the separate Invite page
                  instead, with no link between the two. Said plainly
                  here rather than silently merging two different RPCs
                  with different guarantees. */}
              <p className="font-sans text-[10.5px] text-[#94a3b8] mt-2">
                {t('mv.addStaffNeedsAccountHint')} <Link href="/portal/fleet/invite" className="font-semibold text-[#166534] underline underline-offset-2">{t('mv.inviteDriverHeading')}</Link>.
              </p>
            </FleetPanelBody>
          </FleetPanel>

          <FleetPanel>
            <FleetPanelHead icon={<Users2 size={14} />} title={t('mv.fleetStaffHeading')} description={t('mv.panelDesc.staff')}
              action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{staff.length}</span>} />
          {staff.length > 0 && (
            <div className="flex gap-1.5 p-3 pb-0">
              <div className="relative flex-1">
                <Search size={13} className="absolute top-1/2 -translate-y-1/2 start-2.5 text-[#94a3b8]" />
                <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={t('mv.searchStaffPlaceholder')}
                  className="w-full ps-8 pe-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px]" />
              </div>
              <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] shrink-0">
                <option value="">{t('mv.allRolesOption')}</option>
                <option value="staff">{t('mv.role.staff')}</option>
                <option value="booking_officer">{t('mv.role.booking_officer')}</option>
                <option value="terminal_manager">{t('mv.role.terminal_manager')}</option>
                <option value="accountant">{t('mv.role.accountant')}</option>
                <option value="other">{t('mv.role.other')}</option>
                <option value="driver">{t('mv.role.driver')}</option>
              </select>
            </div>
          )}
          {staff.length === 0 ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noStaffYetHint')}</p>
          ) : filteredStaff.length === 0 ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noMatchingStaffHint')}</p>
          ) : (
            <div className="flex flex-col divide-y divide-[#f1f5f9]">
              {filteredStaff.map((s) => (
                <div key={s.id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[13px] font-bold text-[#1e293b] flex items-center gap-2 min-w-0">
                      <span className="w-7 h-7 rounded-full bg-[#F0FDF4] text-[#166534] flex items-center justify-center shrink-0 font-sans text-[11px] font-extrabold uppercase">{s.full_name.trim().charAt(0) || '?'}</span>
                      <span className="truncate">{s.full_name}</span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#64748b] font-sans text-[9.5px] font-bold">{t(`mv.role.${s.role}`)}</span>
                    </span>
                    <button onClick={() => removeStaff(s.portal_user_id)} className="shrink-0 font-sans text-[11px] font-bold text-[#b91c1c] cursor-pointer">{t('action.remove')}</button>
                  </div>
                  <select value={s.role} onChange={(e) => setRole(s.id, e.target.value)} className="mt-1.5 w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px]">
                    <option value="staff">{t('mv.role.staff')}</option>
                    <option value="booking_officer">{t('mv.role.booking_officer')}</option>
                    <option value="terminal_manager">{t('mv.role.terminal_manager')}</option>
                    <option value="accountant">{t('mv.role.accountant')}</option>
                    <option value="other">{t('mv.role.other')}</option>
                    <option value="driver">{t('mv.role.driver')}</option>
                  </select>
                  {counters.length > 0 && (
                    <select value={s.counter_id ?? ''} onChange={(e) => assignCounter(s.portal_user_id, e.target.value)} className="mt-1.5 w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px]">
                      <option value="">{t('mv.noCounterOption')}</option>
                      {counters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
                    </select>
                  )}
                  {s.role === 'driver' && counters.length > 0 && (
                    <div className="mt-1.5">
                      <p className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] mb-1">{t('mv.homeTerminalLabel')}</p>
                      <select value={s.home_terminal_id ?? ''} onChange={(e) => assignHomeTerminal(s.portal_user_id, e.target.value)} className="w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px]">
                        <option value="">{t('mv.noCounterOption')}</option>
                        {counters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
                      </select>
                      <p className="font-sans text-[9.5px] text-[#94a3b8] mt-0.5">{t('mv.homeTerminalHint')}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          </FleetPanel>
          </>
          )}

          {tab === 'payroll' && (
          <>
          <div className="grid grid-cols-2 gap-2.5">
            <FleetStat label={t('mv.statMonthlyPayrollLabel')} value={`₨${fmt(staff.reduce((sum, s) => sum + (s.current_monthly_salary_pkr ?? 0), 0))}`} />
            <FleetStat label={t('mv.statCommissionPayableLabel')} value={`₨${fmt(staff.reduce((sum, s) => sum + s.commission_this_month_pkr, 0))}`} valueClassName="text-[#b45309]" />
          </div>

          {/* 2026-11-18: Payroll configuration that actually changes
              computed behavior — the mockup's own panel is tagged
              "Illustrative"; this one isn't. */}
          {payrollDraft && (
            <FleetPanel>
              <FleetPanelHead icon={<Wallet size={14} />} title={t('mv.payrollSettingsHeading')} description={t('mv.panelDesc.payrollSettings')} />
              <FleetPanelBody>
                <FleetFormGrid>
                  <FleetFormField label={t('mv.payFrequencyLabel')}>
                    <select value={payrollDraft.pay_frequency} onChange={(e) => setPayrollDraft((d) => d && { ...d, pay_frequency: e.target.value as PayrollSettings['pay_frequency'] })}
                      className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                      <option value="monthly">{t('mv.payFrequencyMonthly')}</option>
                      <option value="weekly">{t('mv.payFrequencyWeekly')}</option>
                      <option value="per_trip">{t('mv.payFrequencyPerTrip')}</option>
                    </select>
                  </FleetFormField>
                  <FleetFormField label={t('mv.commissionEligibilityLabel')}>
                    <select value={payrollDraft.commission_eligibility} onChange={(e) => setPayrollDraft((d) => d && { ...d, commission_eligibility: e.target.value as PayrollSettings['commission_eligibility'] })}
                      className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                      <option value="confirmed_paid">{t('mv.commissionEligibilityConfirmedPaid')}</option>
                      <option value="completed_journey">{t('mv.commissionEligibilityCompletedJourney')}</option>
                    </select>
                  </FleetFormField>
                  <FleetFormField label={t('mv.overtimeCalculationLabel')} full>
                    <select value={payrollDraft.overtime_calculation} onChange={(e) => setPayrollDraft((d) => d && { ...d, overtime_calculation: e.target.value as PayrollSettings['overtime_calculation'] })}
                      className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                      <option value="manual">{t('mv.overtimeManualOption')}</option>
                      <option value="hourly_rate">{t('mv.overtimeHourlyRateOption')}</option>
                      <option value="fixed_shift">{t('mv.overtimeFixedShiftOption')}</option>
                    </select>
                  </FleetFormField>
                  {payrollDraft.overtime_calculation === 'hourly_rate' && (
                    <FleetFormField label={t('mv.overtimeHourlyRateLabel')}>
                      <input type="number" value={payrollDraft.overtime_hourly_rate_pkr ?? ''} onChange={(e) => setPayrollDraft((d) => d && { ...d, overtime_hourly_rate_pkr: e.target.value ? Number(e.target.value) : null })}
                        className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                    </FleetFormField>
                  )}
                  {payrollDraft.overtime_calculation === 'fixed_shift' && (
                    <FleetFormField label={t('mv.overtimeFixedShiftLabel')}>
                      <input type="number" value={payrollDraft.overtime_fixed_shift_pkr ?? ''} onChange={(e) => setPayrollDraft((d) => d && { ...d, overtime_fixed_shift_pkr: e.target.value ? Number(e.target.value) : null })}
                        className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                    </FleetFormField>
                  )}
                  <FleetFormField label={t('mv.defaultCommissionLabel')} full>
                    <input type="number" value={payrollDraft.default_commission_per_seat_pkr ?? ''} onChange={(e) => setPayrollDraft((d) => d && { ...d, default_commission_per_seat_pkr: e.target.value ? Number(e.target.value) : null })}
                      className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                  </FleetFormField>
                  <button onClick={savePayrollSettings} disabled={savingPayroll || JSON.stringify(payrollDraft) === JSON.stringify(payrollSettings)}
                    className="col-span-2 w-full bg-[#166534] text-white rounded-xl py-2.5 font-sans font-semibold text-[13.5px] cursor-pointer disabled:opacity-50">
                    {savingPayroll ? t('action.saving') : t('action.save')}
                  </button>
                </FleetFormGrid>
              </FleetPanelBody>
            </FleetPanel>
          )}

          <FleetPanel>
            <FleetPanelHead icon={<Users2 size={14} />} title={t('mv.fleetStaffHeading')} description={t('mv.panelDesc.staff')}
              action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{staff.length}</span>} />
          {staff.length === 0 ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noStaffYetHint')}</p>
          ) : (
            <div className="flex flex-col divide-y divide-[#f1f5f9]">
              {staff.map((s) => (
                <div key={s.id} className="px-3.5 py-3">
                  <span className="font-sans text-[13px] font-bold text-[#1e293b] flex items-center gap-2 min-w-0">
                    <span className="w-7 h-7 rounded-full bg-[#F0FDF4] text-[#166534] flex items-center justify-center shrink-0 font-sans text-[11px] font-extrabold uppercase">{s.full_name.trim().charAt(0) || '?'}</span>
                    <span className="truncate">{s.full_name}</span>
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#64748b] font-sans text-[9.5px] font-bold">{t(`mv.role.${s.role}`)}</span>
                  </span>
                  {/* 2026-11-17: Staff screen rebuild — real gap found
                      reading the code: set_fleet_staff_salary (860)
                      could be called, but nothing ever showed what
                      salary was currently on file for anyone. */}
                  <p className="font-sans text-[11px] text-[#64748b] mt-2 pt-2 border-t border-[#f1f5f9]">
                    {t('mv.payPlanLabel')}: <span className="font-semibold text-[#1e293b] ltr-num">{s.current_monthly_salary_pkr != null ? `₨${fmt(s.current_monthly_salary_pkr)} ${t(PAY_FREQUENCY_SUFFIX_KEY[payrollSettings?.pay_frequency ?? 'monthly'])}` : t('mv.noSalarySetHint')}</span>
                  </p>
                  <div className="flex gap-2 mt-1.5">
                    <input type="number" value={salaryDraft[s.id] ?? ''} onChange={(e) => setSalaryDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      placeholder={t('mv.monthlySalaryPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <button onClick={() => saveSalary(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('mv.setSalaryBtn')}</button>
                  </div>
                  {/* 2026-11-18: real overtime ledger, computed from the
                      fleet's chosen payroll method. */}
                  <p className="font-sans text-[10.5px] text-[#64748b] mt-1.5">{t('mv.overtimeThisMonthLabel')}: <span className="font-semibold text-[#1e293b] ltr-num">₨{fmt(s.overtime_this_month_pkr)}</span></p>
                  <div className="flex gap-2 mt-1">
                    <input type="date" value={overtimeDraft[s.id]?.date ?? ''} onChange={(e) => setOvertimeDraft((m) => ({ ...m, [s.id]: { date: e.target.value, hours: m[s.id]?.hours ?? '', amount: m[s.id]?.amount ?? '' } }))}
                      className="w-28 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11px] ltr-num" />
                    {payrollSettings?.overtime_calculation === 'manual' ? (
                      <input type="number" value={overtimeDraft[s.id]?.amount ?? ''} onChange={(e) => setOvertimeDraft((m) => ({ ...m, [s.id]: { date: m[s.id]?.date ?? '', hours: '', amount: e.target.value } }))}
                        placeholder={t('mv.overtimeAmountPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11px] ltr-num" />
                    ) : payrollSettings?.overtime_calculation === 'hourly_rate' ? (
                      <input type="number" value={overtimeDraft[s.id]?.hours ?? ''} onChange={(e) => setOvertimeDraft((m) => ({ ...m, [s.id]: { date: m[s.id]?.date ?? '', hours: e.target.value, amount: '' } }))}
                        placeholder={t('mv.overtimeHoursPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11px] ltr-num" />
                    ) : null}
                    <button onClick={() => recordOvertime(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('mv.recordOvertimeBtn')}</button>
                  </div>
                  <div className="flex gap-2 mt-1.5">
                    <input type="number" value={paymentDraft[s.id] ?? ''} onChange={(e) => setPaymentDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      placeholder={t('mv.expenseAmountPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <button onClick={() => recordPayment(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-semibold cursor-pointer">{t('mv.recordPaymentBtn')}</button>
                  </div>
                  {/* 883: real gap — commission was never tied to actual
                      bookings, only a flat salary. PKR per confirmed
                      seat, credited when this staff member records a
                      sale and reversed if it's later cancelled. */}
                  <div className="flex gap-2 mt-1.5 pt-1.5 border-t border-[#f1f5f9]">
                    <input type="number" value={commissionDraft[s.id] ?? (s.commission_amount_pkr != null ? String(s.commission_amount_pkr) : '')}
                      onChange={(e) => setCommissionDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      placeholder={t('mv.commissionPerSeatPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <button onClick={() => saveCommission(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('mv.setSalaryBtn')}</button>
                  </div>
                  {s.commission_amount_pkr != null && (
                    <p className="font-sans text-[10.5px] text-[#166534] mt-1">{t('mv.commissionThisMonthLabel')}: ₨{s.commission_this_month_pkr.toLocaleString()}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          </FleetPanel>
          </>
          )}

          {tab === 'drivers' && (
          <>
          {/* 2026-11-18: the mockup's duty-rule callout is accurate
              and kept as-is; "Open driver roster" now opens a real
              roster instead of a toast. */}
          <FleetPanel>
            <FleetPanelHead icon={<Repeat2 size={14} />} title={t('mv.dutyComplianceHeading')}
              action={<button onClick={toggleRoster} className="px-2.5 py-1 rounded-lg border border-[#e5e2d0] font-sans text-[11px] text-[#166534] font-semibold cursor-pointer">{showRoster ? t('action.showLess') : t('mv.openDriverRosterBtn')}</button>} />
            <FleetPanelBody>
              <p className="font-sans text-[11px] text-[#64748b] leading-relaxed bg-[#f8f6ee] rounded-lg p-2.5">{t('mv.dutyRuleExplainer')}</p>
              {showRoster && (
                roster.length === 0 ? (
                  <p className="font-sans text-[12px] text-[#94a3b8] text-center py-4">{t('mv.rosterEmptyHint')}</p>
                ) : (
                  <div className="flex flex-col gap-2 mt-2.5">
                    {roster.map((r) => (
                      <div key={r.id} className="border border-[#e5e2d0] rounded-lg p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-sans text-[12px] font-bold text-[#1e293b]">{r.driver_name}</p>
                          <span className="font-sans text-[10.5px] text-[#64748b] ltr-num">
                            {new Date(r.shift_start).toLocaleTimeString(isUrdu ? 'ur-PK' : 'en-PK', { hour: '2-digit', minute: '2-digit' })}
                            {' – '}
                            {r.shift_end ? new Date(r.shift_end).toLocaleTimeString(isUrdu ? 'ur-PK' : 'en-PK', { hour: '2-digit', minute: '2-digit' }) : t('mv.availOnTripLabel')}
                          </span>
                        </div>
                        <p className="font-sans text-[10.5px] text-[#64748b] mt-0.5">{r.vehicle_number || r.vehicle_type}{r.route_label ? ` · ${r.route_label}` : ''}</p>
                        <div className="flex items-center gap-2 mt-1">
                          {r.rest_break_count > 0 && <span className="font-sans text-[10px] text-[#166534] ltr-num">{t('mv.restBreaksCountLabel').replace('{n}', String(r.rest_break_count))}</span>}
                          {r.handover_from_shift_id && <span className="font-sans text-[10px] text-[#b45309]">{t('mv.handedOverFromLabel')}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </FleetPanelBody>
          </FleetPanel>

          <FleetPanel>
            <FleetPanelHead icon={<UserPlus size={14} />} title={t('mv.driverRecordsHeading')} description={t('mv.panelDesc.driverRecords')}
              action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{driverStaff.length}</span>} />
          {driverStaff.length === 0 ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noDriversYetHint')}</p>
          ) : (
            <div className="flex flex-col divide-y divide-[#f1f5f9]">
              {driverStaff.map((s) => (
                <div key={s.id} className="px-3.5 py-3">
                  <span className="font-sans text-[13px] font-bold text-[#1e293b] flex items-center gap-2 min-w-0 mb-1.5">
                    <span className="w-7 h-7 rounded-full bg-[#F0FDF4] text-[#166534] flex items-center justify-center shrink-0 font-sans text-[11px] font-extrabold uppercase">{s.full_name.trim().charAt(0) || '?'}</span>
                    <span className="truncate">{s.full_name}</span>
                  </span>
                  {/* 2026-11-18: real duty-interval tracking — the
                      mockup's own "Open driver roster" button just
                      toasts "Duty roster opened", no real roster
                      exists even there. Admin-recorded here, not
                      driver self-service. */}
                  {s.on_duty_since ? (
                    <div className="flex items-center justify-between gap-2 bg-[#F0FDF4] rounded-lg px-2.5 py-1.5">
                      <span className="flex items-center gap-1 font-sans text-[11px] font-semibold text-[#166534]">
                        <Clock size={11} /> {t('mv.onDutySinceLabel')}: {new Date(s.on_duty_since).toLocaleTimeString(isUrdu ? 'ur-PK' : 'en-PK', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => s.on_duty_shift_id && endShift(s.on_duty_shift_id)} className="px-2 py-1 rounded-lg border border-[#e5e2d0] font-sans text-[10.5px] font-semibold text-[#b91c1c] cursor-pointer">{t('mv.endShiftBtn')}</button>
                        <select value={handoverDraft[s.id] ?? ''} onChange={(e) => { setHandoverDraft((m) => ({ ...m, [s.id]: e.target.value })); if (e.target.value && s.on_duty_shift_id) handover(s.on_duty_shift_id, e.target.value) }}
                          className="px-1.5 py-1 border border-[#e5e2d0] rounded-lg font-sans text-[10.5px]">
                          <option value="">{t('mv.handoverToLabel')}</option>
                          {driverStaff.filter((d) => d.id !== s.id && !d.on_duty_since).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-1.5">
                      <select value={shiftDraft[s.id]?.vehicle_id ?? ''} onChange={(e) => setShiftDraft((m) => ({ ...m, [s.id]: { vehicle_id: e.target.value, start: m[s.id]?.start ?? '' } }))}
                        className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11px]">
                        <option value="">{t('mv.dutyShiftVehicleLabel')}</option>
                        {vehicles.map((v) => <option key={v.id} value={v.id}>{v.vehicle_number || v.vehicle_type}</option>)}
                      </select>
                      <input type="datetime-local" value={shiftDraft[s.id]?.start ?? ''} onChange={(e) => setShiftDraft((m) => ({ ...m, [s.id]: { vehicle_id: m[s.id]?.vehicle_id ?? '', start: e.target.value } }))}
                        className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11px] ltr-num" />
                      <button onClick={() => recordShift(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('mv.recordDutyShiftBtn')}</button>
                    </div>
                  )}
                  {/* 888: a real driver registration — licence, CNIC, DOB,
                      blood group, medical report, photo — the same
                      information /my-vehicle/register already collects
                      for a self-registering driver, now available right
                      here for a driver added as staff. */}
                  <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#64748b] mt-2 pt-2 border-t border-[#f1f5f9]">{t('mv.driverDetailsHeading')}</p>
                  <div className="grid grid-cols-2 gap-1.5 mt-1">
                    <input value={driverField(s, 'license_number')} onChange={(e) => setDriverField(s.id, 'license_number', e.target.value)}
                      placeholder={t('mv.licenseNumberPlaceholder')} className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <input type="date" value={driverField(s, 'license_expiry')} onChange={(e) => setDriverField(s.id, 'license_expiry', e.target.value)}
                      className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <input value={driverField(s, 'cnic_number')} onChange={(e) => setDriverField(s.id, 'cnic_number', e.target.value)}
                      placeholder={t('vr.cnicPlaceholder')} className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <input type="date" value={driverField(s, 'date_of_birth')} onChange={(e) => setDriverField(s.id, 'date_of_birth', e.target.value)}
                      className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <select value={driverField(s, 'blood_group')} onChange={(e) => setDriverField(s.id, 'blood_group', e.target.value)} className="px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] col-span-2">
                      <option value="">{t('mv.bloodGroupLabel')}</option>
                      {BLOOD_GROUPS.map((bg) => <option key={bg} value={bg}>{bg}</option>)}
                    </select>
                  </div>
                  <button onClick={() => saveDriverDetails(s)} className="mt-1.5 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('action.save')}</button>
                  <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                    <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.driverPhotoLabel')} required={false} onUpload={(path) => uploadDriverFile(s.id, 'photo_url', path)} />
                    <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('mv.medicalReportLabel')} required={false} onUpload={(path) => uploadDriverFile(s.id, 'medical_report_url', path)} />
                  </div>
                </div>
              ))}
            </div>
          )}
          </FleetPanel>
          </>
          )}

          {tab === 'permissions' && (
          <>
          {/* 885: delegate a specific capability to a trusted role —
              no row at all means today's exact owner-only behavior, so
              checking a box here can only widen access, never narrow it. */}
          <FleetPanel>
            <FleetPanelHead icon={<ShieldCheck size={14} />} title={t('mv.permissionsHeading')} description={t('mv.permissionsHint')} />
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="bg-[#F9F9F6] border-b border-[#f1f5f9]">
                    <th className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] px-3.5 py-2 text-start">{t('mv.staffColumnLabel')}</th>
                    {PERMISSION_MODULES.map((m) => (
                      <th key={m} className="font-sans text-[9.5px] font-bold uppercase tracking-[0.05em] text-[#94a3b8] py-2 text-center px-2">{t(`mv.permModule.${m}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSION_ROLES.map((role) => (
                    <tr key={role} className="border-t border-[#f1f5f9]">
                      <td className="font-sans text-[11.5px] font-semibold text-[#1e293b] px-3.5 py-2">{t(`mv.role.${role}`)}</td>
                      {PERMISSION_MODULES.map((module) => {
                        const perm = permissions.find((p) => p.role === role && p.module === module)
                        return (
                          <td key={module} className="text-center py-2">
                            <input type="checkbox" checked={perm?.can_edit ?? false} onChange={(e) => togglePermission(role, module, e.target.checked)} className="cursor-pointer accent-[#166534]" />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* 2026-11-20: Accountant is now blocked from booking writes
                (create/cancel/reschedule/board/no-show/alight/close-stop)
                by default, server-side — the "Bookings" column is what
                re-enables it for that role on this fleet. The other 3
                roles were never restricted, so toggling it for them is
                a no-op — stated plainly rather than hidden. */}
            <p className="font-sans text-[10.5px] text-[#64748b] px-3.5">{t('mv.bookingsPermHint')}</p>
            {/* 2026-11-21: real gap found live — every non-driver staff
                role could edit a route's schedule or close/relaunch it
                entirely, a dispatch-level decision. "Schedule" is the
                opposite direction from Bookings: OFF by default for
                every role (owner-only) until explicitly turned on here. */}
            <p className="font-sans text-[10.5px] text-[#64748b] px-3.5 pb-3">{t('mv.schedulePermHint')}</p>
          </FleetPanel>

          {/* 885: a real audit trail for sensitive fleet actions —
              staff/payroll/cash changes, bookings cancelled. */}
          <FleetPanel>
            <FleetPanelHead icon={<History size={14} />} title={t('mv.auditLogHeading')} description={t('mv.panelDesc.auditLog')}
              action={<button onClick={() => setShowAudit((v) => !v)} className="px-2.5 py-1 rounded-lg border border-[#e5e2d0] font-sans text-[11px] text-[#166534] font-semibold cursor-pointer">{showAudit ? t('action.showLess') : t('action.showMore')}</button>} />
            {showAudit && (
              auditLog.length === 0 ? (
                <p className="font-sans text-[11.5px] text-[#94a3b8] text-center py-4">{t('mv.noAuditEntriesHint')}</p>
              ) : (
                <div className="flex flex-col divide-y divide-[#f1f5f9]">
                  {auditLog.map((e) => (
                    <div key={e.id} className="flex items-start justify-between gap-2 px-3.5 py-2">
                      <div className="min-w-0">
                        <p className="font-sans text-[11.5px] font-semibold text-[#1e293b]">{t(`mv.auditAction.${e.action}`)}</p>
                        <p className="font-sans text-[10.5px] text-[#94a3b8]">{e.actor_name ?? '—'}</p>
                      </div>
                      <span className="font-sans text-[10px] text-[#94a3b8] shrink-0 ltr-num">{new Date(e.created_at).toLocaleString(isUrdu ? 'ur-PK' : 'en-PK', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    </div>
                  ))}
                </div>
              )
            )}
          </FleetPanel>
          </>
          )}
        </>
      )}
    </div>
  )
}
