'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Gift, Send, Plus, Info, MessageSquare, X, Paperclip } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Offering a lasting object in memory of someone.
 *
 * Nothing is charged here. The form produces a proposal — the committee has
 * to survey the site and agree the real cost before any money changes hands.
 * Taking payment first and finding out afterwards that a water cooler cannot
 * go where the donor imagined is how a gift turns into a grievance.
 */

interface CatalogueItem {
  id: string; name: string; name_ur: string | null
  capital_cost_pkr: number; annual_running_cost_pkr: number; expected_life_years: number | null
}

interface MyOffer {
  id: string; object_no: string; item_name: string; item_name_ur: string | null
  dedicated_to: string; status: string
  estimated_cost: number; actual_cost: number | null; received: number
  annual_running_cost: number; maintenance_mode: string; settled: boolean
  asset_account: string | null
  // What they gave, less what it cost. Positive is theirs; negative is owed.
  account_balance: number
  open_bill: { id: string; vendor_name: string; amount_pkr: number
               invoice_url: string | null; bill_no: string | null } | null
  unread: number; created_at: string
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

const STATUS_TONE: Record<string, string> = {
  proposed: 'bg-amber-100 text-amber-800',
  approved: 'bg-sky-100 text-sky-800',
  funded: 'bg-violet-100 text-violet-800',
  procured: 'bg-violet-100 text-violet-800',
  installed: 'bg-emerald-100 text-emerald-800',
  in_service: 'bg-emerald-100 text-emerald-800',
  needs_repair: 'bg-red-100 text-red-700',
  declined: 'bg-slate-100 text-slate-500',
  retired: 'bg-slate-100 text-slate-500',
}

interface UpkeepCharge {
  id: string; object_no: string; item_name: string
  month: string; amount: number; status: string; due_on: string; paid_on: string | null
}

interface ChatMessage {
  id: string; sender_kind: string; sender_name: string | null
  body: string | null; attachment_url: string | null; attachment_kind: string | null
  is_system: boolean; bill_id: string | null; created_at: string
  bill: { id: string; vendor_name: string; bill_no: string | null
          amount_pkr: number; invoice_url: string | null; status: string } | null
}

export default function PortalEsalESawabPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const { user: portalUser } = usePortalUser()

  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([])
  const [mine, setMine] = useState<MyOffer[]>([])
  const [upkeep, setUpkeep] = useState<UpkeepCharge[]>([])
  const [busy, setBusy] = useState(false)

  // The form stays shut until asked for. What a returning donor wants first is
  // "where has my request got to", not a blank form they have already filled
  // in — so the requests come first and the form is one button away.
  const [showForm, setShowForm] = useState(false)

  // The thread on one request: invoices, questions, and the price both sides
  // settle on.
  const [chatOn, setChatOn] = useState<MyOffer | null>(null)
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [form, setForm] = useState({
    catalogue_id: '', item_name: '', dedicated_to: '', dedicated_to_ur: '',
    relationship: 'father', plaque_text: '', dedication_note: '',
    proposed_location: '', maintenance_mode: 'committee', endowment_pkr: 0,
    donor_is_anonymous: false,
  })

  const load = useCallback(async () => {
    const [{ data: cat }, { data: offers }, { data: dues }] = await Promise.all([
      supabase.from('sadqa_catalogue').select('*').eq('is_active', true).order('display_order'),
      supabase.rpc('my_sadqa_objects'),
      supabase.rpc('my_sadqa_upkeep'),
    ])
    setCatalogue((cat ?? []) as CatalogueItem[])
    setMine((offers ?? []) as MyOffer[])
    setUpkeep((dues ?? []) as UpkeepCharge[])
  }, [supabase])

  useEffect(() => { load() }, [load])

  const openChat = async (o: MyOffer) => {
    setChatOn(o)
    setDraft('')
    const { data } = await supabase.rpc('sadqa_thread', { p_object_id: o.id })
    setThread((data ?? []) as ChatMessage[])
  }

  const send = async () => {
    if (!chatOn || !draft.trim()) return
    setBusy(true)
    const { error } = await supabase.rpc('sadqa_post_message', {
      p_object_id: chatOn.id, p_body: draft.trim(),
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    setDraft('')
    openChat(chatOn)
  }

  const agreeBill = async (billId: string) => {
    if (!confirm(t('pes.agreeConfirm'))) return
    setBusy(true)
    const { error } = await supabase.rpc('sadqa_agree_bill', { p_bill_id: billId })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pes.ok.agreed'))
    setChatOn(null)
    load()
  }

  const queryBill = async (billId: string) => {
    const reason = prompt(t('pes.queryPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('sadqa_reject_bill', { p_bill_id: billId, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pes.ok.queried'))
    if (chatOn) openChat(chatOn)
    load()
  }

  const selected = catalogue.find((c) => c.id === form.catalogue_id)

  const pick = (id: string) => {
    const item = catalogue.find((c) => c.id === id)
    setForm({ ...form, catalogue_id: id, item_name: item?.name ?? '' })
  }

  const submit = async () => {
    if (!form.item_name.trim()) { toast.error(t('pes.err.item')); return }
    if (!form.dedicated_to.trim()) { toast.error(t('pes.err.dedication')); return }
    if (!portalUser) { toast.error(t('pes.err.login')); return }
    setBusy(true)
    const { error } = await supabase.from('sadqa_objects').insert({
      catalogue_id: form.catalogue_id || null,
      item_name: form.item_name.trim(),
      donor_name: portalUser.full_name,
      donor_phone: portalUser.mobile ?? null,
      portal_user_id: portalUser.id,
      donor_is_anonymous: form.donor_is_anonymous,
      dedicated_to: form.dedicated_to.trim(),
      dedicated_to_ur: form.dedicated_to_ur || null,
      relationship: form.relationship,
      plaque_text: form.plaque_text || null,
      dedication_note: form.dedication_note || null,
      proposed_location: form.proposed_location || null,
      maintenance_mode: form.maintenance_mode,
      endowment_pkr: form.maintenance_mode === 'endowed' ? form.endowment_pkr : 0,
      capital_cost_pkr: selected?.capital_cost_pkr ?? 0,
      annual_running_cost_pkr: selected?.annual_running_cost_pkr ?? 0,
      status: 'proposed',
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pes.ok.submitted'))
    setShowForm(false)
    setForm({
      catalogue_id: '', item_name: '', dedicated_to: '', dedicated_to_ur: '',
      relationship: 'father', plaque_text: '', dedication_note: '',
      proposed_location: '', maintenance_mode: 'committee', endowment_pkr: 0,
      donor_is_anonymous: false,
    })
    load()
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <Gift size={24} className="text-dp-secondary" /> {t('pes.title')}
        </h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pes.blurb')}</p>
      </div>

      {/* ── What I have already asked for ──────────────────────────────
          First, because a donor coming back wants to know where their request
          got to — not a blank form they have already filled in once. */}
      {mine.length > 0 && (
        <div className="mb-6">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-3">{t('pes.myOffers')}</h2>
          <div className="space-y-2.5">
            {mine.map((o) => (
              <div key={o.id} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">
                      {o.item_name} <span className="font-normal text-dp-on-surface-variant">· {o.object_no}</span>
                    </p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {t('es.inMemoryOf')} {o.dedicated_to}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_TONE[o.status] ?? 'bg-slate-100'}`}>
                    {t(`es.status.${o.status}`)}
                  </span>
                </div>

                {/* Estimate, bill and where the donor stands — the three
                    numbers the whole flow exists to keep honest. */}
                <div className="flex flex-wrap gap-x-6 gap-y-1 font-sans text-[12.5px] mb-2">
                  <span className="text-dp-on-surface-variant">
                    {t('pes.estimate')} <span className="font-semibold text-dp-on-surface">Rs {fmt(o.estimated_cost)}</span>
                  </span>
                  {o.received > 0 && (
                    <span className="text-dp-on-surface-variant">
                      {t('pes.youSent')} <span className="font-semibold text-dp-on-surface">Rs {fmt(o.received)}</span>
                    </span>
                  )}
                  {o.actual_cost ? (
                    <span className="text-dp-on-surface-variant">
                      {t('pes.actualBill')} <span className="font-semibold text-dp-on-surface">Rs {fmt(o.actual_cost)}</span>
                    </span>
                  ) : null}
                  {o.account_balance !== 0 && (
                    <span className={o.account_balance > 0 ? 'text-dp-secondary font-semibold' : 'text-amber-700 font-semibold'}>
                      {o.account_balance > 0
                        ? t('pes.inYourCredit').replace('{amt}', fmt(o.account_balance))
                        : t('pes.youOwe').replace('{amt}', fmt(-o.account_balance))}
                    </span>
                  )}
                </div>

                {o.asset_account && (
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-2">
                    {t('pes.assetAccount')} <span className="font-mono">{o.asset_account}</span>
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <button onClick={() => openChat(o)}
                    className="inline-flex items-center gap-1.5 font-sans text-[12.5px] font-bold text-dp-secondary hover:underline">
                    <MessageSquare size={14} /> {t('pes.messages')}
                    {o.unread > 0 && (
                      <span className="ms-1 bg-dp-secondary text-white rounded-full px-1.5 text-[10px]">{o.unread}</span>
                    )}
                  </button>

                  {o.open_bill && (
                    <span className="inline-flex items-center gap-2 bg-dp-surface-container-low rounded-lg px-3 py-1.5">
                      <span className="font-sans text-[12px] text-dp-on-surface">
                        {t('pes.billWaiting').replace('{amt}', fmt(o.open_bill.amount_pkr))}
                      </span>
                      <button onClick={() => agreeBill(o.open_bill!.id)} disabled={busy}
                        className="font-sans text-[12px] font-bold text-white bg-dp-secondary px-2.5 py-1 rounded disabled:opacity-50">
                        {t('pes.agree')}
                      </button>
                      <button onClick={() => queryBill(o.open_bill!.id)}
                        className="font-sans text-[12px] font-bold text-dp-on-surface-variant hover:underline">
                        {t('pes.query')}
                      </button>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Upkeep the donor took on themselves ────────────────────────── */}
      {upkeep.length > 0 && (
        <div className="mb-6">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-1">{t('pes.upkeepTitle')}</h2>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('pes.upkeepBlurb')}</p>
          <div className="bg-white border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant">
            {upkeep.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="font-sans text-[13px] text-dp-on-surface">
                  {c.item_name} · {new Date(c.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-sans text-[13px] font-semibold">Rs {fmt(c.amount)}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                    c.status === 'paid' ? 'bg-emerald-100 text-emerald-700'
                      : c.status === 'announced' ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-500'}`}>
                    {t(`pes.upkeep.${c.status}`)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── The form, only when asked for ──────────────────────────────── */}
      {!showForm ? (
        <button onClick={() => setShowForm(true)}
          className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-dp-outline-variant hover:border-dp-secondary text-dp-primary py-4 rounded-lg font-sans font-semibold transition-colors">
          <Plus size={17} /> {mine.length > 0 ? t('pes.offerAnother') : t('pes.offerFirst')}
        </button>
      ) : (
      <>
      {/* ── What the donor needs to know before they commit ─────────────
          The estimate is a catalogue figure; the shop in Chakwal charges what
          it charges. Saying so here is what stops the difference feeling like
          something the committee did to them later. */}
      <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3.5 mb-5">
        <Info size={17} className="text-dp-secondary shrink-0 mt-0.5" />
        <div>
          <p className="font-sans text-[15px] leading-[2] text-dp-on-surface font-bold"
            style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
            {t('pes.priceNoteUr')}
          </p>
          <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed mt-1">
            {t('pes.priceNote')}
          </p>
        </div>
      </div>

      {/* ── Choose what to give ─────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-3">{t('pes.chooseItem')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-4">
          {catalogue.map((c) => (
            <button key={c.id} onClick={() => pick(c.id)}
              className={`text-start px-3.5 py-3 rounded-lg border-2 transition-all cursor-pointer ${form.catalogue_id === c.id ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:border-dp-secondary/40'}`}>
              <p className="font-sans text-[14px] font-bold text-dp-on-surface">{c.name}</p>
              {c.name_ur && <p className="font-sans text-[13px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{c.name_ur}</p>}
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">
                Rs {fmt(c.capital_cost_pkr)}
                {c.annual_running_cost_pkr > 0 && (
                  <span className="block text-[11.5px]">
                    {t('pes.runningCost')} Rs {fmt(c.annual_running_cost_pkr)}/{t('es.year')}
                  </span>
                )}
              </p>
            </button>
          ))}
        </div>

        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pes.orSomethingElse')}</label>
        <input value={form.item_name} onChange={(e) => setForm({ ...form, item_name: e.target.value, catalogue_id: '' })}
          placeholder={t('pes.itemPlaceholder')} className="input-field" />
      </div>

      {/* ── The dedication ──────────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-1">{t('pes.dedication')}</h2>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('pes.dedicationHelp')}</p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pes.f.inMemoryOf')}</label>
            <input value={form.dedicated_to} onChange={(e) => setForm({ ...form, dedicated_to: e.target.value })} className="input-field" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
            <input value={form.dedicated_to_ur} onChange={(e) => setForm({ ...form, dedicated_to_ur: e.target.value })}
              className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pes.f.relationship')}</label>
            <select value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} className="input-field">
              {['father', 'mother', 'brother', 'sister', 'son', 'daughter', 'husband', 'wife', 'grandparent', 'relative', 'friend', 'self', 'other'].map((r) => (
                <option key={r} value={r}>{t(`es.rel.${r}`)}</option>
              ))}
            </select>
          </div>
        </div>

        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pes.f.plaqueText')}</label>
        <input value={form.plaque_text} maxLength={60}
          onChange={(e) => setForm({ ...form, plaque_text: e.target.value })}
          placeholder={t('pes.f.plaquePlaceholder')} className="input-field" />
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1 mb-3">
          {form.plaque_text.length}/60 · {t('pes.f.plaqueHint')}
        </p>

        {/* What it will actually look like on the object. */}
        {form.plaque_text && (
          <div className="inline-block px-5 py-3 rounded border-[3px] border-dp-outline bg-dp-surface-container-low mb-3">
            <p className="font-sans text-[13px] font-bold tracking-[0.06em] text-center">{form.plaque_text}</p>
          </div>
        )}

        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pes.f.note')}</label>
        <textarea value={form.dedication_note} onChange={(e) => setForm({ ...form, dedication_note: e.target.value })}
          rows={2} className="input-field resize-none" />
      </div>

      {/* ── Where, and who keeps it running ─────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface mb-3">{t('pes.placement')}</h2>

        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pes.f.location')}</label>
        <input value={form.proposed_location} onChange={(e) => setForm({ ...form, proposed_location: e.target.value })}
          placeholder={t('pes.f.locationPlaceholder')} className="input-field mb-1.5" />
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('pes.f.locationHint')}</p>

        <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-2">{t('pes.f.maintenance')}</label>
        <div className="space-y-2 mb-3">
          {([
            ['committee', 'pes.mode.committee', 'pes.mode.committeeHelp'],
            ['donor', 'pes.mode.donor', 'pes.mode.donorHelp'],
            ['endowed', 'pes.mode.endowed', 'pes.mode.endowedHelp'],
          ] as const).map(([value, label, help]) => (
            <label key={value} className={`flex items-start gap-2.5 px-3.5 py-3 rounded-lg border-2 cursor-pointer transition-all ${form.maintenance_mode === value ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant'}`}>
              <input type="radio" name="maintenance" checked={form.maintenance_mode === value}
                onChange={() => setForm({ ...form, maintenance_mode: value })} className="accent-dp-secondary mt-0.5" />
              <span>
                <span className="block font-sans text-[13.5px] font-semibold text-dp-on-surface">{t(label)}</span>
                <span className="block font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t(help)}</span>
              </span>
            </label>
          ))}
        </div>

        {form.maintenance_mode === 'endowed' && (
          <div className="mb-3">
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pes.f.endowment')}</label>
            <input type="number" min={0} value={form.endowment_pkr || ''}
              onChange={(e) => setForm({ ...form, endowment_pkr: +e.target.value })} className="input-field" />
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
          <input type="checkbox" checked={form.donor_is_anonymous}
            onChange={(e) => setForm({ ...form, donor_is_anonymous: e.target.checked })} className="accent-dp-secondary" />
          {t('pes.f.anonymous')}
        </label>
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('pes.f.anonymousHint')}</p>
      </div>

      <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-4 py-3 mb-4">
        {t('pes.noPaymentYet')}
      </p>

      <button disabled={busy} onClick={submit}
        className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
        <Send size={16} /> {busy ? t('action.saving') : t('pes.submit')}
      </button>

      </>
      )}


      {/* ── The thread on one request ──────────────────────────────────
          Where the invoice is shown and the price is agreed. Kept as a record
          rather than a chat that can be cleared, because it is the evidence of
          what both sides settled on. */}
      {chatOn && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4 z-50">
          <div className="bg-white w-full sm:max-w-lg sm:rounded-lg max-h-[90vh] flex flex-col">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between shrink-0">
              <div className="min-w-0">
                <h3 className="font-heading text-[15px] font-bold truncate">{chatOn.item_name}</h3>
                <p className="font-sans text-[11.5px] opacity-85">{chatOn.object_no}</p>
              </div>
              <button onClick={() => setChatOn(null)}><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-dp-surface-container-low">
              {thread.length === 0 && (
                <p className="font-sans text-[13px] text-dp-on-surface-variant text-center py-6">
                  {t('pes.noMessages')}
                </p>
              )}
              {thread.map((m) => (
                <div key={m.id}
                  className={`max-w-[85%] rounded-lg px-3.5 py-2.5 ${
                    m.sender_kind === 'donor'
                      ? 'ms-auto bg-dp-secondary text-white'
                      : 'me-auto bg-white border border-dp-outline-variant'}`}>
                  <p className={`font-sans text-[11px] font-semibold mb-0.5 ${
                    m.sender_kind === 'donor' ? 'text-white/80' : 'text-dp-on-surface-variant'}`}>
                    {m.sender_name ?? (m.sender_kind === 'donor' ? t('pes.you') : t('pes.committee'))}
                  </p>
                  {m.body && (
                    <p className={`font-sans text-[13px] leading-relaxed whitespace-pre-wrap ${
                      m.sender_kind === 'donor' ? 'text-white' : 'text-dp-on-surface'}`}>
                      {m.body}
                    </p>
                  )}
                  {m.attachment_url && (
                    <a href={m.attachment_url} target="_blank" rel="noreferrer"
                      className={`inline-flex items-center gap-1.5 font-sans text-[12px] font-bold mt-1.5 underline ${
                        m.sender_kind === 'donor' ? 'text-white' : 'text-dp-secondary'}`}>
                      <Paperclip size={12} /> {t(`pes.att.${m.attachment_kind ?? 'other'}`)}
                    </a>
                  )}

                  {/* An offer sitting in the thread, answerable in place. */}
                  {m.bill && m.bill.status === 'proposed' && (
                    <div className="mt-2.5 pt-2.5 border-t border-dp-outline-variant/40">
                      <p className="font-sans text-[12.5px] font-bold text-dp-on-surface mb-1.5">
                        {m.bill.vendor_name} · Rs {fmt(m.bill.amount_pkr)}
                      </p>
                      {m.bill.invoice_url && (
                        <a href={m.bill.invoice_url} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1.5 font-sans text-[12px] font-bold text-dp-secondary underline mb-2">
                          <Paperclip size={12} /> {t('pes.viewInvoice')}
                        </a>
                      )}
                      <div className="flex gap-2 mt-1">
                        <button onClick={() => agreeBill(m.bill!.id)} disabled={busy}
                          className="bg-dp-secondary text-white font-sans text-[12px] font-bold px-3 py-1.5 rounded disabled:opacity-50">
                          {t('pes.agree')}
                        </button>
                        <button onClick={() => queryBill(m.bill!.id)}
                          className="border border-dp-outline-variant font-sans text-[12px] font-bold px-3 py-1.5 rounded text-dp-on-surface">
                          {t('pes.query')}
                        </button>
                      </div>
                    </div>
                  )}
                  {m.bill && m.bill.status === 'agreed' && (
                    <p className="font-sans text-[11.5px] font-bold mt-1.5 opacity-80">
                      {t('pes.billAgreed')}
                    </p>
                  )}
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-dp-outline-variant flex gap-2 shrink-0">
              <input value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder={t('pes.writeMessage')}
                className="flex-1 border border-dp-outline-variant rounded-lg px-3 py-2 font-sans text-[13.5px] focus:border-dp-secondary outline-none" />
              <button onClick={send} disabled={busy || !draft.trim()}
                className="bg-dp-primary text-white px-4 rounded-lg disabled:opacity-40">
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
