'use client'

// 860: Fleet Staff sub-page, reached from the Dashboard tab's quick
// links. Carries over the existing staff add/remove/counter-assign UI
// (854/855) unchanged, plus the new salary tracking (migration 860):
// set a monthly salary and record a payment, both owner-only, same
// "full equal access, minus staff/salary management" split fleet_staff
// has always had.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface StaffMember { id: string; portal_user_id: string; full_name: string; counter_id: string | null; counter_city: string | null; counter_name: string | null }
interface Counter { id: string; city: string; name: string | null }

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

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f?.is_owner) {
      const [{ data: s }, { data: c }] = await Promise.all([
        supabase.rpc('my_fleet_staff', { p_fleet_id: f.fleet_id }),
        supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id }),
      ])
      setStaff((s ?? []) as StaffMember[])
      setCounters((c ?? []) as Counter[])
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
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.fleetStaffHint')}</p>
            <div className="flex gap-2">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('mv.driverPhonePlaceholder')}
                className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              <button onClick={addStaff} disabled={adding} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                {adding ? t('action.loading') : t('mv.addStaffBtn')}
              </button>
            </div>
          </div>

          {staff.length === 0 ? (
            <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noStaffYetHint')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {staff.map((s) => (
                <div key={s.id} className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[13px] font-bold text-[#1e293b]">{s.full_name}</span>
                    <button onClick={() => removeStaff(s.portal_user_id)} className="font-sans text-[11px] font-bold text-[#b91c1c] cursor-pointer">{t('action.remove')}</button>
                  </div>
                  {counters.length > 0 && (
                    <select value={s.counter_id ?? ''} onChange={(e) => assignCounter(s.portal_user_id, e.target.value)} className="mt-1.5 w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px]">
                      <option value="">{t('mv.noCounterOption')}</option>
                      {counters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
                    </select>
                  )}
                  <div className="flex gap-2 mt-2 pt-2 border-t border-[#f1f5f9]">
                    <input type="number" value={salaryDraft[s.id] ?? ''} onChange={(e) => setSalaryDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      placeholder={t('mv.monthlySalaryPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <button onClick={() => saveSalary(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-semibold text-[#166534] cursor-pointer">{t('mv.setSalaryBtn')}</button>
                  </div>
                  <div className="flex gap-2 mt-1.5">
                    <input type="number" value={paymentDraft[s.id] ?? ''} onChange={(e) => setPaymentDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                      placeholder={t('mv.expenseAmountPlaceholder')} className="flex-1 px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px] ltr-num" />
                    <button onClick={() => recordPayment(s.id)} className="shrink-0 px-2.5 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-semibold cursor-pointer">{t('mv.recordPaymentBtn')}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
