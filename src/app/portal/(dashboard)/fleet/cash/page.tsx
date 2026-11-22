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

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Wallet, Bus, Building2, Receipt, Plus, HandCoins, Landmark } from 'lucide-react'
import { FleetPanel, FleetPanelHead, FleetPanelBody, FleetColumnLabels, FleetStat } from '@/components/portal/FleetPanel'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface CounterCash { counter_id: string; city: string; name: string | null; total_collected_pkr: number; total_remitted_pkr: number; cash_in_hand_pkr: number }
interface VehicleCash { vehicle_id: string; owner_name: string; vehicle_type: string | null; vehicle_number: string | null; total_collected_pkr: number; total_remitted_pkr: number; cash_in_hand_pkr: number }
interface Channels { online_pkr: number; terminal_pkr: number; driver_pkr: number; total_pkr: number }
interface PendingHandover { id: string; amount_pkr: number; travel_date: string; direction: string; note: string | null; route_label: string; vehicle_number: string | null; driver_name: string | null; counter_label: string | null }
interface FleetPaymentInfo {
  name: string; logo_url: string | null; bank_account_title: string | null; bank_name: string | null; bank_account_number: string | null
  easypaisa_number: string | null; easypaisa_account_title: string | null
}

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
  const [canEditCash, setCanEditCash] = useState(false)
  const [paymentInfo, setPaymentInfo] = useState<FleetPaymentInfo | null>(null)
  const [editingPayment, setEditingPayment] = useState(false)
  const [bankTitle, setBankTitle] = useState('')
  const [bankName, setBankName] = useState('')
  const [bankNumber, setBankNumber] = useState('')
  const [easypaisaNumber, setEasypaisaNumber] = useState('')
  const [easypaisaTitle, setEasypaisaTitle] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [counterCash, setCounterCash] = useState<CounterCash[]>([])
  const [remitCounterId, setRemitCounterId] = useState<string | null>(null)
  const [remitAmount, setRemitAmount] = useState('')
  const [remitting, setRemitting] = useState(false)
  const [vehicleCash, setVehicleCash] = useState<VehicleCash[]>([])
  const [remitVehicleId, setRemitVehicleId] = useState<string | null>(null)
  const [remitVehicleAmount, setRemitVehicleAmount] = useState('')
  const [remittingVehicle, setRemittingVehicle] = useState(false)
  const [channels, setChannels] = useState<Channels | null>(null)
  const [pendingHandovers, setPendingHandovers] = useState<PendingHandover[]>([])
  const [confirmingHandoverId, setConfirmingHandoverId] = useState<string | null>(null)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean; can_edit_cash: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    setCanEditCash(f?.can_edit_cash ?? false)
    if (f?.can_edit_cash) {
      const [{ data: cashData }, { data: vehData }, { data: chData }, { data: handoverData }, { data: pay }] = await Promise.all([
        supabase.rpc('fleet_counter_cash_positions', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_vehicle_cash_positions', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_collection_channels', { p_fleet_id: f.fleet_id }),
        supabase.rpc('fleet_pending_driver_handovers', { p_fleet_id: f.fleet_id }),
        supabase.from('fleets').select('name, logo_url, bank_account_title, bank_name, bank_account_number, easypaisa_number, easypaisa_account_title').eq('id', f.fleet_id).single(),
      ])
      setCounterCash((cashData ?? []) as CounterCash[])
      setVehicleCash((vehData ?? []) as VehicleCash[])
      setChannels((chData ?? null) as Channels | null)
      setPendingHandovers((handoverData ?? []) as PendingHandover[])
      const p = pay as FleetPaymentInfo | null
      setPaymentInfo(p)
      if (p) {
        setBankTitle(p.bank_account_title ?? ''); setBankName(p.bank_name ?? ''); setBankNumber(p.bank_account_number ?? '')
        setEasypaisaNumber(p.easypaisa_number ?? ''); setEasypaisaTitle(p.easypaisa_account_title ?? ''); setLogoUrl(p.logo_url ?? '')
      }
    }
    setLoading(false)
  }

  const savePaymentInfo = async () => {
    if (!fleetId) return
    setSavingPayment(true)
    const { error } = await supabase.rpc('set_fleet_payment_info', {
      p_fleet_id: fleetId, p_bank_account_title: bankTitle || null, p_bank_name: bankName || null, p_bank_account_number: bankNumber || null,
      p_easypaisa_number: easypaisaNumber || null, p_easypaisa_account_title: easypaisaTitle || null, p_logo_url: logoUrl || null,
    })
    setSavingPayment(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.paymentInfoSavedToast'))
    setEditingPayment(false)
    load()
  }

  const confirmHandover = async (id: string) => {
    setConfirmingHandoverId(id)
    const { error } = await supabase.rpc('confirm_route_driver_handover', { p_id: id })
    setConfirmingHandoverId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.handoverConfirmedToast'))
    load()
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
  if (!canEditCash) return <p className="font-sans text-[13px] text-[#64748b] text-center py-12">{t('mv.ownerOnlySectionHint')}</p>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2 truncate"><Wallet size={19} /> {t('mv.fleetCashHeading')}</h1>
        {/* 2026-11-18: real gap from the button-by-button audit — the
            mockup puts "+Record expense" right on this screen's header;
            the real feature already exists (fleet/expenses), just one
            sidebar nav-hop away until now. */}
        <Link href="/portal/fleet/expenses" className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11px] font-bold">
          <Plus size={12} /> {t('mv.logExpenseBtn')}
        </Link>
      </div>

      <p className="font-sans text-[11px] text-[#64748b] -mt-1">{t('mv.panelDesc.cash')}</p>

      {/* Real gap named directly, 2026-11-22: a rider paying for their
          seat had nowhere to see WHERE to actually send the money, or
          any brand identity to go with it — this had simply never been
          collected. Owner-only edit, same discipline as every other
          identity-level (not day-to-day cash operation) write in this
          codebase. Riders read this back via vehicle_payment_info. */}
      <FleetPanel>
        <FleetPanelHead icon={<Landmark size={14} />} title={t('mv.paymentDetailsHeading')} description={t('mv.panelDesc.paymentDetails')}
          action={isOwner && !editingPayment ? <button onClick={() => setEditingPayment(true)} className="font-sans text-[11px] font-bold text-[#166534] cursor-pointer">{t('action.edit')}</button> : undefined} />
        <FleetPanelBody className="flex flex-col gap-2.5">
          {!editingPayment ? (
            <div className="flex items-start gap-3">
              {paymentInfo?.logo_url ? (
                <img src={paymentInfo.logo_url} alt="" className="w-12 h-12 rounded-xl object-cover border border-[#e5e2d0] shrink-0" />
              ) : (
                <span className="w-12 h-12 rounded-xl bg-[#f1f5f9] flex items-center justify-center shrink-0"><Landmark size={18} className="text-[#94a3b8]" /></span>
              )}
              <div className="min-w-0 flex-1 flex flex-col gap-1">
                <p className="font-sans text-[13.5px] font-bold text-[#1e293b] truncate">{paymentInfo?.name}</p>
                {paymentInfo?.bank_account_number ? (
                  <p className="font-sans text-[12px] text-[#64748b]">{paymentInfo.bank_name} · <span className="ltr-num">{paymentInfo.bank_account_number}</span> · {paymentInfo.bank_account_title}</p>
                ) : null}
                {paymentInfo?.easypaisa_number ? (
                  <p className="font-sans text-[12px] text-[#64748b]">{t('mv.easypaisaLabel')} · <span className="ltr-num">{paymentInfo.easypaisa_number}</span> · {paymentInfo.easypaisa_account_title}</p>
                ) : null}
                {!paymentInfo?.bank_account_number && !paymentInfo?.easypaisa_number && (
                  <p className="font-sans text-[12px] text-amber-700">{t('mv.noPaymentInfoYetHint')}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <ImageUpload bucket="images" currentUrl={logoUrl || undefined} onUpload={setLogoUrl} label={t('mv.busServiceLogoLabel')} />
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder={t('mv.bankNameLabel')} className="input-field text-[13px]" />
              <input value={bankNumber} onChange={(e) => setBankNumber(e.target.value)} placeholder={t('mv.bankAccountNumberLabel')} className="input-field text-[13px] ltr-num" />
              <input value={bankTitle} onChange={(e) => setBankTitle(e.target.value)} placeholder={t('mv.bankAccountTitleLabel')} className="input-field text-[13px]" />
              <input value={easypaisaNumber} onChange={(e) => setEasypaisaNumber(e.target.value)} placeholder={t('mv.easypaisaNumberLabel')} className="input-field text-[13px] ltr-num" />
              <input value={easypaisaTitle} onChange={(e) => setEasypaisaTitle(e.target.value)} placeholder={t('mv.easypaisaAccountTitleLabel')} className="input-field text-[13px]" />
              <div className="flex gap-2">
                <button onClick={savePaymentInfo} disabled={savingPayment} className="flex-1 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">{savingPayment ? t('action.saving') : t('action.save')}</button>
                <button onClick={() => setEditingPayment(false)} className="flex-1 py-2 rounded-lg border border-[#e5e2d0] font-sans text-[12.5px] font-semibold cursor-pointer">{t('action.cancel')}</button>
              </div>
            </div>
          )}
        </FleetPanelBody>
      </FleetPanel>

      {/* 2026-11-18: Cash & accounts unification — this page already had
          real counter/vehicle cash positions + remittance actions
          (functionally the mockup's own "cash reconciliation queue",
          just framed per-entity instead of per-handover-row), but was
          missing the top-level kpi-row and the Collection Channels
          panel the Dashboard's own "Details" link already promised
          landing here — a real dead-end link until now. Both reuse
          fleet_collection_channels (902), already fetched elsewhere. */}
      {channels && channels.total_pkr > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <FleetStat label={t('mv.grossTodayLabel')} value={`₨${fmt(channels.total_pkr)}`} />
          <FleetStat label={t('mv.channelOnlineLabel')} value={`₨${fmt(channels.online_pkr)}`} />
          <FleetStat label={t('mv.cashWithTerminalsLabel')} value={`₨${fmt(counterCash.reduce((s, c) => s + Number(c.cash_in_hand_pkr), 0))}`} />
          <FleetStat label={t('mv.cashWithDriversLabel')} value={`₨${fmt(vehicleCash.reduce((s, v) => s + Number(v.cash_in_hand_pkr), 0))}`} valueClassName="text-[#b45309]" />
        </div>
      )}

      {channels && channels.total_pkr > 0 && (
        <FleetPanel>
          <FleetPanelHead icon={<Receipt size={14} />} title={t('mv.collectionChannelsHeading')} description={t('mv.panelDesc.collectionChannels')} />
          <FleetPanelBody className="flex flex-col gap-2.5">
            <p className="font-sans text-[20px] font-extrabold text-dp-primary ltr-num">₨{fmt(channels.total_pkr)}</p>
            {[
              { label: t('mv.channelOnlineLabel'), val: channels.online_pkr, color: '#166534' },
              { label: t('mv.channelTerminalLabel'), val: channels.terminal_pkr, color: '#d97706' },
              { label: t('mv.channelDriverLabel'), val: channels.driver_pkr, color: '#2563eb' },
            ].map((c) => {
              const pct = channels.total_pkr > 0 ? Math.round((c.val / channels.total_pkr) * 100) : 0
              return (
                <div key={c.label}>
                  <div className="flex items-center justify-between font-sans text-[11px] text-[#64748b] mb-1">
                    <span>{c.label}</span><span className="font-bold text-[#1e293b] ltr-num">{pct}% · ₨{fmt(c.val)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#F1F5F9] overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${pct}%`, background: c.color }} /></div>
                </div>
              )
            })}
          </FleetPanelBody>
        </FleetPanel>
      )}

      {/* Real gap closed, 2026-11-22: a driver submitting a cash
          handover (from /portal/drive) had no counterpart anywhere to
          confirm it — it sat 'pending' forever and never counted as
          settled cash. This is that missing confirm step, now open to
          the owner and to whichever role(s) the owner granted 'cash'
          permission to (e.g. accountant), not the owner alone. */}
      {pendingHandovers.length > 0 && (
        <FleetPanel>
          <FleetPanelHead icon={<HandCoins size={14} />} title={t('mv.pendingHandoversHeading')}
            action={<span className="font-sans text-[11px] font-bold text-amber-700">{pendingHandovers.length}</span>} />
          <FleetPanelBody className="flex flex-col divide-y divide-[#f1f5f9]">
            {pendingHandovers.map((h) => (
              <div key={h.id} className="px-3.5 py-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-sans text-[13px] font-bold text-[#1e293b] truncate">{h.driver_name ?? '—'} · <span className="ltr-num">₨{fmt(h.amount_pkr)}</span></p>
                  <p className="font-sans text-[10.5px] text-[#94a3b8] truncate">
                    {h.route_label}{h.vehicle_number ? ` · ${h.vehicle_number}` : ''}{h.counter_label ? ` · → ${h.counter_label}` : ''} · <span className="ltr-num">{h.travel_date}</span>
                  </p>
                  {h.note && <p className="font-sans text-[10.5px] text-[#94a3b8] italic truncate">{h.note}</p>}
                </div>
                <button onClick={() => confirmHandover(h.id)} disabled={confirmingHandoverId === h.id}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">
                  {confirmingHandoverId === h.id ? t('action.loading') : t('mv.confirmHandoverBtn')}
                </button>
              </div>
            ))}
          </FleetPanelBody>
        </FleetPanel>
      )}

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
