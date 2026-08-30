'use client'

// Every donor with either real giving history or a manual grant, their
// current tier, and a way to hand-grant the honorary Sarchashma (Wellspring)
// tier to committee members — migration 310. The 4 earned tiers' thresholds
// are edited from Settings → Donors & Projects → Donor Badges, not here;
// this page is about individual donors, not the rules.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search, Award } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonorBadge } from '@/components/public/DonorBadge'
import { DONOR_BADGE_TIERS, DONOR_BADGE_INFO, type DonorBadgeTier } from '@/lib/donorBadges'

interface Row {
  portal_user_id: string; full_name: string; name_ur: string | null; username: string | null; mobile: string
  manual_badge_tier: DonorBadgeTier | null; badge_tier: DonorBadgeTier | null; total_donated_pkr: number
}

const fmt = (n: number) => Number(n || 0).toLocaleString()

export default function DonorBadgesPage() {
  const { t, isUrdu } = useLocale()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('donor_badges_admin').select('*').order('total_donated_pkr', { ascending: false })
    setRows((data ?? []) as Row[])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.full_name.toLowerCase().includes(q) || (r.username ?? '').toLowerCase().includes(q) || r.mobile.includes(q))
  }, [rows, search])

  const grant = async (portalUserId: string, tier: DonorBadgeTier | null) => {
    setSavingId(portalUserId)
    const { error } = await supabase.rpc('set_donor_manual_badge', { p_portal_user_id: portalUserId, p_tier: tier })
    setSavingId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(tier ? t('db.grantedToast') : t('db.clearedToast'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
          <Award size={26} className="text-dp-secondary" /> {t('db.title')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('db.blurb')}</p>
      </div>

      <div className="relative mb-5 max-w-sm">
        <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-dp-on-surface-variant" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('db.searchPlaceholder')}
          className="input-field ps-9" />
      </div>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant">{t('action.loading')}</div>}
      {!loading && filtered.length === 0 && <div className="text-center py-12 text-dp-on-surface-variant">{t('db.noDonors')}</div>}

      <div className="space-y-2.5">
        {!loading && filtered.map((r) => (
          <div key={r.portal_user_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{r.full_name}</p>
                {r.username && <span className="font-sans text-[12px] text-dp-on-surface-variant">@{r.username}</span>}
                <DonorBadge tier={r.badge_tier} isUrdu={isUrdu} />
                {r.manual_badge_tier && (
                  <span className="font-sans text-[10px] font-bold text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">{t('db.manualBadge')}</span>
                )}
              </div>
              <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">
                {t('db.totalGiven')}: <strong className="text-dp-on-surface">{fmt(r.total_donated_pkr)}</strong>
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <select
                value={r.manual_badge_tier ?? ''}
                disabled={savingId === r.portal_user_id}
                onChange={(e) => grant(r.portal_user_id, (e.target.value || null) as DonorBadgeTier | null)}
                className="input-field !py-2 text-[13px] max-w-[220px]"
              >
                <option value="">{t('db.noOverride')}</option>
                {DONOR_BADGE_TIERS.map((tier) => (
                  <option key={tier} value={tier}>{isUrdu ? DONOR_BADGE_INFO[tier].labelUr : DONOR_BADGE_INFO[tier].labelEn}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
