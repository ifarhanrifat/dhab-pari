'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { GraduationCap, Heart, Users, X, Send } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Sponsoring a child, in whole or in part.
 *
 * A child is never shown by family name, house or school-plus-photo, and a
 * child whose guardian has not consented to a photograph appears with their
 * initial instead — deliberately indistinguishable from a child who has no
 * photograph on file, so nothing is inferred from its absence.
 *
 * Shares rather than whole sponsorships, because a child who depends on one
 * person is a child who leaves school when that one person's circumstances
 * change.
 */

interface AvailableChild {
  id: string; code: string; first_name: string; first_name_ur: string | null
  gender: string | null; age: number | null; current_class: string | null
  school_location: string; is_orphan: boolean
  annual_package_pkr: number; committed_percent: number; remaining_percent: number
  photo_url: string | null
}

interface MyShare {
  id: string; child_id: string; share_percent: number; annual_amount_pkr: number
  funded_by: string; duration: string; status: string; starts_on: string; ends_on: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function PortalKafalatPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const { user: portalUser } = usePortalUser()

  const [children, setChildren] = useState<AvailableChild[]>([])
  const [myShares, setMyShares] = useState<MyShare[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [minShare, setMinShare] = useState(10)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'available' | 'shared'>('available')
  const [target, setTarget] = useState<AvailableChild | null>(null)
  const [pledge, setPledge] = useState({ share_percent: 100, funded_by: 'sadqa', duration: 'one_year', is_anonymous: false })

  // Nominating a child the committee has not heard of yet.
  const [showNominate, setShowNominate] = useState(false)
  const [nomination, setNomination] = useState({ child_name: '', guardian_name: '', approximate_age: 0, gender: 'male', address_hint: '', reason: '' })

  const load = useCallback(async () => {
    const [{ data: kids }, { data: sum }, { data: setting }, { data: shares }] = await Promise.all([
      supabase.rpc('kafalat_available_children'),
      supabase.rpc('public_kafalat_summary'),
      supabase.from('site_settings').select('value').eq('key', 'kafalat_min_share_percent').maybeSingle(),
      supabase.from('kafalat_shares').select('id, child_id, share_percent, annual_amount_pkr, funded_by, duration, status, starts_on, ends_on'),
    ])
    setChildren((kids ?? []) as AvailableChild[])
    setSummary((sum ?? {}) as Record<string, number>)
    setMinShare(Number(setting?.value ?? 10))
    setMyShares((shares ?? []) as MyShare[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const openPledge = (c: AvailableChild) => {
    setPledge({
      share_percent: Math.max(Math.min(c.remaining_percent, 100), minShare),
      funded_by: 'sadqa', duration: 'one_year', is_anonymous: false,
    })
    setTarget(c)
  }

  const submitPledge = async () => {
    if (!target || !portalUser) return
    if (pledge.share_percent < minShare) { toast.error(`${t('pkf.err.minShare')} ${minShare}%`); return }
    if (pledge.share_percent > target.remaining_percent) { toast.error(t('pkf.err.tooMuch')); return }
    setBusy(true)
    const { error } = await supabase.from('kafalat_shares').insert({
      child_id: target.id,
      sponsor_name: portalUser.full_name,
      sponsor_phone: portalUser.mobile ?? null,
      portal_user_id: portalUser.id,
      is_anonymous: pledge.is_anonymous,
      share_percent: pledge.share_percent,
      funded_by: pledge.funded_by,
      duration: pledge.duration,
      status: 'pledged',
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pkf.ok.pledged'))
    setTarget(null)
    load()
  }

  const submitNomination = async () => {
    if (!nomination.child_name.trim() || !nomination.reason.trim()) { toast.error(t('pkf.err.nomination')); return }
    if (!portalUser) return
    setBusy(true)
    const { error } = await supabase.from('kafalat_nominations').insert({
      child_name: nomination.child_name.trim(),
      guardian_name: nomination.guardian_name || null,
      approximate_age: nomination.approximate_age || null,
      gender: nomination.gender,
      address_hint: nomination.address_hint || null,
      reason: nomination.reason.trim(),
      nominated_by_portal_user_id: portalUser.id,
      nominator_phone: portalUser.mobile ?? null,
      status: 'new',
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pkf.ok.nominated'))
    setShowNominate(false)
    setNomination({ child_name: '', guardian_name: '', approximate_age: 0, gender: 'male', address_hint: '', reason: '' })
  }

  const shared = children.filter((c) => c.committed_percent > 0 && c.remaining_percent > 0)
  const shown = tab === 'shared' ? shared : children.filter((c) => c.remaining_percent > 0)
  const mySharedChildIds = new Set(myShares.map((s) => s.child_id))

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <GraduationCap size={24} className="text-dp-secondary" /> {t('pkf.title')}
        </h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pkf.blurb')}</p>
      </div>

      {/* Said plainly, because most organisations do this and do not say it. */}
      <div className="bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-5">
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('pkf.poolNotice')}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {([
          ['active_children', 'kf.card.active'],
          ['fully_sponsored', 'kf.card.full'],
          ['partly_sponsored', 'kf.card.partial'],
          ['awaiting_sponsor', 'kf.card.waiting'],
        ] as const).map(([key, label]) => (
          <div key={key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t(label)}</p>
            <p className="font-heading text-[22px] font-bold text-dp-primary">{summary[key] ?? 0}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {([
          ['available', `${t('pkf.tab.available')}`],
          ['shared', `${t('pkf.tab.shared')} (${shared.length})`],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === key ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {label}
          </button>
        ))}
        <button onClick={() => setShowNominate(true)}
          className="ms-auto flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
          <Users size={15} /> {t('pkf.nominate')}
        </button>
      </div>

      {tab === 'shared' && (
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('pkf.sharedHelp')}</p>
      )}

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && shown.length === 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('pkf.allSponsored')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!loading && shown.map((c) => (
          <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <div className="flex items-start gap-3">
              {c.photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.photo_url} alt="" className="w-14 h-14 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-14 h-14 rounded-full bg-dp-secondary/10 text-dp-secondary flex items-center justify-center font-heading text-[20px] font-bold shrink-0">
                  {c.first_name.charAt(0)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-sans text-[15px] font-bold text-dp-on-surface">{c.first_name}</span>
                  {c.age && <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{c.age} {t('kf.years')}</span>}
                  {c.is_orphan && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('kf.orphan')}</span>}
                </div>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                  {c.current_class && `${t('kf.class')} ${c.current_class} · `}{t(`kf.loc.${c.school_location}`)}
                </p>
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface mt-1.5">
                  Rs {fmt(c.annual_package_pkr)}/{t('es.year')}
                </p>
              </div>
            </div>

            <div className="mt-3">
              <div className="h-2 w-full bg-dp-surface-container rounded-full overflow-hidden mb-1.5">
                <div className="h-full bg-dp-secondary" style={{ width: `${Math.min(c.committed_percent, 100)}%` }} />
              </div>
              <p className="font-sans text-[12px] text-dp-on-surface-variant">
                {c.committed_percent}% {t('kf.sponsored')} · <strong>{c.remaining_percent}% {t('kf.remaining')}</strong>
                {' '}(Rs {fmt(c.annual_package_pkr * c.remaining_percent / 100)})
              </p>
            </div>

            <button onClick={() => openPledge(c)}
              className="w-full mt-3 flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <Heart size={15} />
              {mySharedChildIds.has(c.id) ? t('pkf.addMore') : c.committed_percent > 0 ? t('pkf.joinShare') : t('pkf.sponsor')}
            </button>
          </div>
        ))}
      </div>

      {/* ── Pledge a share ──────────────────────────────────────────────── */}
      {target && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('pkf.sponsorTitle')}</h2>
              <button onClick={() => setTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <p className="font-sans text-[15px] font-bold">{target.first_name}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                Rs {fmt(target.annual_package_pkr)}/{t('es.year')} · {target.remaining_percent}% {t('kf.remaining')}
              </p>
            </div>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
              {t('pkf.f.share')} — {pledge.share_percent}%
            </label>
            <input type="range" min={minShare} max={target.remaining_percent} step={5}
              value={pledge.share_percent}
              onChange={(e) => setPledge({ ...pledge, share_percent: +e.target.value })}
              className="w-full accent-dp-secondary mb-1.5" />
            <p className="font-heading text-[22px] font-bold text-dp-primary mb-1">
              Rs {fmt(target.annual_package_pkr * pledge.share_percent / 100)}
              <span className="font-sans text-[13px] font-normal text-dp-on-surface-variant">/{t('es.year')}</span>
            </p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4">
              ≈ Rs {fmt(target.annual_package_pkr * pledge.share_percent / 100 / 12)}/{t('pkf.month')}
            </p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.f.duration')}</label>
            <select value={pledge.duration} onChange={(e) => setPledge({ ...pledge, duration: e.target.value })} className="input-field mb-3">
              <option value="one_year">{t('pkf.dur.one_year')}</option>
              <option value="two_years">{t('pkf.dur.two_years')}</option>
              <option value="till_matric">{t('pkf.dur.till_matric')}</option>
              <option value="open_ended">{t('pkf.dur.open_ended')}</option>
            </select>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.f.fundedBy')}</label>
            <select value={pledge.funded_by} onChange={(e) => setPledge({ ...pledge, funded_by: e.target.value })} className="input-field mb-1.5">
              <option value="sadqa">{t('wz.funded.sadqa')}</option>
              <option value="zakat">{t('wz.funded.zakat')}</option>
              <option value="general">{t('wz.funded.general')}</option>
            </select>
            {pledge.funded_by === 'zakat' && (
              <p className="font-sans text-[11.5px] text-amber-700 mb-3">{t('pkf.zakatNotice')}</p>
            )}

            <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px] mt-3 mb-4">
              <input type="checkbox" checked={pledge.is_anonymous}
                onChange={(e) => setPledge({ ...pledge, is_anonymous: e.target.checked })} className="accent-dp-secondary" />
              {t('f.anonymousDonor')}
            </label>

            <button disabled={busy} onClick={submitPledge}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Heart size={16} /> {busy ? t('action.saving') : t('pkf.confirmSponsorship')}
            </button>
          </div>
        </div>
      )}

      {/* ── Nominate a child ────────────────────────────────────────────── */}
      {showNominate && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowNominate(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('pkf.nominateTitle')}</h2>
              <button onClick={() => setShowNominate(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('pkf.nominateHelp')}</p>

            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.childName')}</label>
                <input value={nomination.child_name} onChange={(e) => setNomination({ ...nomination, child_name: e.target.value })} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardian')}</label>
                  <input value={nomination.guardian_name} onChange={(e) => setNomination({ ...nomination, guardian_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.age')}</label>
                  <input type="number" min={0} value={nomination.approximate_age || ''}
                    onChange={(e) => setNomination({ ...nomination, approximate_age: +e.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.where')}</label>
                <input value={nomination.address_hint} onChange={(e) => setNomination({ ...nomination, address_hint: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.reason')}</label>
                <textarea value={nomination.reason} onChange={(e) => setNomination({ ...nomination, reason: e.target.value })}
                  rows={3} className="input-field resize-none" />
              </div>

              <button disabled={busy} onClick={submitNomination}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Send size={16} /> {busy ? t('action.saving') : t('pkf.sendNomination')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
