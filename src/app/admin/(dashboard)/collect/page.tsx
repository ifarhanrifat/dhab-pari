'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Truck, Banknote, MessageCircle, MapPin, Phone, Save, MessageSquareWarning } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { SearchableField } from '@/components/admin/SearchablePicker'
import { ReceiptModal } from '@/components/admin/ReceiptModal'
import type { ReceiptData } from '@/components/admin/ReceiptDocument'
import { billBadge, billBadgeClass } from '@/lib/billStatus'
import { normalizePakPhone } from '@/lib/receiptExport'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

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

const complaintCategories = [
  { value: 'low_pressure', label: 'Low Water Pressure' },
  { value: 'no_supply', label: 'No Water Supply' },
  { value: 'water_quality', label: 'Water Quality Issue' },
  { value: 'billing_dispute', label: 'Billing Dispute' },
  { value: 'other', label: 'Other' },
]

export default function CollectPaymentPage() {
  const { t } = useLocale()
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
  const [lastCollectedAmount, setLastCollectedAmount] = useState(0)
  const [lastOutstanding, setLastOutstanding] = useState(0)
  const [lastConsumerMobile, setLastConsumerMobile] = useState<string | null>(null)

  const [phoneInput, setPhoneInput] = useState('')
  const [savingPhone, setSavingPhone] = useState(false)

  const [complaintCategory, setComplaintCategory] = useState('')
  const [complaintText, setComplaintText] = useState('')
  const [savingComplaint, setSavingComplaint] = useState(false)
  const [showComplaintForm, setShowComplaintForm] = useState(false)

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

  const savePhone = async () => {
    if (!selectedConsumer || !phoneInput.trim()) { toast.error('Enter a phone number'); return }
    setSavingPhone(true)
    const { error } = await supabase.rpc('set_consumer_contact_number', { p_consumer_id: selectedConsumer.consumer_id, p_mobile: phoneInput.trim() })
    setSavingPhone(false)
    if (error) { toast.error(friendlyError(error)); return }
    setConsumers((cur) => cur.map((c) => (c.consumer_id === selectedConsumer.consumer_id ? { ...c, mobile: phoneInput.trim() } : c)))
    setPhoneInput('')
    toast.success('Phone number saved')
  }

  const logComplaint = async () => {
    if (!me || me === 'loading' || !selectedConsumer) return
    if (!complaintCategory) { toast.error('Select the type of issue'); return }
    setSavingComplaint(true)
    const categoryLabel = complaintCategories.find((c) => c.value === complaintCategory)?.label ?? complaintCategory
    const { data, error } = await supabase.from('complaints').insert({
      system: 'water_supply', category: complaintCategory,
      complainant_name: selectedConsumer.name, phone: selectedConsumer.mobile || null, sector: selectedConsumer.sector || null,
      complaint_text: complaintText.trim() || categoryLabel, source: 'manual',
    }).select('complaint_number').single()
    setSavingComplaint(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(`Complaint ${data.complaint_number} logged`)
    setComplaintCategory('')
    setComplaintText('')
    setShowComplaintForm(false)
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
    if (error) { toast.error(friendlyError(error)); return }

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
    setLastCollectedAmount(amount)
    setLastOutstanding(newOutstanding)
    setLastConsumerMobile(selectedConsumer.mobile)
    toast.success(`Collected ${fmt(amount)} from ${selectedConsumer.name}`)

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

  // Deliberately reads from `receipt`/the last-collected snapshot rather than
  // `selectedConsumer`/`amount` — submit() clears those right after posting
  // (to reset the form for the next collection), so gating this on
  // selectedConsumer meant the button silently did nothing the moment it
  // became visible.
  const notifyViaWhatsApp = (target: NotifyTarget) => {
    if (!target.mobile || !receipt) return
    const msg = encodeURIComponent(
      `${SITE.name} — Payment Collected\n\nCollected ${fmt(lastCollectedAmount)} from ${receipt.accountName} by ${me !== 'loading' && me ? me.full_name : ''}.\n\nPlease check /admin/collectors for the current holding balance.`
    )
    window.open(`https://wa.me/${normalizePakPhone(target.mobile)}?text=${msg}`, '_blank')
  }

  const notifyConsumerViaWhatsApp = () => {
    if (!lastConsumerMobile || !receipt) return
    const intl = normalizePakPhone(lastConsumerMobile)
    if (!intl) { toast.error('No usable phone number for this consumer'); return }
    const msg = encodeURIComponent(
      `${SITE.name} — Payment Received\n\nThank you, ${receipt.accountName}. We received ${fmt(lastCollectedAmount)} against ${receipt.particular}.`
      + (lastOutstanding > 0 ? `\n\nRemaining outstanding on this bill: ${fmt(lastOutstanding)}.` : '\n\nThis bill is now fully paid.')
    )
    window.open(`https://wa.me/${intl}?text=${msg}`, '_blank')
  }

  if (me === 'loading') return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!me || !me.can_collect_payments) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">You don&apos;t have field collector access. Ask an administrator to grant it from User Management.</p>
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <Truck size={26} /> {t('y.collectPayment')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1 flex items-center gap-1.5">
          <MapPin size={13} /> Assigned sectors: {(me.assigned_sectors ?? []).join(', ') || 'None — ask an administrator to assign you a sector'}
        </p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-5 max-w-xl space-y-4">
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.consumer')}</label>
          <SearchableField
            value={selectedConsumerId}
            onChange={pickConsumer}
            placeholder="Search consumer..."
            items={mySectorConsumers.map((c) => ({ id: c.consumer_id, label: c.name, sublabel: c.consumer_id, group: c.sector ?? undefined }))}
          />
        </div>

        {selectedConsumer && !selectedConsumer.mobile && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <p className="font-sans text-[12.5px] font-semibold text-amber-900 mb-2 flex items-center gap-1.5">
              <Phone size={13} /> No phone/WhatsApp number on file — ask {selectedConsumer.name} for one
            </p>
            <div className="flex gap-2">
              <input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="0300-1234567" className="input-field !py-2 flex-1" />
              <button disabled={savingPhone} onClick={savePhone} className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-amber-700 transition-all cursor-pointer disabled:opacity-50 shrink-0">
                <Save size={13} /> {t('action.save')}
              </button>
            </div>
          </div>
        )}

        {selectedConsumer && (
          <>
            {consumerBills.length === 0 ? (
              <p className="font-sans text-[13.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2">{t('f.noOutstanding')}</p>
            ) : (
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('rc.bill')}</label>
                <div className="space-y-1.5">
                  {consumerBills.map((b) => {
                    const badge = billBadge(b)
                    return (
                      <button
                        key={b.id}
                        onClick={() => pickBill(b.id)}
                        className={`w-full text-start flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-pointer ${selectedBillId === b.id ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
                      >
                        <span className="font-sans text-[13px]">
                          {fullMonths[b.month]} {b.year} {b.bill_number && <span className="text-dp-on-surface-variant">#{b.bill_number}</span>}
                          <span className={`ms-2 inline-block px-1.5 py-0.5 rounded font-sans text-[10px] font-bold ${billBadgeClass[badge.tone]}`}>{badge.text}</span>
                        </span>
                        <span className="font-sans text-[13px] font-bold text-dp-error">{fmt(outstanding(b))}</span>
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
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                    <input type="number" min={1} value={amount || ''} onChange={(e) => setAmount(+e.target.value)} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.method')}</label>
                    <select value={method} onChange={(e) => setMethod(e.target.value)} className="input-field">
                      <option value="cash">{t('w.cash')}</option>
                      <option value="jazzcash">{t('w.jazzcash')}</option>
                      <option value="easypaisa">{t('w.easypaisa')}</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.noteOptional')}</label>
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

      {selectedConsumer && (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-5 max-w-xl mt-4">
          {!showComplaintForm ? (
            <button onClick={() => setShowComplaintForm(true)} className="flex items-center gap-2 text-dp-secondary font-sans text-[13.5px] font-semibold hover:underline cursor-pointer">
              <MessageSquareWarning size={15} /> Log an issue for {selectedConsumer.name}
            </button>
          ) : (
            <div className="space-y-3">
              <p className="font-sans text-[13.5px] font-bold text-dp-on-surface flex items-center gap-2"><MessageSquareWarning size={15} /> {t('y.logIssue')}</p>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('y.issueType')}</label>
                <select value={complaintCategory} onChange={(e) => setComplaintCategory(e.target.value)} className="input-field">
                  <option value="">{t('y.selectIssue')}</option>
                  {complaintCategories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('y.detailsEditable')}</label>
                <textarea value={complaintText} onChange={(e) => setComplaintText(e.target.value)} rows={3} className="input-field resize-none" placeholder="Add any details the consumer mentioned..." />
              </div>
              <div className="flex gap-2">
                <button disabled={savingComplaint} onClick={logComplaint} className="flex-1 flex items-center justify-center gap-2 bg-dp-secondary text-white py-2 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                  <Save size={14} /> {savingComplaint ? 'Saving...' : 'Save Complaint'}
                </button>
                <button onClick={() => { setShowComplaintForm(false); setComplaintCategory(''); setComplaintText('') }} className="px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">
                  {t('action.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {receipt && (
        <>
          <ReceiptModal data={receipt} phone={receiptPhone} onClose={() => { setReceipt(null); setNotifyTargets([]) }} />
          <div className="fixed bottom-4 right-4 bg-white border border-dp-outline-variant rounded-lg shadow-lg p-4 max-w-xs z-[110] space-y-3">
            {lastConsumerMobile && (
              <div>
                <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2">{t('y.sendReceiptConsumer')}</p>
                <button onClick={notifyConsumerViaWhatsApp} className="w-full flex items-center gap-1.5 px-2.5 py-1.5 bg-[#25d366] text-white rounded-lg font-sans text-[12px] font-semibold hover:opacity-90 transition-all cursor-pointer">
                  <MessageCircle size={13} /> {t('y.sendReceiptWa')}
                </button>
              </div>
            )}
            {whatsappEnabled && notifyTargets.length > 0 && (
              <div>
                <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-2">{t('y.notifyAccountant')}</p>
                <div className="flex flex-col gap-1.5">
                  {notifyTargets.map((t) => (
                    <button key={t.id} onClick={() => notifyViaWhatsApp(t)} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#25d366] text-white rounded-lg font-sans text-[12px] font-semibold hover:opacity-90 transition-all cursor-pointer">
                      <MessageCircle size={13} /> {t.full_name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
