'use client'

// 860: Fleet Staff sub-page, reached from the Dashboard tab's quick
// links. Carries over the existing staff add/remove/counter-assign UI
// (854/855) unchanged, plus the new salary tracking (migration 860):
// set a monthly salary and record a payment, both owner-only, same
// "full equal access, minus staff/salary management" split fleet_staff
// has always had.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, UserPlus, Users2, ShieldCheck, History } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetStat } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface StaffMember {
  id: string; portal_user_id: string; full_name: string; counter_id: string | null; counter_city: string | null; counter_name: string | null
  role: string; commission_amount_pkr: number | null; commission_this_month_pkr: number; current_monthly_salary_pkr: number | null
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

const PERMISSION_ROLES = ['booking_officer', 'terminal_manager', 'accountant', 'other'] as const
const PERMISSION_MODULES = ['staff_payroll', 'cash'] as const

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

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f?.is_owner) {
      const [{ data: s }, { data: c }, { data: p }, { data: a }] = await Promise.all([
        supabase.rpc('my_fleet_staff', { p_fleet_id: f.fleet_id }),
        supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_role_permissions_matrix', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_audit_log_recent', { p_fleet_id: f.fleet_id, p_limit: 50 }),
      ])
      setStaff((s ?? []) as StaffMember[])
      setCounters((c ?? []) as Counter[])
      setPermissions((p ?? []) as RolePermission[])
      setAuditLog((a ?? []) as AuditEntry[])
    }
    setLoading(false)
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

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

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
          <div className="grid grid-cols-2 gap-2.5">
            <FleetStat label={t('mv.statActiveEmployeesLabel')} value={staff.length} icon={<Users2 size={12} />} />
            <FleetStat label={t('mv.statDriversLabel')} value={staff.filter((s) => s.role === 'driver').length} />
            <FleetStat label={t('mv.statMonthlyPayrollLabel')} value={`₨${fmt(staff.reduce((sum, s) => sum + (s.current_monthly_salary_pkr ?? 0), 0))}`} />
            <FleetStat label={t('mv.statCommissionPayableLabel')} value={`₨${fmt(staff.reduce((sum, s) => sum + s.commission_this_month_pkr, 0))}`} valueClassName="text-[#b45309]" />
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
            </FleetPanelBody>
          </FleetPanel>

          <FleetPanel>
            <FleetPanelHead icon={<Users2 size={14} />} title={t('mv.fleetStaffHeading')} description={t('mv.panelDesc.staff')}
              action={<span className="px-2 py-0.5 rounded-full bg-[#F0FDF4] text-[#166534] font-sans text-[10px] font-bold ltr-num">{staff.length}</span>} />
          {staff.length === 0 ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noStaffYetHint')}</p>
          ) : (
            <div className="flex flex-col divide-y divide-[#f1f5f9]">
              {staff.map((s) => (
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
                  {/* 2026-11-17: Staff screen rebuild — real gap found
                      reading the code: set_fleet_staff_salary (860)
                      could be called, but nothing ever showed what
                      salary was currently on file for anyone. */}
                  <p className="font-sans text-[11px] text-[#64748b] mt-2 pt-2 border-t border-[#f1f5f9]">
                    {t('mv.payPlanLabel')}: <span className="font-semibold text-[#1e293b] ltr-num">{s.current_monthly_salary_pkr != null ? `₨${fmt(s.current_monthly_salary_pkr)} ${t('mv.perMonthSuffixLabel')}` : t('mv.noSalarySetHint')}</span>
                  </p>
                  <div className="flex gap-2 mt-1.5">
                    <input type="number" value={salaryDraft[s.id] ?? ''} onChange={(e) => setSalaryDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      placeholder={t('mv.monthlySalaryPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <button onClick={() => saveSalary(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('mv.setSalaryBtn')}</button>
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
                  {/* 888: a real driver registration — licence, CNIC, DOB,
                      blood group, medical report, photo — the same
                      information /my-vehicle/register already collects
                      for a self-registering driver, now available right
                      here for a driver added as staff. */}
                  {s.role === 'driver' && (
                    <div className="mt-2 pt-2 border-t border-[#f1f5f9] flex flex-col gap-1.5">
                      <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#64748b]">{t('mv.driverDetailsHeading')}</p>
                      <div className="grid grid-cols-2 gap-1.5">
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
                      <button onClick={() => saveDriverDetails(s)} className="px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('action.save')}</button>
                      <div className="grid grid-cols-2 gap-1.5 mt-1">
                        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.driverPhotoLabel')} required={false} onUpload={(path) => uploadDriverFile(s.id, 'photo_url', path)} />
                        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('mv.medicalReportLabel')} required={false} onUpload={(path) => uploadDriverFile(s.id, 'medical_report_url', path)} />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          </FleetPanel>

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
    </div>
  )
}
