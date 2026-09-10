'use client'

// Staff side of trust tiers (483) — set CNIC/phone verification and
// village residency per portal user; the score/tier itself is always
// computed live by portal_user_trust(), never stored here.

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { Search, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Row {
  id: string; full_name: string; mobile: string | null
  cnic_verified: boolean; phone_verified: boolean; is_village_resident: boolean
  trust: { tier: 'verified' | 'partial' | 'outsider'; score: number }
}

const TIER_STYLE = {
  verified: { color: '#0f7a4d', bg: '#e9f7ef', Icon: ShieldCheck },
  partial: { color: '#9a5714', bg: '#fdf0e2', Icon: ShieldAlert },
  outsider: { color: '#6b6560', bg: '#f0eded', Icon: ShieldQuestion },
} as const

export default function AdminUserVerificationPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)

  const search = async (q: string) => {
    setQuery(q)
    setLoading(true)
    const { data } = await supabase.rpc('admin_portal_users_with_trust', { p_query: q.trim() || null })
    setRows((data ?? []) as Row[])
    setLoading(false)
  }

  const save = async (row: Row, field: 'cnic_verified' | 'phone_verified' | 'is_village_resident', value: boolean) => {
    setSavingId(row.id)
    const { error } = await supabase.rpc('admin_set_portal_user_verification', {
      p_portal_user_id: row.id,
      p_cnic_verified: field === 'cnic_verified' ? value : row.cnic_verified,
      p_phone_verified: field === 'phone_verified' ? value : row.phone_verified,
      p_is_village_resident: field === 'is_village_resident' ? value : row.is_village_resident,
    })
    setSavingId(null)
    if (error) { toast.error(friendlyError(error)); return }
    search(query)
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('uv.noAccessMessage')}</p></div>
  }

  return (
    <div className="shop-ink-theme">
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('uv.pageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('uv.pageSubtitle')}</p>
      </div>

      <div className="relative mb-5 max-w-sm">
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input value={query} onChange={(e) => search(e.target.value)} placeholder={t('uv.searchPlaceholder')} className="input-field !ps-9" />
      </div>

      {loading && <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>}
      {rows !== null && !loading && rows.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('uv.noResults')}</p>}
      {rows === null && !loading && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('uv.searchHint')}</p>}

      <div className="space-y-2">
        {(rows ?? []).map((row) => {
          const s = TIER_STYLE[row.trust.tier]
          return (
            <div key={row.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{row.full_name}</p>
                {row.mobile && <p className="font-sans text-[12px] text-dp-on-surface-variant ltr-num">{row.mobile}</p>}
              </div>
              <span className="inline-flex items-center gap-1 font-sans text-[11px] font-bold px-2.5 py-1 rounded-full" style={{ background: s.bg, color: s.color }}>
                <s.Icon size={13} /> {t(`tr.tier.${row.trust.tier}`)} · <span className="ltr-num">{row.trust.score}</span>
              </span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer font-sans text-[12.5px]">
                  <input type="checkbox" checked={row.cnic_verified} disabled={savingId === row.id} onChange={(e) => save(row, 'cnic_verified', e.target.checked)} className="accent-dp-secondary" /> {t('uv.cnicLabel')}
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer font-sans text-[12.5px]">
                  <input type="checkbox" checked={row.phone_verified} disabled={savingId === row.id} onChange={(e) => save(row, 'phone_verified', e.target.checked)} className="accent-dp-secondary" /> {t('uv.phoneLabel')}
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer font-sans text-[12.5px]">
                  <input type="checkbox" checked={row.is_village_resident} disabled={savingId === row.id} onChange={(e) => save(row, 'is_village_resident', e.target.checked)} className="accent-dp-secondary" /> {t('uv.residentLabel')}
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
