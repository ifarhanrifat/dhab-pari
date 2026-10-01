'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface PortalUserLite { id: string; full_name: string; mobile: string }

// Phase 3, 2026-10-01. Real ask: "ask them any portal account so that we
// will just link this to" — replaces a copy-pasted manage link with
// picking a real, already-registered portal account to hand management
// to. Search by mobile or name since that's what an admin actually has
// on hand (a name from the family, or a number).
export function PortalUserSearchPicker({ onPick }: { onPick: (user: PortalUserLite) => void }) {
  const { t } = useLocale()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PortalUserLite[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    const supabase = createClient()
    const { data } = await supabase.from('portal_users').select('id, full_name, mobile')
      .or(`mobile.ilike.%${query.trim()}%,full_name.ilike.%${query.trim()}%`)
      .eq('is_active', true).limit(5)
    setResults((data ?? []) as PortalUserLite[])
    setSearching(false); setSearched(true)
  }

  return (
    <div>
      <div className="flex gap-2">
        <input value={query} onChange={(e) => { setQuery(e.target.value); setSearched(false) }} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), search())}
          placeholder={t('fnd.searchPlaceholder')} className="input-field flex-1" />
        <button type="button" onClick={search} disabled={searching} className="px-3 py-2 bg-dp-secondary text-white rounded-lg cursor-pointer hover:bg-dp-primary transition-all shrink-0 disabled:opacity-50"><Search size={15} /></button>
      </div>
      {results.length > 0 && (
        <div className="mt-2 border border-dp-outline-variant rounded-lg divide-y divide-dp-outline-variant overflow-hidden">
          {results.map((u) => (
            <button key={u.id} type="button" onClick={() => { onPick(u); setResults([]); setQuery(''); setSearched(false) }}
              className="w-full text-start p-2.5 hover:bg-dp-surface-container-low cursor-pointer flex items-center justify-between">
              <span className="font-sans text-[13px] text-dp-on-surface">{u.full_name}</span>
              <span className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{u.mobile}</span>
            </button>
          ))}
        </div>
      )}
      {searched && !searching && results.length === 0 && (
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{t('fnd.noMatch')}</p>
      )}
    </div>
  )
}
