'use client'

// 860: Cash Settlements tab — the existing per-counter cash position
// cards + remittance recording (855's fleet_counter_cash_positions/
// record_counter_remittance), moved off the single long fleet page into
// its own tab, unchanged logic.
//
// 864: added a second "Driver cash" section — ride_bookings paid cash
// (every regular app booking and every mid-route "catch" booking) had
// zero connection to any remittance system, a real unprotected gap.
// Mirrors the counter section's own cards/remit-form shape exactly.

import { useEffect, useState } from 'react'
import { Wallet, Bus, Building2 } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetColumnLabels } from '@/components/portal/FleetPanel'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface CounterCash { counter_id: string; city: string; name: string | null; total_collected_pkr: number; total_remitted_pkr: number; cash_in_hand_pkr: number }
interface VehicleCash { vehicle_id: string; owner_name: string; vehicle_type: string | null; vehicle_number: string | null; total_collected_pkr: number; total_remitted_pkr: number; cash_in_hand_pkr: number }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function FleetCashPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [counterCash, setCounterCash] = useState<CounterCash[]>([])
  const [remitCounterId, setRemitCounterId] = useState<string | null>(null)
  const [remitAmount, setRemitAmount] = useState('')
  const [remitting, setRemitting] = useState(false)
  const [vehicleCash, setVehicleCash] = useState<VehicleCash[]>([])
  const [remitVehicleId, setRemitVehicleId] = useState<string | null>(null)
  const [remitVehicleAmount, setRemitVehicleAmount] = useState('')
  const [remittingVehicle, setRemittingVehicle] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f?.is_owner) {
      const [{ data: cashData }, { data: vehData }] = await Promise.all([
        supabase.rpc('fleet_counter_cash_positions', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_vehicle_cash_positions', { p_fleet_id: f.fleet_id }),
      ])
      setCounterCash((cashData ?? []) as CounterCash[])
      setVehicleCash((vehData ?? []) as VehicleCash[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

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

  const recordVehicleRemittance = async () => {
    if (!remitVehicleId || !remitVehicleAmount) return
    setRemittingVehicle(true)
    const { error } = await supabase.rpc('record_vehicle_cash_remittance', { p_vehicle_id: remitVehicleId, p_amount_pkr: Number(remitVehicleAmount) })
    setRemittingVehicle(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.remittanceRecordedToast'))
    setRemitVehicleId(null); setRemitVehicleAmount('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!fleetId) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.noFleetYetHint')}</p>
  if (!isOwner) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.ownerOnlySectionHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Wallet size={19} /> {t('mv.fleetCashHeading')}</h1>

      <p className="font-sans text-[11px] text-[#64748b] -mt-1">{t('mv.panelDesc.cash')}</p>

      <FleetPanel>
        <FleetPanelHead icon={<Building2 size={14} />} title={t('mv.counterCashHeading')}
          action={counterCash.length > 0 ? <span className="font-sans text-[12px] font-extrabold text-[#166534] ltr-num">₨{fmt(counterCash.reduce((s, c) => s + Number(c.cash_in_hand_pkr), 0))}</span> : undefined} />
        {counterCash.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noCountersYetHint')}</p>
        ) : (
          <>
            <FleetColumnLabels labels={[t('mv.counterColumnLabel'), t('mv.cashLabel')]} />
            <div className="flex flex-col divide-y divide-[#f1f5f9]">
              {counterCash.map((c) => (
                <div key={c.counter_id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate min-w-0">{c.city}{c.name ? ` · ${c.name}` : ''}</span>
                    <span className="shrink-0 font-sans text-[16px] font-extrabold ltr-num" style={{ color: c.cash_in_hand_pkr < 0 ? '#b91c1c' : '#166534' }}>₨{fmt(c.cash_in_hand_pkr)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1.5 pt-1.5 border-t border-dashed border-[#f1f5f9]">
                    <span className="font-sans text-[11px] text-[#94a3b8] ltr-num">{t('mv.collectedLabel')} ₨{fmt(c.total_collected_pkr)} · {t('mv.remittedLabel')} ₨{fmt(c.total_remitted_pkr)}</span>
                    <button onClick={() => { setRemitCounterId(c.counter_id); setRemitAmount('') }} className="shrink-0 px-2.5 py-1 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-bold text-[#166534] cursor-pointer">{t('mv.recordRemittanceBtn')}</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </FleetPanel>

      {remitCounterId && (
        <FleetPanel>
          <FleetPanelHead icon={<Wallet size={14} />} title={t('mv.recordRemittanceBtn')} description={counterCash.find((c) => c.counter_id === remitCounterId)?.city} />
          <FleetPanelBody>
          <div className="flex gap-2">
            <input type="number" value={remitAmount} onChange={(e) => setRemitAmount(e.target.value)} placeholder={t('mv.expenseAmountPlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            <button onClick={recordRemittance} disabled={remitting} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
              {remitting ? t('action.loading') : t('action.save')}
            </button>
            <button onClick={() => setRemitCounterId(null)} className="shrink-0 px-3 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
          </div>
          </FleetPanelBody>
        </FleetPanel>
      )}

      <FleetPanel>
        <FleetPanelHead icon={<Bus size={14} />} title={t('mv.driverCashHeading')}
          action={vehicleCash.length > 0 ? <span className="font-sans text-[12px] font-extrabold text-[#166534] ltr-num">₨{fmt(vehicleCash.reduce((s, v) => s + Number(v.cash_in_hand_pkr), 0))}</span> : undefined} />
        {vehicleCash.length === 0 ? (
          <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noVehiclesYetHint')}</p>
        ) : (
          <>
            <FleetColumnLabels labels={[t('mv.vehicleColumnLabel'), t('mv.cashLabel')]} />
            <div className="flex flex-col divide-y divide-[#f1f5f9]">
              {vehicleCash.map((v) => (
                <div key={v.vehicle_id} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-[#1e293b] ltr-num truncate">{v.vehicle_number || v.vehicle_type || v.owner_name}</p>
                      <p className="font-sans text-[10.5px] text-[#94a3b8]">{v.vehicle_type} · {v.owner_name}</p>
                    </div>
                    <span className="shrink-0 font-sans text-[16px] font-extrabold ltr-num" style={{ color: v.cash_in_hand_pkr < 0 ? '#b91c1c' : '#166534' }}>₨{fmt(v.cash_in_hand_pkr)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1.5 pt-1.5 border-t border-dashed border-[#f1f5f9]">
                    <span className="font-sans text-[11px] text-[#94a3b8] ltr-num">{t('mv.collectedLabel')} ₨{fmt(v.total_collected_pkr)} · {t('mv.remittedLabel')} ₨{fmt(v.total_remitted_pkr)}</span>
                    <button onClick={() => { setRemitVehicleId(v.vehicle_id); setRemitVehicleAmount('') }} className="shrink-0 px-2.5 py-1 rounded-lg border border-[#e5e2d0] font-sans text-[11px] font-bold text-[#166534] cursor-pointer">{t('mv.recordRemittanceBtn')}</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </FleetPanel>

      {remitVehicleId && (
        <FleetPanel>
          <FleetPanelHead icon={<Wallet size={14} />} title={t('mv.recordRemittanceBtn')} description={vehicleCash.find((v) => v.vehicle_id === remitVehicleId)?.vehicle_number ?? undefined} />
          <FleetPanelBody>
          <div className="flex gap-2">
            <input type="number" value={remitVehicleAmount} onChange={(e) => setRemitVehicleAmount(e.target.value)} placeholder={t('mv.expenseAmountPlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            <button onClick={recordVehicleRemittance} disabled={remittingVehicle} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
              {remittingVehicle ? t('action.loading') : t('action.save')}
            </button>
            <button onClick={() => setRemitVehicleId(null)} className="shrink-0 px-3 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
          </div>
          </FleetPanelBody>
        </FleetPanel>
      )}
    </div>
  )
}
