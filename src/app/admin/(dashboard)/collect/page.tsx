'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Truck, Banknote, MessageCircle, MapPin } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { SearchableField } from '@/components/admin/SearchablePicker'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { billBadge, billBadgeClass } from '@/lib/billStatus'
import { normalizePakPhone } from '@/lib/receiptExport'

interface Me { id: string; full_name: string; can_collect_payments: boolean; assigned_sectors: string[] | null }
interface Consumer { consumer_id: string; name: string; mobile: string | null; sector: string | null; status: string }
interface Bill {
  id: string; bill_number: string | null; consumer_id: string; month: number; year: number
  amount_pkr: number; discount_amount: number | null; paid_amount: number | null; due_date: string | null
}
interface NotifyTarget { id: string; full_name: string; mobile: string | null }

const fullMonths = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function outstanding(b: Bill) {
  return Math.max(b.amount_pkr - (b.discount_amount ?? 0), 0) - (b.paid_amount ?? 0)
}

export default function CollectPaymentPage() {
  const supabase = createClient()
  const [me, setMe] = useState<Me | null | 'loading'>('loading')
  const [consumers, setConsumers] = useState<Consumer[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [selectedConsumerId, setSelectedConsumerId] = useState('')
  const [selectedBillId, setSelectedBillId] = useState('')
  const [amount, setAmount] = useState(0)
  const [method, setMethod] = useState('cash')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [receiptPhone, setReceiptPhone] = useState<string | null>(null)
  const [notifyTargets, setNotifyTargets] = useState<NotifyTarget[]>([])
  const [whatsappEnabled, setWhatsappEnabled] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setMe(null); return }
      const { data } = await supabase.from('admin_users').select('id, full_name, can_collect_payments, assigned_sectors').eq('auth_user_id', user.id).single()
      setMe(data ?? null)
    })()
  }, [supabase])

  const load = async () => {
    const [{ data: cRes }, { data: bRes }] = await Promise.all([
      supabase.from('consumers').select('consumer_id, name, mobile, sector, status').eq('status', 'active'),
      supabase.from('bills').select('id, bill_number, consumer_id, month, year, amount_pkr, discount_amount, paid_amount, due_date'),
    ])
    setConsumers(cRes ?? [])
    setBills(bRes ?? [])
  }
  useEffect(() => { if (me && me !== 'loading') load() }, [me])

  const mySectorConsumers = useMemo(() => {
    if (!me || me === 'loading' || !me.assigned_sectors) return []
    return consumers.filter((c) => c.sector && me.assigned_sectors!.includes(c.sector))
  }, [consumers, me])

  const selectedConsumer = mySectorConsumers.find((c) => c.consumer_id === selectedConsumerId) ?? null
  const consumerBills = useMemo(
    () => bills.filter((b) => b.consumer_id === selectedConsumerId && outstanding(b) > 0).sort((a, b) => a.year - b.year || a.month - b.month),
    [bills, selectedConsumerId]
  )
  const selectedBill = consumerBills.find((b) => b.id === selectedBillId) ?? null

  const pickConsumer = (id: string) => {
    setSelectedConsumerId(id)
    setSelectedBillId('')
    setAmount(0)
  }
  const pickBill = (id: string) => {
    setSelectedBillId(id)
    const b = consumerBills.find((x) => x.id === id)
    if (b) setAmount(outstanding(b))
  }

  const submit = async () => {
    if (!me || me === 'loading' || !selectedConsumer || !selectedBill) { toast.error('Select a consumer and bill'); return }
    if (amount <= 0) { toast.error('Enter a valid amount'); return }
    setSaving(true)
    const { data, error } = await supabase.from('payments').insert({
      bill_id: selectedBill.id, consumer_id: selectedConsumer.consumer_id,
      amount_pkr: amount, method, note: note || null, collected_by: me.id,
    }).select('id, receipt_no, paid_date').single()
    setSaving(false)
    if (error) { toast.error(error.message); return }

    const newOutstanding = Math.max(outstanding(selectedBill) - amount, 0)
    setReceipt({
      kind: 'payment',
      receiptNo: data.receipt_no ?? data.id.slice(0, 8).toUpperCase(),
      date: data.paid_date,
      systemLabel: 'Water Supply System',
      accountName: selectedConsumer.name,
      particular: `Against Bill ${selectedBill.bill_number ?? ''} — ${fullMonths[selectedBill.month]} ${selectedBill.year}`,
      amount, balanceAfter: newOutstanding, billOutstandingAfter: newOutstanding,
      collectedByName: me.full_name,
    })
    setReceiptPhone(selectedConsumer.mobile)
    toast.success(`Collected Rs. ${fmt(amount)} from ${selectedConsumer.name}`)

    const { data: pref } = await supabase.from('notification_preferences').select('whatsapp_enabled').eq('event_type', 'collector_payment_collected').single()
    setWhatsappEnabled(!!pref?.whatsapp_enabled)
    if (pref?.whatsapp_enabled) {
      const { data: targets } = await supabase.rpc('get_water_supply_notify_targets')
      setNotifyTargets((targets ?? []).filter((t: NotifyTarget) => t.mobile))
    } else {
      setNotifyTargets([])
    }

    setSelectedConsumerId('')
    setSelectedBillId('')
    setAmount(0)
    setNote('')
    load()
  }

  const notifyViaWhatsApp = (target: NotifyTarget) => {
    if (!target.mobile || !selectedConsumer) return
    const msg = encodeURIComponent(
      `Dhab Pari — Payment Collected\n\nCollected Rs. ${fmt(amount)} from ${receipt?.accountName ?? ''} by ${me !== 'loading' && me ? me.full_name : ''}.\n\nPlease check /admin/collectors for the current holding balance.`
    )
    window.open(`https://wa.me/${normalizePakPhone(target.mobile)}?text=${msg}`, '_blank')
  }

  if (me === 'loading') return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>
  if (!me || !me.can_collect_payments) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">You don&apos;t have field collector access. Ask an administrator to grant it from User Management.</p>
      </div>
    )
  }

  return (
    <>
      <Toaster position="top-right" />
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <Truck size={26} /> Collect Payment
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1 flex items-center gap-1.5">
          <MapPin size={13} /> Assigned sectors: {(me.assigned_sectors ?? []).join(', ') || 'None — ask an administrator to assign you a sector'}
        </p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-5 max-w-xl space-y-4">
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Consumer</label>
          <SearchableField
            value={selectedConsumerId}
            onChange={pickConsumer}
            placeholder="Search consumer..."
            items={mySectorConsumers.map((c) => ({ id: c.consumer_id, label: c.name, sublabel: c.consumer_id, group: c.sector ?? undefined }))}
          />
        </div>

        {selectedConsumer && (
          <>
            {consumerBills.length === 0 ? (
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2">No outstanding bills for this consumer.</p>
            ) : (
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Bill</label>
                <div className="space-y-1.5">
                  {consumerBills.map((b) => {
                    const badge = billBadge(b)
                    return (
                      <button
                        key={b.id}
                        onClick={() => pickBill(b.id)}
                        className={`w-full text-left flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-pointer ${selectedBillId === b.id ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
                      >
                        <span className="font-sans text-[13px]">
                          {fullMonths[b.month]} {b.year} {b.bill_number && <span className="text-dp-on-surface-variant">#{b.bill_number}</span>}
                          <span className={`ml-2 inline-block px-1.5 py-0.5 rounded font-sans text-[10px] font-bold ${billBadgeClass[badge.tone]}`}>{badge.text}</span>
                        </span>
                        <span className="font-sans text-[13px] font-bold text-dp-error">Rs. {fmt(outstanding(b))}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {selectedBill && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Amount (PKR)</label>
                    <input type="number" min={1} value={amount || ''} onChange={(e) => setAmount(+e.target.value)} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Method</label>
                    <select value={method} onChange={(e) => setMethod(e.target.value)} className="input-field">
                      <option value="cash">Cash</option>
                      <option value="jazzcash">JazzCash</option>
                      <option value="easypaisa">Easypaisa</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Note (optional)</label>
                  <input value={note} onChange={(e) => setNote(e.target.value)} className="input-field" placeholder="e.g. paid at doorstep" />
                </div>
                <button disabled={saving} onClick={submit} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                  <Banknote size={16} /> {saving ? 'Recording...' : 'Collect & Record Receipt'}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {receipt && (
        <>
          <ReceiptModal data={receipt} phone={receiptPhone} onClose={() => { setReceipt(null); setNotifyTargets([]) }} />
          {whatsappEnabled && notifyTargets.length > 0 && (
            <div className="fixed bottom-4 right-4 bg-white border border-dp-outline-variant rounded-lg shadow-lg p-4 max-w-xs z-[110]">
              <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2">Notify the accountant via WhatsApp</p>
              <div className="flex flex-col gap-1.5">
                {notifyTargets.map((t) => (
                  <button key={t.id} onClick={() => notifyViaWhatsApp(t)} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#25d366] text-white rounded-lg font-sans text-[12px] font-semibold hover:opacity-90 transition-all cursor-pointer">
                    <MessageCircle size={13} /> {t.full_name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
