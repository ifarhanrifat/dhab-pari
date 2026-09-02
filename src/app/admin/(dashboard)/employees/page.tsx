'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'
import {
  HardHat, PlusCircle, X, Pencil, Power, PauseCircle, Banknote,
  FileText, Printer, Download, HandCoins, Settings2, Receipt,
} from 'lucide-react'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'
import { nodeToPdfBlob, nodeToPngBlob, printBlob, downloadBlob, getPreferredFormat, setPreferredFormat, getPreferredSlipTarget, setPreferredSlipTarget, type ReceiptFormat } from '@/lib/receiptExport'
import { HiringRequestDocument, type HiringRequestData } from '@/components/admin/HiringRequestDocument'
import { PayslipDocument, type PayslipData } from '@/components/admin/PayslipDocument'
import { ReceiptDocument, type ReceiptData } from '@/components/admin/ReceiptDocument'
import type { SlipFormat } from '@/components/admin/UniversalSlip'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const slipMonthName = (m: number) => new Date(2000, m - 1, 1).toLocaleString('en', { month: 'long' })

interface EmployeeRole { key: string; label_en: string; label_ur: string; is_active: boolean }
interface Employee {
  id: string; name: string; phone: string | null; cnic: string | null
  primary_role: string; secondary_role: string | null
  monthly_salary: number; is_active: boolean; salary_schedule_id: string | null
}

const emptyForm = { name: '', phone: '', cnic: '', primary_role: '', secondary_role: '', monthly_salary: 0, is_active: true }

// WS-4004 deliberately not queried anymore — advances now route through each
// employee's own ledger account (migration 103) instead of a pooled one.
const ACCOUNT_CODES = ['WS-1001', 'WS-1002', 'WS-3001', 'WS-3011', 'WS-3012', 'WS-3013', 'WS-3014']
const today = () => new Date().toISOString().slice(0, 10)
const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

export default function EmployeesPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeRoles, setEmployeeRoles] = useState<EmployeeRole[]>([])
  const [accountsByCode, setAccountsByCode] = useState<Record<string, string>>({})
  const [employeeAccountIds, setEmployeeAccountIds] = useState<Record<string, string>>({})
  const [employeeBalances, setEmployeeBalances] = useState<Record<string, number>>({})
  const [branding, setBranding] = useState<Partial<BrandingSettings>>({})
  const [loading, setLoading] = useState(true)

  const roleLabelEn = (key: string) => employeeRoles.find((r) => r.key === key)?.label_en ?? key
  const activeRoles = employeeRoles.filter((r) => r.is_active)

  const [formTarget, setFormTarget] = useState<Employee | 'new' | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  const [advanceTarget, setAdvanceTarget] = useState<Employee | null>(null)
  const [advanceForm, setAdvanceForm] = useState({ amount: 0, method: 'cash', date: today(), note: '' })
  const [givingAdvance, setGivingAdvance] = useState(false)

  const [showManageRoles, setShowManageRoles] = useState(false)
  const [newRole, setNewRole] = useState({ label_en: '', label_ur: '' })
  const [savingRole, setSavingRole] = useState(false)

  // Every employee needs their own ledger account (migration 103) — lazily
  // provisions any missing ones, then returns id -> live balance (credit-
  // normal: opening_balance + Σcredit − Σdebit, same formula every other
  // account balance in this app already uses).
  const ensureAllEmployeeAccounts = async (emps: Employee[]) => {
    const { data: existingAccounts } = await supabase.from('accounts')
      .select('id, employee_id, opening_balance').not('employee_id', 'is', null)
    const byEmployee: Record<string, string> = {}
    const opening: Record<string, number> = {}
    ;(existingAccounts ?? []).forEach((a) => { byEmployee[a.employee_id as string] = a.id; opening[a.id] = a.opening_balance })

    const missing = emps.filter((e) => !byEmployee[e.id])
    for (const e of missing) {
      const { data: accountId } = await supabase.rpc('ensure_employee_account', { p_employee_id: e.id })
      if (accountId) { byEmployee[e.id] = accountId; opening[accountId] = 0 }
    }

    const accountIds = Object.values(byEmployee)
    const balances: Record<string, number> = {}
    if (accountIds.length > 0) {
      const { data: ledger } = await supabase.from('ledger_entries').select('account_id, debit, credit').in('account_id', accountIds)
      const net: Record<string, number> = {}
      ;(ledger ?? []).forEach((l) => { net[l.account_id] = (net[l.account_id] ?? 0) + Number(l.credit) - Number(l.debit) })
      Object.entries(byEmployee).forEach(([empId, accId]) => { balances[empId] = (opening[accId] ?? 0) + (net[accId] ?? 0) })
    }
    setEmployeeAccountIds(byEmployee)
    setEmployeeBalances(balances)
  }

  const load = async () => {
    setLoading(true)
    const [{ data: emp }, { data: rolesData }, { data: accts }, brandingData] = await Promise.all([
      supabase.from('employees').select('*').order('created_at', { ascending: false }),
      supabase.from('employee_roles').select('*').order('label_en'),
      supabase.from('accounts').select('id, code').eq('system', 'water_supply').in('code', ACCOUNT_CODES),
      fetchBrandingSettings(),
    ])
    const emps = (emp ?? []) as Employee[]
    setEmployees(emps)
    setEmployeeRoles(rolesData ?? [])
    setAccountsByCode(Object.fromEntries((accts ?? []).map((a) => [a.code, a.id])))
    setBranding(brandingData)
    await ensureAllEmployeeAccounts(emps)
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const nextMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString() }

  const openAdd = () => { setForm({ ...emptyForm, primary_role: activeRoles[0]?.key ?? '' }); setFormTarget('new') }
  const openEdit = (e: Employee) => {
    setForm({
      name: e.name, phone: e.phone || '', cnic: e.cnic || '',
      primary_role: e.primary_role, secondary_role: e.secondary_role || '',
      monthly_salary: e.monthly_salary, is_active: e.is_active,
    })
    setFormTarget(e)
  }

  const saveEmployee = async () => {
    if (!form.name.trim()) { toast.error(t('em.enterName')); return }
    if (!form.primary_role) { toast.error(t('em.selectPrimaryRole')); return }
    if (form.secondary_role && form.secondary_role === form.primary_role) { toast.error(t('em.secondaryRoleDiffer')); return }
    setSaving(true)

    const payload = {
      name: form.name.trim(), phone: form.phone || null, cnic: form.cnic || null,
      primary_role: form.primary_role, secondary_role: form.secondary_role || null,
      monthly_salary: form.monthly_salary, is_active: form.is_active,
    }

    if (formTarget === 'new') {
      const { data, error } = await supabase.from('employees').insert(payload).select('id').single()
      if (error) { toast.error(friendlyError(error)); setSaving(false); return }

      if (form.monthly_salary > 0 && accountsByCode['WS-3001']) {
        const { data: employeeAccountId } = await supabase.rpc('ensure_employee_account', { p_employee_id: data.id })
        if (employeeAccountId) {
          const { data: sched, error: schedErr } = await supabase.from('recurring_schedules').insert({
            system: 'water_supply', schedule_type: 'expense', frequency: 'monthly', next_run_date: nextMonth(),
            from_account_id: employeeAccountId, to_account_id: accountsByCode['WS-3001'],
            party_name: payload.name, particular: `Monthly Salary — ${roleLabelEn(form.primary_role)}`,
            amount_pkr: form.monthly_salary, employee_id: data.id,
          }).select('id').single()
          if (!schedErr && sched) {
            await supabase.from('employees').update({ salary_schedule_id: sched.id }).eq('id', data.id)
          }
        }
      }
      toast.success(t('em.employeeAdded'))
    } else if (formTarget) {
      const { error } = await supabase.from('employees').update(payload).eq('id', formTarget.id)
      if (error) { toast.error(friendlyError(error)); setSaving(false); return }

      if (formTarget.salary_schedule_id) {
        await supabase.from('recurring_schedules').update({
          amount_pkr: form.monthly_salary, is_active: form.is_active && form.monthly_salary > 0,
          particular: `Monthly Salary — ${roleLabelEn(form.primary_role)}`,
        }).eq('id', formTarget.salary_schedule_id)
      } else if (form.monthly_salary > 0 && form.is_active && accountsByCode['WS-3001']) {
        const { data: employeeAccountId } = await supabase.rpc('ensure_employee_account', { p_employee_id: formTarget.id })
        if (employeeAccountId) {
          const { data: sched } = await supabase.from('recurring_schedules').insert({
            system: 'water_supply', schedule_type: 'expense', frequency: 'monthly', next_run_date: nextMonth(),
            from_account_id: employeeAccountId, to_account_id: accountsByCode['WS-3001'],
            party_name: payload.name, particular: `Monthly Salary — ${roleLabelEn(form.primary_role)}`,
            amount_pkr: form.monthly_salary, employee_id: formTarget.id,
          }).select('id').single()
          if (sched) await supabase.from('employees').update({ salary_schedule_id: sched.id }).eq('id', formTarget.id)
        }
      }
      toast.success(t('em.employeeUpdated'))
    }

    setSaving(false)
    setFormTarget(null)
    load()
  }

  const openAdvance = (e: Employee) => {
    setAdvanceForm({ amount: 0, method: 'cash', date: today(), note: '' })
    setAdvanceTarget(e)
  }

  // Same shape as the payslip's payment leg below: Dr employee's own account
  // (reduces/goes negative — they now owe the committee back), Cr Cash/Bank.
  // 'advance' voucher_type (not 'withdrawal') to keep it a distinct, familiar
  // category in reports — both are in the approval-gated type list.
  const giveAdvance = async () => {
    if (!advanceTarget) return
    if (advanceForm.amount <= 0) { toast.error(t('em.enterAmount')); return }
    const fromCode = advanceForm.method === 'cash' ? 'WS-1001' : 'WS-1002'
    const fromId = accountsByCode[fromCode]
    const toId = employeeAccountIds[advanceTarget.id]
    if (!fromId || !toId) { toast.error(t('em.accountNotFound')); return }

    setGivingAdvance(true)
    const { error } = await supabase.from('vouchers').insert({
      system: 'water_supply', voucher_type: 'advance', voucher_date: advanceForm.date,
      particular: `Advance to ${advanceTarget.name}${advanceForm.note ? ' — ' + advanceForm.note : ''}`,
      amount_pkr: advanceForm.amount, from_account_id: fromId, to_account_id: toId,
      employee_id: advanceTarget.id, party_name: advanceTarget.name,
    })
    setGivingAdvance(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('em.advanceRecorded'))
    setAdvanceTarget(null)
    load()
  }

  const toggleActive = async (e: Employee) => {
    const nextActive = !e.is_active
    const { error } = await supabase.from('employees').update({ is_active: nextActive }).eq('id', e.id)
    if (error) { toast.error(friendlyError(error)); return }
    if (e.salary_schedule_id) {
      await supabase.from('recurring_schedules').update({ is_active: nextActive }).eq('id', e.salary_schedule_id)
    }
    toast.success(nextActive ? t('em.activatedResumed') : t('em.deactivatedPaused'))
    load()
  }

  const addRole = async () => {
    if (!newRole.label_en.trim() || !newRole.label_ur.trim()) { toast.error(t('em.enterBothLabels')); return }
    const key = slugify(newRole.label_en)
    if (!key) { toast.error(t('em.enterValidLabel')); return }
    setSavingRole(true)
    const { error } = await supabase.from('employee_roles').insert({ key, label_en: newRole.label_en.trim(), label_ur: newRole.label_ur.trim() })
    if (error) { toast.error(friendlyError(error)); setSavingRole(false); return }
    await supabase.from('message_templates').insert([
      { key: `hiring_${key}_requirements`, label: `Hiring Request — ${newRole.label_en.trim()} — Requirements`, body: '' },
      { key: `hiring_${key}_procedure`, label: `Hiring Request — ${newRole.label_en.trim()} — Working Procedure`, body: '' },
      { key: `hiring_${key}_skills`, label: `Hiring Request — ${newRole.label_en.trim()} — Technical Skills`, body: '' },
    ])
    setSavingRole(false)
    setNewRole({ label_en: '', label_ur: '' })
    toast.success(t('em.roleAdded'))
    load()
  }

  const toggleRoleActive = async (r: EmployeeRole) => {
    const { error } = await supabase.from('employee_roles').update({ is_active: !r.is_active }).eq('key', r.key)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
            <HardHat size={26} /> {t('em.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('em.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowManageRoles(true)} className="flex items-center gap-2 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
            <Settings2 size={16} /> {t('em.manageRoles')}
          </button>
          <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <PlusCircle size={16} /> {t('em.addEmployee')}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-8">
        {loading ? (
          <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>
        ) : employees.length === 0 ? (
          <p className="px-5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('em.noEmployees')}</p>
        ) : (
          <div className="divide-y divide-dp-outline-variant">
            {employees.map((e) => {
              const balance = employeeBalances[e.id] ?? 0
              return (
                <div key={e.id} className="p-4 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{e.name}</p>
                      <span className="px-2 py-0.5 rounded-full bg-dp-primary-container text-dp-secondary text-[10.5px] font-bold uppercase tracking-wide">{roleLabelEn(e.primary_role)}</span>
                      {e.secondary_role && <span className="px-2 py-0.5 rounded-full bg-dp-surface-container-low text-dp-on-surface-variant text-[10.5px] font-bold uppercase tracking-wide">{roleLabelEn(e.secondary_role)}</span>}
                      {!e.is_active && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10.5px] font-bold uppercase tracking-wide">{t('em.inactive')}</span>}
                      {balance > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10.5px] font-bold uppercase tracking-wide">{t('em.owed')} {balance.toLocaleString()}</span>}
                      {balance < 0 && <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10.5px] font-bold uppercase tracking-wide">{t('em.owesCommittee')} {Math.abs(balance).toLocaleString()}</span>}
                    </div>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {e.phone && `${e.phone} · `}{t('em.salaryPrefix')} {e.monthly_salary.toLocaleString()}/mo{e.salary_schedule_id && e.is_active ? ` · ${t('em.recurringActiveSuffix')}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    <button onClick={() => openAdvance(e)} title={t('em.giveAdvanceTitle')} className="flex items-center gap-1 px-2.5 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[12px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer"><HandCoins size={13} /> {t('em.advance')}</button>
                    <PayslipButton
                      employee={e} roleLabelEn={roleLabelEn} accountsByCode={accountsByCode}
                      employeeAccountId={employeeAccountIds[e.id]} branding={branding} onSettled={load}
                    />
                    <button onClick={() => openEdit(e)} title={t('em.editTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
                    <button onClick={() => toggleActive(e)} title={e.is_active ? t('em.deactivateTitle') : t('em.activateTitle')} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
                      {e.is_active ? <PauseCircle size={15} /> : <Power size={15} />}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <HiringRequestGenerator employees={employees} employeeRoles={activeRoles} branding={branding} />

      {formTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setFormTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{formTarget === 'new' ? t('em.addEmployeeTitle') : t('em.editEmployeeTitle')}</h2>
              <button onClick={() => setFormTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.name')}</label>
                <input autoFocus value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.phoneOptional')}</label>
                  <input value={form.phone} onChange={(ev) => setForm({ ...form, phone: ev.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.cnicOptional')}</label>
                  <input value={form.cnic} onChange={(ev) => setForm({ ...form, cnic: ev.target.value })} className="input-field" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('em.primaryRole')}</label>
                  <select value={form.primary_role} onChange={(ev) => setForm({ ...form, primary_role: ev.target.value })} className="input-field">
                    <option value="">{t('em.selectRole')}</option>
                    {activeRoles.map((r) => <option key={r.key} value={r.key}>{r.label_en}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.secondaryOptional')}</label>
                  <select value={form.secondary_role} onChange={(ev) => setForm({ ...form, secondary_role: ev.target.value })} className="input-field">
                    <option value="">{t('us.none')}</option>
                    {activeRoles.filter((r) => r.key !== form.primary_role).map((r) => <option key={r.key} value={r.key}>{r.label_en}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.monthlySalary')}</label>
                <input type="number" min={0} value={form.monthly_salary || ''} onChange={(ev) => setForm({ ...form, monthly_salary: +ev.target.value })} className="input-field" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('em.accruesNote')}</p>
              </div>
              {formTarget !== 'new' && (
                <label className="flex items-center gap-2 font-sans text-[13px] text-dp-on-surface cursor-pointer">
                  <input type="checkbox" checked={form.is_active} onChange={(ev) => setForm({ ...form, is_active: ev.target.checked })} /> {t('em.active')}
                </label>
              )}
              <button disabled={saving} onClick={saveEmployee} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {saving ? t('em.saving') : t('em.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {advanceTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setAdvanceTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary flex items-center gap-2"><HandCoins size={18} /> {t('em.giveAdvance')}</h2>
              <button onClick={() => setAdvanceTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-4">{advanceTarget.name}</p>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('em.amountRs')}</label>
                <input autoFocus type="number" min={1} value={advanceForm.amount || ''} onChange={(ev) => setAdvanceForm({ ...advanceForm, amount: +ev.target.value })} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('em.paidFrom')}</label>
                  <select value={advanceForm.method} onChange={(ev) => setAdvanceForm({ ...advanceForm, method: ev.target.value })} className="input-field">
                    <option value="cash">{t('w.cash')}</option>
                    <option value="bank">{t('a.bank')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.date')}</label>
                  <input type="date" value={advanceForm.date} onChange={(ev) => setAdvanceForm({ ...advanceForm, date: ev.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.noteOptional')}</label>
                <input value={advanceForm.note} onChange={(ev) => setAdvanceForm({ ...advanceForm, note: ev.target.value })} className="input-field" />
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('em.reducesNote')}</p>
              <button disabled={givingAdvance} onClick={giveAdvance} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <HandCoins size={15} /> {givingAdvance ? t('em.recording') : t('em.giveAdvanceTitle')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showManageRoles && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowManageRoles(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('em.manageRoles')}</h2>
              <button onClick={() => setShowManageRoles(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-2 mb-5 max-h-56 overflow-y-auto">
              {employeeRoles.map((r) => (
                <div key={r.key} className="flex items-center justify-between px-3 py-2 border border-dp-outline-variant rounded-lg">
                  <div>
                    <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{r.label_en}</p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{r.label_ur}</p>
                  </div>
                  <button onClick={() => toggleRoleActive(r)} className={`px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide cursor-pointer ${r.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                    {r.is_active ? t('g.active') : t('g.inactive')}
                  </button>
                </div>
              ))}
            </div>
            <div className="border-t border-dp-outline-variant pt-4 space-y-3">
              <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('em.addRole')}</p>
              <input value={newRole.label_en} onChange={(e) => setNewRole({ ...newRole, label_en: e.target.value })} placeholder={t('em.addRolePlaceholderEn')} className="input-field" />
              <input value={newRole.label_ur} onChange={(e) => setNewRole({ ...newRole, label_ur: e.target.value })} placeholder="اردو لیبل" dir="rtl" className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} />
              <button disabled={savingRole} onClick={addRole} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {savingRole ? t('em.adding') : t('em.addRoleBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Role -> its 3 message_templates keys.
const templateKeys = (role: string) => ({
  requirements: `hiring_${role}_requirements`, procedure: `hiring_${role}_procedure`, skills: `hiring_${role}_skills`,
})

function HiringRequestGenerator({ employees, employeeRoles, branding }: { employees: Employee[]; employeeRoles: EmployeeRole[]; branding: Partial<BrandingSettings> }) {
  const { t } = useLocale()
  const supabase = createClient()
  const [role, setRole] = useState('')
  const [bodies, setBodies] = useState({ requirements: '', procedure: '', skills: '' })
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [salary, setSalary] = useState(0)
  const [savingTemplates, setSavingTemplates] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [format, setFormat] = useState<ReceiptFormat>(getPreferredFormat())
  const nodeRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (!role && employeeRoles.length > 0) setRole(employeeRoles[0].key) }, [employeeRoles]) // eslint-disable-line react-hooks/exhaustive-deps

  const roleAverage = useMemo(() => {
    const inRole = employees.filter((e) => e.is_active && (e.primary_role === role || e.secondary_role === role) && e.monthly_salary > 0)
    if (inRole.length === 0) return 0
    return Math.round(inRole.reduce((s, e) => s + e.monthly_salary, 0) / inRole.length)
  }, [employees, role])

  const loadTemplates = async (r: string) => {
    setLoadingTemplates(true)
    const keys = templateKeys(r)
    const { data } = await supabase.from('message_templates').select('key, body').in('key', [keys.requirements, keys.procedure, keys.skills])
    const map = Object.fromEntries((data ?? []).map((t) => [t.key, t.body]))
    setBodies({ requirements: map[keys.requirements] ?? '', procedure: map[keys.procedure] ?? '', skills: map[keys.skills] ?? '' })
    setLoadingTemplates(false)
  }

  useEffect(() => { if (role) { loadTemplates(role); setSalary(roleAverage) } }, [role]) // eslint-disable-line react-hooks/exhaustive-deps

  const roleLabel = (key: string) => employeeRoles.find((r) => r.key === key)
  const currentRole = roleLabel(role)

  const saveTemplates = async () => {
    setSavingTemplates(true)
    const keys = templateKeys(role)
    const updates = [
      supabase.from('message_templates').update({ body: bodies.requirements, updated_at: new Date().toISOString() }).eq('key', keys.requirements),
      supabase.from('message_templates').update({ body: bodies.procedure, updated_at: new Date().toISOString() }).eq('key', keys.procedure),
      supabase.from('message_templates').update({ body: bodies.skills, updated_at: new Date().toISOString() }).eq('key', keys.skills),
    ]
    const results = await Promise.all(updates)
    setSavingTemplates(false)
    if (results.some((r) => r.error)) { toast.error(t('em.couldNotSaveSome')); return }
    toast.success(t('em.savedAsDefault'))
  }

  const docData: HiringRequestData = {
    roleUr: currentRole?.label_ur ?? role, requirements: bodies.requirements, procedure: bodies.procedure,
    skills: bodies.skills, salary, date: new Date().toLocaleDateString('en-GB'),
  }

  const chooseFormat = (f: ReceiptFormat) => { setFormat(f); setPreferredFormat(f) }
  const buildBlob = async () => {
    if (!nodeRef.current) throw new Error('Document not ready')
    return format === 'pdf' ? nodeToPdfBlob(nodeRef.current) : nodeToPngBlob(nodeRef.current)
  }
  const handlePrint = async () => { try { printBlob(await nodeToPdfBlob(nodeRef.current!)) } catch { toast.error(t('em.couldNotPreparePrint')) } }
  const handleDownload = async () => { try { downloadBlob(await buildBlob(), `hiring-request-${role}.${format === 'pdf' ? 'pdf' : 'png'}`) } catch { toast.error(t('em.couldNotPrepareDoc')) } }

  return (
    <div className="bg-white rounded-lg border border-dp-outline-variant p-6">
      <h2 className="font-sans text-[18px] font-bold text-dp-on-surface flex items-center gap-2 mb-1">
        <FileText size={18} /> {t('z.generateHiring')}
      </h2>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('em.hiringSubtitle')}</p>

      <div className="mb-4 max-w-xs">
        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('us.role')}</label>
        <select value={role} onChange={(e) => setRole(e.target.value)} className="input-field">
          {employeeRoles.map((r) => <option key={r.key} value={r.key}>{r.label_en} — {r.label_ur}</option>)}
        </select>
      </div>

      {loadingTemplates ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant py-4"><LoadingDots /></p>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">بنیادی تقاضے (Requirements)</label>
            <textarea dir="rtl" value={bodies.requirements} onChange={(e) => setBodies({ ...bodies, requirements: e.target.value })} rows={3} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif' }} />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">کام کرنے کا طریقہ کار (Working Procedure)</label>
            <textarea dir="rtl" value={bodies.procedure} onChange={(e) => setBodies({ ...bodies, procedure: e.target.value })} rows={3} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif' }} />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">درکار تکنیکی مہارتیں (Technical Skills)</label>
            <textarea dir="rtl" value={bodies.skills} onChange={(e) => setBodies({ ...bodies, skills: e.target.value })} rows={3} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif' }} />
          </div>
          <div className="flex items-end gap-3">
            <div className="max-w-[180px]">
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.salaryRs')}</label>
              <input type="number" min={0} value={salary || ''} onChange={(e) => setSalary(+e.target.value)} className="input-field" />
              <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('em.defaultsToAverage')} {currentRole?.label_en ?? role}{t('em.defaultsToAverageSuffix')} ({roleAverage.toLocaleString()})</p>
            </div>
            <button disabled={savingTemplates} onClick={saveTemplates} className="px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
              {savingTemplates ? t('em.saving') : t('em.saveAsDefaultBtn')}
            </button>
            <button onClick={() => setShowPreview(true)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer ms-auto">
              <FileText size={15} /> {t('z.generateDocument')}
            </button>
          </div>
        </div>
      )}

      {showPreview && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-dp-outline-variant">
              <span className="font-sans text-[14px] font-bold text-dp-primary">{t('z.hiringPreview')}</span>
              <button onClick={() => setShowPreview(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="p-4 flex justify-center bg-dp-surface-container-low/40">
              <HiringRequestDocument ref={nodeRef} data={docData} branding={branding} />
            </div>
            <div className="flex items-center gap-2 px-4 py-3 border-t border-dp-outline-variant">
              <select value={format} onChange={(e) => chooseFormat(e.target.value as ReceiptFormat)} className="input-field !py-1.5 !text-[13px] max-w-[100px]">
                <option value="pdf">PDF</option>
                <option value="png">PNG</option>
              </select>
              <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer"><Printer size={14} /> {t('a.print')}</button>
              <button onClick={handleDownload} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer ms-auto"><Download size={14} /> {t('g.download')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface ExistingPayslip { id: string; recognition_voucher_id: string | null; overtime_amount: number; bonus_amount: number; emergency_amount: number }
interface JobLine { id: string; label: string; amount: number }

// The one real monthly payroll-run action. Opening it for a period that was
// already run loads the existing employee_payslips row (edit path, via
// edit_employee_payslip_recognition — no duplicate voucher); opening it fresh
// creates one. Recognizing (Dr expense accounts, Cr employee's own account)
// and actually paying cash (Dr employee's account, Cr Cash/Bank) are two
// separate, both approval-gated steps — "Pay Now" defaults to the employee's
// full current balance but can be paid down partially.
function PayslipButton({
  employee, roleLabelEn, accountsByCode, employeeAccountId, branding, onSettled,
}: {
  employee: Employee; roleLabelEn: (key: string) => string; accountsByCode: Record<string, string>
  employeeAccountId: string | undefined; branding: Partial<BrandingSettings>; onSettled: () => void
}) {
  const { t } = useLocale()
  const supabase = createClient()
  const now = new Date()
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [loadingPeriod, setLoadingPeriod] = useState(false)
  const [existing, setExisting] = useState<ExistingPayslip | null>(null)
  const [form, setForm] = useState({ overtime: 0, bonus: 0, emergency: 0 })
  const [jobLines, setJobLines] = useState<JobLine[]>([])
  const [salaryAccrued, setSalaryAccrued] = useState(0)
  const [balance, setBalance] = useState(0)
  const [payAmount, setPayAmount] = useState(0)
  const [payMethod, setPayMethod] = useState('cash')
  const [saving, setSaving] = useState(false)
  const [paying, setPaying] = useState(false)
  const [showDoc, setShowDoc] = useState(false)
  const [format, setFormat] = useState<ReceiptFormat>(getPreferredFormat())
  const [slipFormat, setSlipFormat] = useState<SlipFormat>(() => getPreferredSlipTarget() ?? 'a4')
  const nodeRef = useRef<HTMLDivElement>(null)

  const fetchBalance = async () => {
    if (!employeeAccountId) return 0
    const { data: acct } = await supabase.from('accounts').select('opening_balance').eq('id', employeeAccountId).single()
    const { data: ledger } = await supabase.from('ledger_entries').select('debit, credit').eq('account_id', employeeAccountId)
    const net = (ledger ?? []).reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0)
    return (acct?.opening_balance ?? 0) + net
  }

  const loadPeriod = async () => {
    setLoadingPeriod(true)
    try {
      const { data: existingRow } = await supabase.from('employee_payslips')
        .select('id, recognition_voucher_id, overtime_amount, bonus_amount, emergency_amount')
        .eq('employee_id', employee.id).eq('month', month).eq('year', year).maybeSingle()
      setExisting(existingRow ?? null)
      setForm({
        overtime: existingRow?.overtime_amount ?? 0, bonus: existingRow?.bonus_amount ?? 0, emergency: existingRow?.emergency_amount ?? 0,
      })

      const { data: jobs } = await supabase.from('connection_requests')
        .select('id, request_number, consumer_name, plumber_charge, digging_charge')
        .eq('assignee_employee_id', employee.id).eq('status', 'installed').is('employee_charge_settled_at', null)
      setJobLines((jobs ?? [])
        .map((j) => ({ id: j.id, label: `${j.request_number ?? '—'} — ${j.consumer_name}`, amount: (j.plumber_charge || 0) + (j.digging_charge || 0) }))
        .filter((j) => j.amount > 0))

      const monthStart = new Date(year, month - 1, 1).toISOString().slice(0, 10)
      const monthEnd = new Date(year, month, 0).toISOString().slice(0, 10)
      const { data: salaryVouchers } = await supabase.from('vouchers')
        .select('amount_pkr').eq('employee_id', employee.id).eq('to_account_id', accountsByCode['WS-3001'])
        .gte('voucher_date', monthStart).lte('voucher_date', monthEnd)
      setSalaryAccrued((salaryVouchers ?? []).reduce((s, v) => s + v.amount_pkr, 0))

      const bal = await fetchBalance()
      setBalance(bal)
      setPayAmount(Math.max(bal, 0))
    } finally {
      setLoadingPeriod(false)
    }
  }

  useEffect(() => { if (open) loadPeriod() }, [open, month, year]) // eslint-disable-line react-hooks/exhaustive-deps

  const jobTotal = jobLines.reduce((s, j) => s + j.amount, 0)
  const newRecognitionTotal = form.overtime + form.bonus + form.emergency + jobTotal

  const savePayslip = async () => {
    if (!employeeAccountId) { toast.error(t('em.accountNotReady')); return }
    setSaving(true)
    try {
      let payslipId = existing?.id
      let recognitionVoucherId = existing?.recognition_voucher_id ?? null

      if (!payslipId) {
        const { data, error } = await supabase.from('employee_payslips').insert({
          employee_id: employee.id, month, year,
          overtime_amount: form.overtime, bonus_amount: form.bonus, emergency_amount: form.emergency,
        }).select('id').single()
        if (error) { toast.error(friendlyError(error)); return }
        payslipId = data.id
      }

      if (recognitionVoucherId) {
        const { error } = await supabase.rpc('edit_employee_payslip_recognition', {
          p_payslip_id: payslipId, p_overtime: form.overtime, p_bonus: form.bonus, p_emergency: form.emergency,
        })
        if (error) { toast.error(friendlyError(error)); return }
      } else if (newRecognitionTotal > 0) {
        const { data: draft, error: draftErr } = await supabase.from('vouchers').insert({
          system: 'water_supply', voucher_type: 'expense', voucher_date: today(),
          particular: `Payslip Recognition — ${employee.name} — ${month}/${year}`,
          amount_pkr: 0, status: 'draft', employee_id: employee.id, party_name: employee.name,
          from_account_id: employeeAccountId,
        }).select('id').single()
        if (draftErr) { toast.error(friendlyError(draftErr)); return }

        const lines: { voucher_id: string; account_id: string; amount: number; description: string }[] = []
        if (form.overtime > 0) lines.push({ voucher_id: draft.id, account_id: accountsByCode['WS-3012'], amount: form.overtime, description: 'Overtime' })
        if (form.bonus > 0) lines.push({ voucher_id: draft.id, account_id: accountsByCode['WS-3011'], amount: form.bonus, description: 'Eid Bonus' })
        if (form.emergency > 0) lines.push({ voucher_id: draft.id, account_id: accountsByCode['WS-3013'], amount: form.emergency, description: 'Emergency Work Payment' })
        jobLines.forEach((j) => lines.push({ voucher_id: draft.id, account_id: accountsByCode['WS-3014'], amount: j.amount, description: `Job ${j.label}` }))

        const { error: lineErr } = await supabase.from('voucher_line_items').insert(lines)
        if (lineErr) { toast.error(friendlyError(lineErr)); return }

        const { error: finalizeErr } = await supabase.rpc('finalize_voucher', { p_voucher_id: draft.id })
        if (finalizeErr) { toast.error(friendlyError(finalizeErr)); return }

        recognitionVoucherId = draft.id
        await supabase.from('employee_payslips').update({ recognition_voucher_id: draft.id }).eq('id', payslipId)

        if (jobLines.length > 0) {
          const { error: settleErr } = await supabase.from('connection_requests').update({
            employee_charge_settled_at: new Date().toISOString(), employee_charge_voucher_id: draft.id,
          }).in('id', jobLines.map((j) => j.id))
          if (settleErr) toast.error(`Recognized, but couldn't mark jobs as settled: ${settleErr.message}`)
        }
      } else {
        await supabase.from('employee_payslips').update({
          overtime_amount: form.overtime, bonus_amount: form.bonus, emergency_amount: form.emergency,
        }).eq('id', payslipId)
      }

      toast.success(t('em.payslipSaved'))
      setExisting({ id: payslipId!, recognition_voucher_id: recognitionVoucherId, overtime_amount: form.overtime, bonus_amount: form.bonus, emergency_amount: form.emergency })
      const bal = await fetchBalance()
      setBalance(bal)
      setPayAmount(Math.max(bal, 0))
      onSettled()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('em.couldNotSavePayslip'))
    } finally {
      setSaving(false)
    }
  }

  // Distinct from the recognition step above — this just moves cash against
  // an already-recognized balance, not a new expense, so it's voucher_type
  // 'withdrawal' (same approval gate, doesn't re-count as a fresh expense).
  const payNow = async () => {
    if (!employeeAccountId) return
    if (payAmount <= 0) { toast.error(t('em.enterAmount')); return }
    if (payAmount > balance) { toast.error(t('em.cannotPayMore')); return }
    setPaying(true)
    try {
      const fromCode = payMethod === 'cash' ? 'WS-1001' : 'WS-1002'
      const { error } = await supabase.from('vouchers').insert({
        system: 'water_supply', voucher_type: 'withdrawal', voucher_date: today(),
        particular: `Payslip Payment — ${employee.name} — ${month}/${year}`,
        amount_pkr: payAmount, from_account_id: accountsByCode[fromCode], to_account_id: employeeAccountId,
        employee_id: employee.id, party_name: employee.name,
      })
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('em.paymentRecorded'))
      const bal = await fetchBalance()
      setBalance(bal)
      setPayAmount(Math.max(bal, 0))
      onSettled()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('em.couldNotRecordPayment'))
    } finally {
      setPaying(false)
    }
  }

  const docData: PayslipData = {
    employeeName: employee.name, roleEn: roleLabelEn(employee.primary_role), month, year,
    salaryAccrued, overtimeAmount: form.overtime, bonusAmount: form.bonus, emergencyAmount: form.emergency,
    jobLines: jobLines.map((j) => ({ label: j.label, amount: j.amount })), jobTotal,
    balanceOwed: balance, amountPaidNow: payAmount, balanceCarriedForward: Math.max(balance - payAmount, 0),
  }

  // The Universal Slip carries the payroll body; the ten legacy skins have no
  // payroll layout, so whenever one of those is selected the original
  // PayslipDocument still renders. Same numbers feed both.
  const useUniversal = branding.invoiceTemplate === 'universal'
  const slipData: ReceiptData = {
    ...branding,
    kind: 'salary',
    receiptNo: `SLP-${String(month).padStart(2, '0')}${year}-${employee.id.slice(0, 4).toUpperCase()}`,
    date: new Date().toISOString().slice(0, 10),
    systemLabel: 'Payroll',
    accountName: employee.name,
    billingPeriod: `${slipMonthName(month)} ${year}`,
    particular: `Payslip — ${slipMonthName(month)} ${year}`,
    amount: payAmount,
    balanceAfter: Math.max(balance - payAmount, 0),
    payroll: {
      designation: roleLabelEn(employee.primary_role),
      earnings: [
        { label: 'Salary Accrued', amount: salaryAccrued },
        { label: 'Overtime', amount: form.overtime },
        { label: 'Eid Bonus', amount: form.bonus },
        { label: 'Emergency Work', amount: form.emergency },
        ...jobLines.map((j) => ({ label: `Job — ${j.label}`, amount: j.amount })),
      ].filter((e) => e.amount > 0),
      totalEarnings: salaryAccrued + form.overtime + form.bonus + form.emergency + jobTotal,
      balanceOwed: balance,
      paidNow: payAmount,
      carriedForward: Math.max(balance - payAmount, 0),
    },
  }

  const buildBlob = async () => {
    if (!nodeRef.current) throw new Error('Document not ready')
    return format === 'pdf' ? nodeToPdfBlob(nodeRef.current) : nodeToPngBlob(nodeRef.current)
  }
  const handlePrint = async () => { try { printBlob(await nodeToPdfBlob(nodeRef.current!)) } catch { toast.error(t('em.couldNotPreparePrint')) } }
  const handleDownload = async () => { try { downloadBlob(await buildBlob(), `payslip-${employee.name}-${month}-${year}.${format === 'pdf' ? 'pdf' : 'png'}`) } catch { toast.error(t('em.couldNotPrepareDoc')) } }

  return (
    <>
      <button onClick={() => { setShowDoc(false); setOpen(true) }} title={t('em.generatePayslipTitle')} className="flex items-center gap-1 px-2.5 py-1.5 border border-dp-secondary/40 text-dp-secondary rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-secondary/5 transition-all cursor-pointer">
        <Receipt size={13} /> {t('em.payslip')}
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-lg max-h-[92vh] overflow-y-auto w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-dp-outline-variant">
              <span className="font-sans text-[14px] font-bold text-dp-primary">{t('em.payslipPrefix')} — {employee.name}</span>
              <button onClick={() => setOpen(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 max-w-xs">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.month')}</label>
                  <select value={month} onChange={(e) => setMonth(+e.target.value)} className="input-field">
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleString('en', { month: 'long' })}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.year')}</label>
                  <input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="input-field" />
                </div>
              </div>

              {loadingPeriod ? (
                <p className="font-sans text-[13.5px] text-dp-on-surface-variant py-4"><LoadingDots /></p>
              ) : (
                <>
                  {existing?.recognition_voucher_id && (
                    <p className="font-sans text-[12px] text-dp-secondary bg-dp-secondary/5 border border-dp-secondary/20 rounded-lg px-3 py-2">
                      {t('em.alreadyRunNote')}
                    </p>
                  )}
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('z.salaryAccrued')} <span className="font-semibold text-dp-on-surface">{salaryAccrued.toLocaleString()}</span></p>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.overtimeRs')}</label>
                      <input type="number" min={0} value={form.overtime || ''} onChange={(e) => setForm({ ...form, overtime: +e.target.value })} className="input-field" />
                    </div>
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.eidBonus')}</label>
                      <input type="number" min={0} value={form.bonus || ''} onChange={(e) => setForm({ ...form, bonus: +e.target.value })} className="input-field" />
                    </div>
                    <div>
                      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.emergencyRs')}</label>
                      <input type="number" min={0} value={form.emergency || ''} onChange={(e) => setForm({ ...form, emergency: +e.target.value })} className="input-field" />
                    </div>
                  </div>

                  {jobLines.length > 0 && (
                    <div>
                      <p className="font-sans text-[12px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-1.5">{t('z.jobEarnings')}</p>
                      <div className="space-y-1">
                        {jobLines.map((j) => (
                          <div key={j.id} className="flex justify-between font-sans text-[13px] px-3 py-1.5 bg-dp-surface-container-low/50 rounded">
                            <span>{j.label}</span><span>{j.amount.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button disabled={saving} onClick={savePayslip} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    {saving ? t('em.saving') : existing?.recognition_voucher_id ? t('em.updatePayslip') : t('em.savePayslip')}
                  </button>

                  <div className="border-t border-dp-outline-variant pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-sans text-[14px] font-bold text-dp-on-surface">{t('em.balanceOwedPrefix')} {balance.toLocaleString()}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 items-end">
                      <div>
                        <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.payNowRs')}</label>
                        <input type="number" min={0} max={Math.max(balance, 0)} value={payAmount || ''} onChange={(e) => setPayAmount(+e.target.value)} className="input-field" />
                      </div>
                      <div>
                        <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.from')}</label>
                        <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="input-field">
                          <option value="cash">{t('w.cash')}</option>
                          <option value="bank">{t('a.bank')}</option>
                        </select>
                      </div>
                      <button disabled={paying || balance <= 0} onClick={payNow} className="flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                        <Banknote size={15} /> {paying ? t('em.paying') : t('em.payNow')}
                      </button>
                    </div>
                  </div>

                  <button onClick={() => setShowDoc(true)} className="flex items-center gap-2 text-dp-secondary font-sans text-[13px] font-semibold hover:underline cursor-pointer">
                    <FileText size={15} /> {t('z.viewPayslip')}
                  </button>
                </>
              )}
            </div>

            {showDoc && (
              <>
                <div className="p-4 flex justify-center bg-dp-surface-container-low/40 border-t border-dp-outline-variant">
                  {useUniversal
                    ? <ReceiptDocument ref={nodeRef} data={slipData} template="universal" format={slipFormat} />
                    : <PayslipDocument ref={nodeRef} data={docData} branding={branding} />}
                </div>
                <div className="flex items-center gap-2 px-4 py-3 border-t border-dp-outline-variant">
                  <select value={format} onChange={(e) => { setFormat(e.target.value as ReceiptFormat); setPreferredFormat(e.target.value as ReceiptFormat) }} className="input-field !py-1.5 !text-[13px] max-w-[100px]">
                    <option value="pdf">PDF</option>
                    <option value="png">PNG</option>
                  </select>
                  {useUniversal && (
                    <select value={slipFormat} onChange={(e) => { setSlipFormat(e.target.value as SlipFormat); setPreferredSlipTarget(e.target.value as SlipFormat) }} className="input-field !py-1.5 !text-[13px] max-w-[130px]">
                      <option value="a4">A4</option>
                      <option value="thermal">{t('em.thermal')}</option>
                    </select>
                  )}
                  <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer"><Printer size={14} /> {t('a.print')}</button>
                  <button onClick={handleDownload} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer ms-auto"><Download size={14} /> {t('g.download')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
