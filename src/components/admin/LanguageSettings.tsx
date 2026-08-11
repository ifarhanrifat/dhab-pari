'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Save, Search, RotateCcw, Lock } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { messages, allMessageKeys } from '@/lib/i18n/messages'

interface TermRow {
  id: string
  category: string
  code: string
  label_en: string
  label_ur: string
  sort_order: number
}

const CATEGORY_LABEL: Record<string, { en: string; ur: string }> = {
  voucher_type: { en: 'Voucher Types', ur: 'واؤچر کی اقسام' },
  account_type: { en: 'Account Types', ur: 'اکاؤنٹ کی اقسام' },
  report_column: { en: 'Report Columns', ur: 'رپورٹ کے کالم' },
  status: { en: 'Statuses', ur: 'حالتیں' },
  system: { en: 'Accounting Systems', ur: 'اکاؤنٹنگ سسٹم' },
}

/**
 * Two editors, because the two kinds of text behave differently.
 *
 * Terminology is a fixed vocabulary the database stores — voucher types,
 * account types, column headings. The `code` column is what every query
 * filters on and is deliberately not editable; only its two labels are. A
 * trigger enforces that server-side too, so a careless screen cannot break
 * stored data.
 *
 * Wording is the interface dictionary that ships with the code. A village only
 * stores what it changed, so upgrades keep arriving translated.
 */
export function LanguageSettings() {
  const supabase = createClient()
  const { locale, isUrdu, t } = useLocale()

  const [terms, setTerms] = useState<TermRow[]>([])
  const [dirtyTerms, setDirtyTerms] = useState<Record<string, Partial<TermRow>>>({})
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [dirtyWords, setDirtyWords] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'terms' | 'wording'>('terms')

  const load = useCallback(async () => {
    const [{ data: tRows }, { data: oRows }] = await Promise.all([
      supabase.from('term_labels').select('*').order('category').order('sort_order'),
      supabase.from('ui_overrides').select('locale, key, value'),
    ])
    setTerms((tRows ?? []) as TermRow[])
    const map: Record<string, string> = {}
    for (const r of (oRows ?? []) as { locale: string; key: string; value: string }[]) {
      map[`${r.locale}.${r.key}`] = r.value
    }
    setOverrides(map)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const saveTerms = async () => {
    const edits = Object.entries(dirtyTerms)
    if (edits.length === 0) { toast.error('Nothing changed'); return }
    setSaving(true)
    for (const [id, patch] of edits) {
      // Only the labels are sent. Sending code/category would be rejected by
      // the trigger, and there is no reason for this screen to try.
      const { error } = await supabase.from('term_labels')
        .update({ label_en: patch.label_en, label_ur: patch.label_ur })
        .eq('id', id)
      if (error) { toast.error(friendlyError(error)); setSaving(false); return }
    }
    setSaving(false)
    setDirtyTerms({})
    toast.success(`${edits.length} term${edits.length > 1 ? 's' : ''} saved — reload to see them everywhere`)
    load()
  }

  const saveWording = async () => {
    const edits = Object.entries(dirtyWords)
    if (edits.length === 0) { toast.error('Nothing changed'); return }
    setSaving(true)
    for (const [key, value] of edits) {
      const shipped = messages[locale][key] ?? ''
      if (!value.trim() || value.trim() === shipped) {
        // Matching the shipped word means "no override" — storing it would
        // freeze this village on today's wording and stop future improvements
        // reaching them.
        const { error } = await supabase.from('ui_overrides').delete().eq('locale', locale).eq('key', key)
        if (error) { toast.error(friendlyError(error)); setSaving(false); return }
      } else {
        const { error } = await supabase.from('ui_overrides')
          .upsert({ locale, key, value: value.trim(), updated_at: new Date().toISOString() },
                  { onConflict: 'locale,key' })
        if (error) { toast.error(friendlyError(error)); setSaving(false); return }
      }
    }
    setSaving(false)
    setDirtyWords({})
    toast.success('Wording saved — reload to see it everywhere')
    load()
  }

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out: Record<string, TermRow[]> = {}
    for (const r of terms) {
      if (q && !(`${r.code} ${r.label_en} ${r.label_ur}`.toLowerCase().includes(q))) continue
      ;(out[r.category] ??= []).push(r)
    }
    return out
  }, [terms, search])

  const wordingKeys = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allMessageKeys.slice(0, 60)
    return allMessageKeys.filter((k) =>
      k.toLowerCase().includes(q) ||
      (messages.en[k] ?? '').toLowerCase().includes(q) ||
      (messages.ur[k] ?? '').toLowerCase().includes(q)
    )
  }, [search])

  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg p-5">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          onClick={() => setTab('terms')}
          className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === 'terms' ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}
        >
          {t('settings.terminology')}
        </button>
        <button
          onClick={() => setTab('wording')}
          className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === 'wording' ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}
        >
          {t('settings.wording')}
        </button>
      </div>

      <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
        {tab === 'terms' ? t('settings.terminology.blurb') : t('settings.wording.blurb')}
      </p>

      <div className="relative mb-4">
        <Search size={15} className="absolute top-1/2 -translate-y-1/2 left-3 text-dp-outline" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('settings.wording.searchPlaceholder')}
          className="input-field ps-9"
        />
      </div>

      {tab === 'terms' ? (
        <>
          <div className="space-y-5 max-h-[520px] overflow-y-auto pe-1">
            {Object.entries(grouped).map(([category, rows]) => (
              <div key={category}>
                <p className="font-sans text-[12px] font-bold uppercase tracking-[0.08em] text-dp-outline mb-2">
                  {isUrdu ? (CATEGORY_LABEL[category]?.ur ?? category) : (CATEGORY_LABEL[category]?.en ?? category)}
                </p>
                <div className="space-y-2">
                  {rows.map((r) => {
                    const patch = dirtyTerms[r.id] ?? {}
                    return (
                      <div key={r.id} className="grid grid-cols-1 sm:grid-cols-[minmax(0,150px)_1fr_1fr] gap-2 items-center">
                        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-dp-on-surface-variant bg-dp-surface-container-low rounded px-2 py-1.5" title={t('settings.term.codeLocked')}>
                          <Lock size={11} className="shrink-0 opacity-60" /> {r.code}
                        </span>
                        <input
                          value={patch.label_en ?? r.label_en}
                          onChange={(e) => setDirtyTerms({ ...dirtyTerms, [r.id]: { ...patch, label_en: e.target.value, label_ur: patch.label_ur ?? r.label_ur } })}
                          className="input-field !py-2 text-[13.5px]"
                          dir="ltr"
                        />
                        <input
                          value={patch.label_ur ?? r.label_ur}
                          onChange={(e) => setDirtyTerms({ ...dirtyTerms, [r.id]: { ...patch, label_ur: e.target.value, label_en: patch.label_en ?? r.label_en } })}
                          className="input-field !py-2 text-[14px]"
                          dir="rtl"
                          style={{ fontFamily: 'var(--font-urdu), serif' }}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            {Object.keys(grouped).length === 0 && (
              <p className="text-center py-8 font-sans text-[13.5px] text-dp-on-surface-variant">{t('settings.wording.noResults')}</p>
            )}
          </div>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-3">{t('settings.term.codeLocked')}</p>
          <button onClick={saveTerms} disabled={saving || Object.keys(dirtyTerms).length === 0}
            className="mt-3 flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            <Save size={16} /> {saving ? t('action.saving') : t('action.save')}
          </button>
        </>
      ) : (
        <>
          <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">
            Editing the <strong>{locale === 'ur' ? 'Urdu' : 'English'}</strong> wording — switch language to edit the other.
            Leave a box empty to go back to the shipped word.
          </p>
          <div className="space-y-2 max-h-[520px] overflow-y-auto pe-1">
            {wordingKeys.map((key) => {
              const shipped = messages[locale][key] ?? messages.en[key] ?? ''
              const stored = overrides[`${locale}.${key}`] ?? ''
              const current = dirtyWords[key] ?? stored
              return (
                <div key={key} className="grid grid-cols-1 sm:grid-cols-[minmax(0,190px)_1fr_1fr] gap-2 items-center">
                  <span className="font-mono text-[11px] text-dp-outline truncate" title={key}>{key}</span>
                  <span className="font-sans text-[13px] text-dp-on-surface-variant truncate"
                    dir={locale === 'ur' ? 'rtl' : 'ltr'}
                    style={locale === 'ur' ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
                    title={shipped}>
                    {shipped}
                  </span>
                  <div className="flex items-center gap-1">
                    <input
                      value={current}
                      onChange={(e) => setDirtyWords({ ...dirtyWords, [key]: e.target.value })}
                      placeholder={t('settings.wording.shippedDefault')}
                      className="input-field !py-2 text-[13.5px] flex-1"
                      dir={locale === 'ur' ? 'rtl' : 'ltr'}
                      style={locale === 'ur' ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
                    />
                    {(stored || dirtyWords[key]) && (
                      <button
                        onClick={() => setDirtyWords({ ...dirtyWords, [key]: '' })}
                        title={t('settings.wording.reset')}
                        className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer shrink-0"
                      >
                        <RotateCcw size={14} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {wordingKeys.length === 0 && (
              <p className="text-center py-8 font-sans text-[13.5px] text-dp-on-surface-variant">{t('settings.wording.noResults')}</p>
            )}
          </div>
          {!search && (
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">
              Showing the first 60 — search to find any other word.
            </p>
          )}
          <button onClick={saveWording} disabled={saving || Object.keys(dirtyWords).length === 0}
            className="mt-3 flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            <Save size={16} /> {saving ? t('action.saving') : t('action.save')}
          </button>
        </>
      )}
    </div>
  )
}
