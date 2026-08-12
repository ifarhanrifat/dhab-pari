'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Gift, Send } from 'lucide-react'
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
  id: string; object_no: string; item_name: string; dedicated_to: string
  status: string; approved_location: string | null; proposed_location: string | null
  capital_cost_pkr: number; created_at: string
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

export default function PortalEsalESawabPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const { user: portalUser } = usePortalUser()

  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([])
  const [mine, setMine] = useState<MyOffer[]>([])
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    catalogue_id: '', item_name: '', dedicated_to: '', dedicated_to_ur: '',
    relationship: 'father', plaque_text: '', dedication_note: '',
    proposed_location: '', maintenance_mode: 'committee', endowment_pkr: 0,
    donor_is_anonymous: false,
  })

  const load = useCallback(async () => {
    const [{ data: cat }, { data: offers }] = await Promise.all([
      supabase.from('sadqa_catalogue').select('*').eq('is_active', true).order('display_order'),
      supabase.from('sadqa_objects').select('id, object_no, item_name, dedicated_to, status, approved_location, proposed_location, capital_cost_pkr, created_at')
        .order('created_at', { ascending: false }),
    ])
    setCatalogue((cat ?? []) as CatalogueItem[])
    setMine((offers ?? []) as MyOffer[])
  }, [supabase])

  useEffect(() => { load() }, [load])

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

      {/* ── What I have offered ─────────────────────────────────────────── */}
      {mine.length > 0 && (
        <div className="mt-8">
          <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-3">{t('pes.myOffers')}</h2>
          <div className="space-y-2.5">
            {mine.map((o) => (
              <div key={o.id} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-sans text-[14px] font-bold text-dp-on-surface">{o.item_name}</p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {t('es.inMemoryOf')} {o.dedicated_to}
                      {(o.approved_location || o.proposed_location) && ` · ${o.approved_location || o.proposed_location}`}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_TONE[o.status] ?? 'bg-slate-100'}`}>
                    {t(`es.status.${o.status}`)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
