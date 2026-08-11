'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { messages, type Locale } from './messages'

interface TermEntry { en: string; ur: string }

interface LocaleContextValue {
  locale: Locale
  isUrdu: boolean
  dir: 'ltr' | 'rtl'
  /** Interface wording: shipped dictionary, with any village override applied. */
  t: (key: string, fallback?: string) => string
  /** Editable terminology: voucher types, account types, report columns. */
  term: (category: string, code: string | null | undefined, fallback?: string) => string
  setLocale: (l: Locale | null) => Promise<void>
  ready: boolean
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

const STORAGE_KEY = 'dp_locale'

// Whether Urdu also MIRRORS the layout, as opposed to only changing the words.
//
// Deliberately off. Mirroring works — every direction class was converted to a
// logical property so `dir="rtl"` on <html> flips the entire app correctly —
// but flipping moves the sidebar to the right and the content to the left, and
// people who already know where things are should not have to relearn the
// screen just because they switched language. Same layout, Urdu words.
//
// The conversion was not wasted: it is what makes turning this on a one-line
// change if the committee later decides they want a fully mirrored interface.
const RTL_READY = false

/**
 * One place that knows what language this person reads, and every word the
 * interface needs to say in it.
 *
 * Three sources, merged once per session rather than per component:
 *   1. `messages` — the dictionary shipped in the code. Always complete, so a
 *      newly sold system is fully Urdu with nothing to configure.
 *   2. `ui_overrides` — only the words a village deliberately changed.
 *   3. `term_labels` — voucher types, account types, report columns, seeded
 *      and editable because committees genuinely disagree about the right Urdu
 *      word for these.
 *
 * The language itself is: this user's own preference, else the committee
 * default from site_settings, else English — resolved server-side by
 * my_language() so the answer is the same everywhere.
 */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  // Always starts English, even when localStorage says Urdu.
  //
  // Reading the stored choice here instead produced a hydration error: the
  // server has no localStorage, so it renders English, while the client renders
  // Urdu — React sees two different trees and throws the whole thing away.
  // The stored language is applied immediately after mount below, which costs a
  // brief flash of English and is the price of the markup matching.
  const [locale, setLocaleState] = useState<Locale>('en')
  const [terms, setTerms] = useState<Record<string, TermEntry>>({})
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [ready, setReady] = useState(false)

  // Runs after hydration, so it cannot disagree with the server-rendered HTML.
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'ur') setLocaleState('ur')
  }, [])

  useEffect(() => {
    const supabase = createClient()
    let cancelled = false
    supabase.rpc('language_pack').then(({ data, error }) => {
      if (cancelled || error || !data) { setReady(true); return }
      const row = Array.isArray(data) ? data[0] : data
      if (!row) { setReady(true); return }
      const lang: Locale = row.language === 'ur' ? 'ur' : 'en'
      setLocaleState(lang)
      window.localStorage.setItem(STORAGE_KEY, lang)
      setTerms((row.terms ?? {}) as Record<string, TermEntry>)
      setOverrides((row.overrides ?? {}) as Record<string, string>)
      setReady(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const el = document.documentElement
    el.lang = locale
    // Direction is deliberately NOT flipped yet. Turning on dir="rtl" mirrors
    // the page, but only elements using logical CSS properties follow it —
    // and this app still has ~470 physical ones (ml-, pl-, text-start, left-)
    // across 132 files. Flipping before converting them produced exactly what
    // you would expect: Urdu text in a layout torn in half.
    //
    // So Urdu reads in the normal start-to-right layout until that sweep is
    // done, which is legible and honest. Flip this to RTL_READY once the
    // conversion lands, and the whole app mirrors from this one line.
    if (RTL_READY) el.dir = locale === 'ur' ? 'rtl' : 'ltr'
  }, [locale])

  const t = useCallback((key: string, fallback?: string) => {
    const override = overrides[`${locale}.${key}`]
    if (override) return override
    // English is the last resort rather than the raw key: a missing Urdu
    // translation should read as an untranslated word, not as "nav.billing".
    return messages[locale][key] ?? messages.en[key] ?? fallback ?? key
  }, [locale, overrides])

  const term = useCallback((category: string, code: string | null | undefined, fallback?: string) => {
    if (!code) return fallback ?? ''
    const entry = terms[`${category}.${code}`]
    if (!entry) return fallback ?? code
    return (locale === 'ur' ? entry.ur : entry.en) || entry.en || code
  }, [locale, terms])

  const setLocale = useCallback(async (l: Locale | null) => {
    const effective: Locale = l ?? 'en'
    setLocaleState(effective)
    window.localStorage.setItem(STORAGE_KEY, effective)
    const supabase = createClient()
    // Null clears the personal preference and returns them to the committee
    // default; the RPC ignores callers with no admin/portal row, so a
    // signed-out visitor just keeps the local choice.
    await supabase.rpc('set_my_language', { p_lang: l })
  }, [])

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    isUrdu: locale === 'ur',
    dir: RTL_READY && locale === 'ur' ? 'rtl' : 'ltr',
    t, term, setLocale, ready,
  }), [locale, t, term, setLocale, ready])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

/**
 * Falls back to English rather than throwing when used outside the provider.
 * A missing provider should not blank a page — it should read as English,
 * which is obvious and harmless.
 */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (ctx) return ctx
  return {
    locale: 'en',
    isUrdu: false,
    dir: 'ltr',
    t: (key: string, fallback?: string) => messages.en[key] ?? fallback ?? key,
    term: (_c: string, code: string | null | undefined, fallback?: string) => fallback ?? code ?? '',
    setLocale: async () => {},
    ready: true,
  }
}

/** Shorthand for the common case. */
export function useT() {
  return useLocale().t
}
