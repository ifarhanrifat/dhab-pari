'use client'

// 860: Reports tab — single-scroll, card-based, modeled on my-shop/
// reports/page.tsx's layout. Everything here already existed as backend
// data except staff salaries and commission settlements (both new in
// migration 860); P&L, per-vehicle expense totals, and cash positions
// all reuse existing RPCs, just aggregated into one reading view.

import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicleSummary {
  vehicle_id: string; owner_name: string; vehicle_type: string
  today_earnings_pkr: number; today_expenses_pkr: number; today_profit_pkr: number
  month_earnings_pkr: number; month_expenses_pkr: number; month_profit_pkr: number
  wallet_balance_pkr: number
}
interface StaffSalary { fleet_staff_id: string; full_name: string; monthly_salary_pkr: number | null; paid_this_month_pkr: number; last_payment_date: string | null }
interface CommissionRow { vehicle_id: string; owner_name: string; month: string; commission_settled_pkr: number; topped_up_pkr: number }
interface CounterCash { counter_id: string; city: string; name: string | null; cash_in_hand_pkr: number }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function FleetReportsPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [pl, setPl] = useState<{ vehicles: FleetVehicleSummary[]; fleet_today_profit_pkr: number; fleet_month_profit_pkr: number } | null>(null)
  const [salaries, setSalaries] = useState<StaffSalary[]>([])
  const [commissions, setCommissions] = useState<CommissionRow[]>([])
  const [counterCash, setCounterCash] = useState<CounterCash[]>([])

  useEffect(() => {
    if (!user) return
    (async () => {
      const { data: mine } = await supabase.rpc('my_managed_fleet')
      const f = mine as { fleet_id: string; is_owner: boolean } | null
      setFleetId(f?.fleet_id ?? null)
      setIsOwner(f?.is_owner ?? false)
      if (f) {
        const [{ data: plData }, { data: comm }] = await Promise.all([
          supabase.rpc('fleet_dashboard_summary'),
          supabase.rpc('fleet_commission_settlements', { p_fleet_id: f.fleet_id }),
        ])
        setPl(plData as typeof pl)
        setCommissions((comm ?? []) as CommissionRow[])
        if (f.is_owner) {
          const [{ data: sal }, { data: cash }] = await Promise.all([
            supabase.rpc('fleet_staff_salary_report', { p_fleet_id: f.fleet_id }),
            supabase.rpc('fleet_counter_cash_positions', { p_fleet_id: f.fleet_id }),
          ])
          setSalaries((sal ?? []) as StaffSalary[])
          setCounterCash((cash ?? []) as CounterCash[])
        }
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><BarChart3 size={19} /> {t('mv.fleetReportsHeading')}</h1>

      {/* P&L */}
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
                <div className="flex items-center justify-between mt-1">
                  <span className="font-sans text-[11px] text-[#64748b] ltr-num">{t('mv.todayLabel')}: ₨{fmt(v.today_earnings_pkr)} − ₨{fmt(v.today_expenses_pkr)} = <span className="font-bold text-[#1e293b]">₨{fmt(v.today_profit_pkr)}</span></span>
                  <span className="font-sans text-[10.5px] text-[#94a3b8] ltr-num">{t('mv.walletLabel')} ₨{fmt(v.wallet_balance_pkr)}</span>
                </div>
                <div className="font-sans text-[11px] text-[#64748b] mt-0.5 ltr-num">{t('mv.monthLabel')}: ₨{fmt(v.month_earnings_pkr)} − ₨{fmt(v.month_expenses_pkr)} = <span className="font-bold text-[#1e293b]">₨{fmt(v.month_profit_pkr)}</span></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Commission settlements — read-only against the real committee
          ledger, each vehicle's own account only. */}
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{t('mv.commissionSettlementsHeading')}</p>
        {commissions.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8]">{t('mv.noCommissionHistoryHint')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {commissions.map((c) => (
              <div key={`${c.vehicle_id}-${c.month}`} className="border border-[#e5e2d0] rounded-lg px-3 py-2 flex items-center justify-between">
                <div>
                  <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{c.owner_name}</p>
                  <p className="font-sans text-[10.5px] text-[#94a3b8]">{c.month}</p>
                </div>
                <div className="text-end ltr-num">
                  <p className="font-sans text-[13px] font-bold text-[#b91c1c]">₨{fmt(c.commission_settled_pkr)}</p>
                  {c.topped_up_pkr > 0 && <p className="font-sans text-[10.5px] text-[#166534]">+₨{fmt(c.topped_up_pkr)} {t('mv.toppedUpSuffix')}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isOwner && (
        <>
          {/* Staff salaries */}
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{t('mv.staffSalariesHeading')}</p>
            {salaries.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8]">{t('mv.noStaffYetHint')}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {salaries.map((s) => (
                  <div key={s.fleet_staff_id} className="border border-[#e5e2d0] rounded-lg px-3 py-2 flex items-center justify-between">
                    <div>
                      <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{s.full_name}</p>
                      <p className="font-sans text-[10.5px] text-[#94a3b8]">
                        {s.monthly_salary_pkr != null ? `₨${fmt(s.monthly_salary_pkr)}/${t('mv.monthSuffix')}` : t('mv.noSalarySetHint')}
                      </p>
                    </div>
                    <div className="text-end ltr-num">
                      <p className="font-sans text-[13px] font-bold text-[#166534]">₨{fmt(s.paid_this_month_pkr)}</p>
                      <p className="font-sans text-[10.5px] text-[#94a3b8]">{t('mv.paidThisMonthSuffix')}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="font-sans text-[11px] text-[#94a3b8] mt-2.5">{t('mv.manageSalariesHint')}</p>
          </div>

          {/* Cash position across every counter */}
          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5">{t('mv.allCountersCashHeading')}</p>
            {counterCash.length === 0 ? (
              <p className="font-sans text-[12px] text-[#94a3b8]">{t('mv.noCountersYetHint')}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {counterCash.map((c) => (
                  <div key={c.counter_id} className="border border-[#e5e2d0] rounded-lg px-3 py-2 flex items-center justify-between">
                    <span className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{c.city}{c.name ? ` · ${c.name}` : ''}</span>
                    <span className="font-sans text-[13px] font-bold ltr-num" style={{ color: c.cash_in_hand_pkr < 0 ? '#b91c1c' : '#166534' }}>₨{fmt(c.cash_in_hand_pkr)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-1.5 border-t border-[#e5e2d0]">
                  <span className="font-sans text-[11.5px] font-bold text-[#64748b]">{t('mv.totalCashInHandLabel')}</span>
                  <span className="font-sans text-[14px] font-extrabold text-[#166534] ltr-num">₨{fmt(counterCash.reduce((s, c) => s + Number(c.cash_in_hand_pkr), 0))}</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
