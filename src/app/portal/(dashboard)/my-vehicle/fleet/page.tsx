'use client'

// 853: self-service fleet management — real ask, confirmed via two
// clarifying questions: fleet creation is fully self-service (no admin
// step at all), and every unit under a fleet still gets its own driver
// login (same per-vehicle model buses already use) rather than one
// shared login. This page is where an owner creates their fleet and
// invites a driver (by phone, via a short code — see this migration's
// header for why a code, not a phone match) for a new bus or machine;
// the invited driver redeems the code on /portal/my-vehicle/register,
// then registers exactly as any solo driver always has — same
// documents, same admin review, same committee-set fare/commission —
// and their resulting vehicle is automatically tagged into this fleet.
//
// 854 (fleet accounting, Phase 1): added Fleet Staff (full operational
// parity with the owner, same "full equal access" shape shop_staff
// already uses — not fare/commission, which stays admin-only for
// everyone regardless), expense logging (mirrors shop_purchases —
// never touches the commission wallet/ledger), a live fleet P&L, and
// a fleet map. Staff see this exact same page once can_manage_vehicle()
// recognizes them — isOwner alone gates the owner-only controls
// (invite a driver, add/remove staff), not whether the page renders.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Users2, Copy, Check, Wallet, Fuel, UserPlus, Map as MapIcon } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import type { MapPin } from '@/components/shared/LeafletMap'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
interface Invite { id: string; invited_phone: string; created_at: string; expires_at: string; redeemed_at: string | null; vehicle_id: string | null }
interface StaffMember { id: string; portal_user_id: string; full_name: string; added_at: string; counter_id: string | null; counter_city: string | null; counter_name: string | null }
interface Counter { id: string; city: string; name: string | null }
interface CounterCash { counter_id: string; city: string; name: string | null; total_collected_pkr: number; total_remitted_pkr: number; cash_in_hand_pkr: number }
interface FleetVehicleSummary {
  vehicle_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null
  today_earnings_pkr: number; today_expenses_pkr: number; today_profit_pkr: number
  month_earnings_pkr: number; month_expenses_pkr: number; month_profit_pkr: number
  wallet_balance_pkr: number
}
interface LivePin { source: string; ref_id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null; context: string; lat: number; lng: number; updated_at: string }

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyFleetPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [fleetName, setFleetName] = useState('')
  const [isOwner, setIsOwner] = useState(false)
  const [newFleetName, setNewFleetName] = useState('')
  const [creating, setCreating] = useState(false)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [invitePhone, setInvitePhone] = useState('')
  const [inviting, setInviting] = useState(false)
  const [lastCode, setLastCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // 854: P&L, expenses, staff, map
  const [pl, setPl] = useState<{ vehicles: FleetVehicleSummary[]; fleet_today_profit_pkr: number; fleet_month_profit_pkr: number } | null>(null)
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [staffPhone, setStaffPhone] = useState('')
  const [addingStaff, setAddingStaff] = useState(false)
  const [expenseVehicleId, setExpenseVehicleId] = useState('')
  const [expenseCategory, setExpenseCategory] = useState('fuel')
  const [expenseAmount, setExpenseAmount] = useState('')
  const [expenseNote, setExpenseNote] = useState('')
  const [loggingExpense, setLoggingExpense] = useState(false)
  const [livePins, setLivePins] = useState<LivePin[]>([])
  const [showMap, setShowMap] = useState(false)

  // 855: city-named booking counters, so the owner always knows which
  // staff works which city, and cash collected per counter is tracked
  // separately from the committee's own ledger (same discipline as
  // vehicle_expenses, 854 — never posted there).
  const [counters, setCounters] = useState<Counter[]>([])
  const [counterCash, setCounterCash] = useState<CounterCash[]>([])
  const [newCounterCity, setNewCounterCity] = useState('')
  const [newCounterName, setNewCounterName] = useState('')
  const [creatingCounter, setCreatingCounter] = useState(false)
  const [remitCounterId, setRemitCounterId] = useState<string | null>(null)
  const [remitAmount, setRemitAmount] = useState('')
  const [remitting, setRemitting] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; name: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setFleetName(f?.name ?? '')
    setIsOwner(f?.is_owner ?? false)
    if (f) {
      const [{ data: v }, { data: inv }, { data: plData }, { data: staffData }, { data: countersData }, { data: cashData }] = await Promise.all([
        supabase.rpc('my_fleet_vehicles'),
        f.is_owner ? supabase.rpc('my_fleet_invites', { p_fleet_id: f.fleet_id }) : Promise.resolve({ data: [] }),
        supabase.rpc('fleet_dashboard_summary'),
        supabase.rpc('my_fleet_staff', { p_fleet_id: f.fleet_id }),
        supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id }),
        f.is_owner ? supabase.rpc('fleet_counter_cash_positions', { p_fleet_id: f.fleet_id }) : Promise.resolve({ data: [] }),
      ])
      setVehicles((v ?? []) as FleetVehicle[])
      setInvites((inv ?? []) as Invite[])
      setPl(plData as typeof pl)
      setStaff((staffData ?? []) as StaffMember[])
      setCounters((countersData ?? []) as Counter[])
      setCounterCash((cashData ?? []) as CounterCash[])
      if ((v ?? []).length > 0) setExpenseVehicleId((v as FleetVehicle[])[0].id)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const createFleet = async () => {
    if (!newFleetName.trim()) { toast.error(t('mv.fleetNameRequiredError')); return }
    setCreating(true)
    const { error } = await supabase.rpc('create_my_fleet', { p_name: newFleetName })
    setCreating(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.fleetCreatedToast'))
    setNewFleetName('')
    load()
  }

  const inviteDriver = async () => {
    if (!fleetId || !invitePhone.trim()) { toast.error(t('mv.enterDriverPhoneError')); return }
    setInviting(true)
    const { data, error } = await supabase.rpc('invite_fleet_driver', { p_fleet_id: fleetId, p_phone: invitePhone })
    setInviting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setLastCode(data as string)
    setInvitePhone('')
    load()
  }

  const copyCode = () => {
    if (!lastCode) return
    navigator.clipboard?.writeText(lastCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  const addStaff = async () => {
    if (!fleetId || !staffPhone.trim()) { toast.error(t('mv.enterDriverPhoneError')); return }
    setAddingStaff(true)
    const { error } = await supabase.rpc('add_fleet_staff', { p_fleet_id: fleetId, p_phone: staffPhone })
    setAddingStaff(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.staffAddedToast'))
    setStaffPhone('')
    load()
  }

  const removeStaff = async (portalUserId: string) => {
    if (!fleetId || !confirm(t('mv.confirmRemoveStaffHint'))) return
    const { error } = await supabase.rpc('remove_fleet_staff', { p_fleet_id: fleetId, p_portal_user_id: portalUserId })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const logExpense = async () => {
    if (!expenseVehicleId || !expenseAmount) { toast.error(t('mv.enterExpenseAmountError')); return }
    setLoggingExpense(true)
    const { error } = await supabase.rpc('record_vehicle_expense', {
      p_vehicle_id: expenseVehicleId, p_category: expenseCategory, p_amount_pkr: Number(expenseAmount), p_note: expenseNote || null,
    })
    setLoggingExpense(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.expenseLoggedToast'))
    setExpenseAmount(''); setExpenseNote('')
    load()
  }

  const createCounter = async () => {
    if (!fleetId || !newCounterCity.trim()) { toast.error(t('mv.enterCounterCityError')); return }
    setCreatingCounter(true)
    const { error } = await supabase.rpc('create_fleet_counter', { p_fleet_id: fleetId, p_city: newCounterCity, p_name: newCounterName || null })
    setCreatingCounter(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.counterCreatedToast'))
    setNewCounterCity(''); setNewCounterName('')
    load()
  }

  const assignCounter = async (portalUserId: string, counterId: string) => {
    if (!fleetId) return
    const { error } = await supabase.rpc('assign_staff_to_counter', { p_fleet_id: fleetId, p_portal_user_id: portalUserId, p_counter_id: counterId || null })
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  const recordRemittance = async () => {
    if (!remitCounterId || !remitAmount) return
    setRemitting(true)
    const { error } = await supabase.rpc('record_counter_remittance', { p_counter_id: remitCounterId, p_amount_pkr: Number(remitAmount) })
    setRemitting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.remittanceRecordedToast'))
    setRemitCounterId(null); setRemitAmount('')
    load()
  }

  const openMap = async () => {
    if (!fleetId) return
    setShowMap(true)
    const { data, error } = await supabase.rpc('fleet_vehicle_locations', { p_fleet_id: fleetId })
    if (error) { toast.error(friendlyError(error)); return }
    setLivePins((data ?? []) as LivePin[])
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Users2 size={19} /> {t('mv.myFleetHeading')}</h1>

      {!fleetId ? (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <p className="font-sans text-[13px] text-[#64748b] mb-3">{t('mv.noFleetYetHint')}</p>
          <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fleetNameLabel')}</label>
          <input value={newFleetName} onChange={(e) => setNewFleetName(e.target.value)} placeholder={t('mv.fleetNamePlaceholder')}
            className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5" />
          <button onClick={createFleet} disabled={creating} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {creating ? t('action.loading') : t('mv.createFleetBtn')}
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="font-sans text-[14px] font-bold text-[#1e293b]">{fleetName}</p>
            <button onClick={openMap} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer">
              <MapIcon size={13} /> {t('mv.fleetMapBtn')}
            </button>
          </div>

          {showMap && (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl p-2">
              {livePins.length === 0 ? (
                <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noLiveVehiclesHint')}</p>
              ) : (
                <LeafletMap
                  pins={livePins.map((p): MapPin => ({ lat: p.lat, lng: p.lng, label: `${p.owner_name} · ${p.context}`, color: '#166534', emoji: '🚐', isVehicle: true }))}
                  height={220} className="rounded-xl"
                />
              )}
            </div>
          )}

          {/* Fleet P&L — profit shown separately from the commission
              wallet balance everywhere, so the two are never confused. */}
          {pl && pl.vehicles.length > 0 && (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{t('mv.fleetPLHeading')}</p>
              <div className="flex gap-2 mb-3">
                <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-2.5">
                  <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.todayProfitLabel')}</p>
                  <p className="font-sans text-[17px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl.fleet_today_profit_pkr)}</p>
                </div>
                <div className="flex-1 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-2.5">
                  <p className="font-sans text-[10.5px] text-[#166534]">{t('mv.monthProfitLabel')}</p>
                  <p className="font-sans text-[17px] font-extrabold text-[#166534] ltr-num">₨{fmt(pl.fleet_month_profit_pkr)}</p>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {pl.vehicles.map((v) => (
                  <div key={v.vehicle_id} className="border border-[#e5e2d0] rounded-lg px-3 py-2">
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</p>
                    <div className="flex items-center justify-between mt-1 ltr-num">
                      <span className="font-sans text-[11px] text-[#64748b]">{t('mv.todayLabel')}: ₨{fmt(v.today_earnings_pkr)} − ₨{fmt(v.today_expenses_pkr)} = <span className="font-bold text-[#1e293b]">₨{fmt(v.today_profit_pkr)}</span></span>
                      <span className="font-sans text-[10.5px] text-[#94a3b8] flex items-center gap-1"><Wallet size={11} /> ₨{fmt(v.wallet_balance_pkr)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Log an expense */}
          {vehicles.length > 0 && (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5 flex items-center gap-1.5"><Fuel size={13} /> {t('mv.logExpenseHeading')}</p>
              <select value={expenseVehicleId} onChange={(e) => setExpenseVehicleId(e.target.value)} className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2">
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</option>)}
              </select>
              <div className="flex gap-2 mb-2">
                <select value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)} className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]">
                  <option value="fuel">{t('mv.expenseCategoryFuel')}</option>
                  <option value="maintenance">{t('mv.expenseCategoryMaintenance')}</option>
                  <option value="toll">{t('mv.expenseCategoryToll')}</option>
                  <option value="other">{t('mv.expenseCategoryOther')}</option>
                </select>
                <input type="number" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder={t('mv.expenseAmountPlaceholder')}
                  className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
              </div>
              <input value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} placeholder={t('mv.expenseNotePlaceholder')}
                className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5" />
              <button onClick={logExpense} disabled={loggingExpense} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
                {loggingExpense ? t('action.loading') : t('mv.logExpenseBtn')}
              </button>
            </div>
          )}

          {/* 855: city-named booking counters — a 20-bus intercity
              fleet has counters in Peshawar, Karachi, maybe several
              per city; each counter's cash position is tracked
              separately from the committee ledger, same as expenses. */}
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2">{t('mv.bookingCountersHeading')}</p>
            {isOwner && (
              <div className="flex gap-2 mb-2.5">
                <input value={newCounterCity} onChange={(e) => setNewCounterCity(e.target.value)} placeholder={t('mv.counterCityPlaceholder')}
                  className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                <input value={newCounterName} onChange={(e) => setNewCounterName(e.target.value)} placeholder={t('mv.counterNameOptionalPlaceholder')}
                  className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
                <button onClick={createCounter} disabled={creatingCounter} className="shrink-0 px-3 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12px] font-bold cursor-pointer disabled:opacity-50">
                  {creatingCounter ? t('action.loading') : t('mv.addCounterBtn')}
                </button>
              </div>
            )}
            {counters.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8]">{t('mv.noCountersYetHint')}</p>
            ) : isOwner && counterCash.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {counterCash.map((c) => (
                  <div key={c.counter_id} className="border border-[#e5e2d0] rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{c.city}{c.name ? ` · ${c.name}` : ''}</span>
                      <span className="font-sans text-[13px] font-extrabold text-[#166534] ltr-num">₨{fmt(c.cash_in_hand_pkr)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="font-sans text-[10.5px] text-[#94a3b8] ltr-num">{t('mv.collectedLabel')} ₨{fmt(c.total_collected_pkr)} · {t('mv.remittedLabel')} ₨{fmt(c.total_remitted_pkr)}</span>
                      <button onClick={() => { setRemitCounterId(c.counter_id); setRemitAmount('') }} className="font-sans text-[11px] font-bold text-[#166534] cursor-pointer">{t('mv.recordRemittanceBtn')}</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {counters.map((c) => (
                  <div key={c.id} className="border border-[#e5e2d0] rounded-lg px-3 py-2">
                    <span className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{c.city}{c.name ? ` · ${c.name}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {remitCounterId && (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2">{t('mv.recordRemittanceBtn')}</p>
              <div className="flex gap-2">
                <input type="number" value={remitAmount} onChange={(e) => setRemitAmount(e.target.value)} placeholder={t('mv.expenseAmountPlaceholder')}
                  className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                <button onClick={recordRemittance} disabled={remitting} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                  {remitting ? t('action.loading') : t('action.save')}
                </button>
                <button onClick={() => setRemitCounterId(null)} className="shrink-0 px-3 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
              </div>
            </div>
          )}

          {/* Fleet Staff — full operational parity, owner-only to add/remove */}
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2 flex items-center gap-1.5"><UserPlus size={13} /> {t('mv.fleetStaffHeading')}</p>
            <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.fleetStaffHint')}</p>
            {isOwner && (
              <div className="flex gap-2 mb-2.5">
                <input value={staffPhone} onChange={(e) => setStaffPhone(e.target.value)} placeholder={t('mv.driverPhonePlaceholder')}
                  className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                <button onClick={addStaff} disabled={addingStaff} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                  {addingStaff ? t('action.loading') : t('mv.addStaffBtn')}
                </button>
              </div>
            )}
            {staff.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8]">{t('mv.noStaffYetHint')}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {staff.map((s) => (
                  <div key={s.id} className="border border-[#e5e2d0] rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{s.full_name}</span>
                      {isOwner && (
                        <button onClick={() => removeStaff(s.portal_user_id)} className="font-sans text-[11px] font-bold text-[#b91c1c] cursor-pointer">{t('action.remove')}</button>
                      )}
                    </div>
                    {isOwner && counters.length > 0 ? (
                      <select value={s.counter_id ?? ''} onChange={(e) => assignCounter(s.portal_user_id, e.target.value)} className="mt-1.5 w-full px-2 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[11.5px]">
                        <option value="">{t('mv.noCounterOption')}</option>
                        {counters.map((c) => <option key={c.id} value={c.id}>{c.city}{c.name ? ` · ${c.name}` : ''}</option>)}
                      </select>
                    ) : s.counter_city ? (
                      <p className="font-sans text-[11px] text-[#166534] mt-0.5">{s.counter_city}{s.counter_name ? ` · ${s.counter_name}` : ''}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {isOwner && (
            <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2">{t('mv.inviteDriverHeading')}</p>
              <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.inviteDriverHint')}</p>
              <div className="flex gap-2">
                <input value={invitePhone} onChange={(e) => setInvitePhone(e.target.value)} placeholder={t('mv.driverPhonePlaceholder')}
                  className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
                <button onClick={inviteDriver} disabled={inviting} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                  {inviting ? t('action.loading') : t('mv.sendInviteBtn')}
                </button>
              </div>
              {lastCode && (
                <div className="mt-3 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-3 flex items-center justify-between gap-2">
                  <div>
                    <p className="font-sans text-[11px] text-[#166534]">{t('mv.shareThisCodeHint')}</p>
                    <p className="font-sans text-[22px] font-extrabold text-[#166534] ltr-num tracking-wider">{lastCode}</p>
                  </div>
                  <button onClick={copyCode} className="shrink-0 p-2 rounded-lg border border-[#bbf7d0] cursor-pointer text-[#166534]" aria-label={t('action.copy')}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              )}
            </div>
          )}

          {isOwner && invites.length > 0 && (
            <div>
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('mv.pendingInvitesHeading')}</p>
              <div className="flex flex-col gap-1.5">
                {invites.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-2 bg-white border border-[#e5e2d0] rounded-lg px-3 py-2">
                    <span className="font-sans text-[12.5px] font-semibold text-[#1e293b] ltr-num">{i.invited_phone}</span>
                    <span className="font-sans text-[11px] font-bold ltr-num" style={{ color: i.vehicle_id ? '#166534' : i.redeemed_at ? '#b45309' : '#94a3b8' }}>
                      {i.vehicle_id ? t('mv.inviteStatusVehicleAdded') : i.redeemed_at ? t('mv.inviteStatusRedeemed') : t('mv.inviteStatusPending') + ' · ' + fmtDate(i.expires_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {vehicles.length > 0 && (
            <div>
              <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('mv.fleetVehiclesHeading')}</p>
              <div className="flex flex-col gap-1.5">
                {vehicles.map((v) => (
                  <div key={v.id} className="bg-white border border-[#e5e2d0] rounded-lg px-3 py-2">
                    <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</p>
                    {v.vehicle_number && <p className="font-sans text-[11px] text-[#64748b] ltr-num">{v.vehicle_number}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
