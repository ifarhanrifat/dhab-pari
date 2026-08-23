'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  GraduationCap, Heart, Users, X, Send, HelpCircle, ChevronDown,
  HandCoins, TrendingUp, Calendar, ShieldCheck, AlertTriangle, CheckCircle2,
  Clock, ArrowRight, Sparkles, Share2, ListChecks, Copy, MessageCircle,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { renderTemplate } from '@/lib/messageTemplates'
import { SITE } from '@/lib/constants'
import { usePoolGuideContent } from '@/hooks/usePoolGuideContent'
import Link from 'next/link'

/**
 * Sponsoring a child — one card per child, one status, one action.
 *
 * There is no anonymous "join the shared pool" option here any more. Every
 * donor who gives through this page is giving to a named child, so every
 * card can show exactly where that one relationship stands: not yet
 * sponsored, joined and waiting on a payment, sent and waiting on the
 * accountant, or confirmed and running monthly. Actually sending the money
 * and managing what recurs happens on the same two pages every other fund
 * already uses (My Giving, Recurring Donations) — this page only decides
 * who the money is for.
 *
 * A child is never shown by family name, house or school-plus-photo, and a
 * child whose guardian has not consented to a photograph appears with their
 * initial instead — deliberately indistinguishable from a child who has no
 * photograph on file, so nothing is inferred from its absence.
 */

interface NamingChild {
  id: string; code: string; first_name: string; first_name_ur: string | null
  current_class: string | null; is_orphan: boolean
  this_year_requirement: number; already_named: number
  photo_url: string | null
}

interface Position {
  pool_id: string; required: number; committed: number; donors: number
  coverage_percent: number; suggested_share: number; min_share: number
}

interface Commitment {
  id: string; pool_id: string; monthly_amount: number; status: string; started_on: string
  named_child: string | null; kafalat_child_id: string | null
  paid_this_month: number; announced_this_month: number
  months_given: number; total_given: number
}

interface Announcement {
  id: string; amount: number; is_one_time: boolean; month: string
  status: string; named_child: string | null; kafalat_child_id: string | null; has_proof: boolean
}

interface Dashboard {
  children_active: number; monthly_target: number; outstanding: number
  confirmed: number; required: number; on_track: boolean
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function PortalKafalatPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const { user: portalUser } = usePortalUser()

  // The "How this works" guide below, admin-editable (Settings → Donors &
  // Projects → Portal Guides — migration 308). Each falls back to the
  // original messages.ts text if a field hasn't been customised yet.
  const guideContent = usePoolGuideContent()
  const guideTitle = (guideContent[`pool_how_title_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t('pool.howTitle')
  const guideQ = (k: string) => (guideContent[`pool_how_${k}_q_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t(`pool.how.${k}.q`)
  const guideUrduLine = (k: string) => (guideContent[`pool_how_${k}_urdu_line`] || '').trim() || t(`pool.how.${k}.aUr`)
  const guideAnswer = (k: string) => (guideContent[`pool_how_${k}_answer_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t(`pool.how.${k}.a`)
  const guidePromiseUrduLine = (guideContent.pool_promise_urdu_line || '').trim() || t('pool.promiseUr')
  const guidePromise = (guideContent[`pool_promise_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t('pool.promise')

  const [poolId, setPoolId] = useState<string | null>(null)
  const [position, setPosition] = useState<Position | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [children, setChildren] = useState<NamingChild[]>([])
  const [commitments, setCommitments] = useState<Commitment[]>([])
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [templates, setTemplates] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [showGuide, setShowGuide] = useState(false)
  const [busy, setBusy] = useState(false)

  const [giving, setGiving] = useState<NamingChild | null>(null)
  const [form, setForm] = useState({ amount: 0, recurring: true, funded_by: 'sadqa', show_name_publicly: false })

  const [showNominate, setShowNominate] = useState(false)
  const [nomination, setNomination] = useState({ child_name: '', guardian_name: '', approximate_age: 0, gender: 'male', address_hint: '', reason: '' })

  const [managing, setManaging] = useState<{ commitment: Commitment; child: NamingChild } | null>(null)
  const [changing, setChanging] = useState<Commitment | null>(null)
  const [changeAmount, setChangeAmount] = useState(0)
  const [endTarget, setEndTarget] = useState<{ commitment: Commitment; child: NamingChild } | null>(null)
  const [thankYou, setThankYou] = useState<string | null>(null)

  const [breakdownChild, setBreakdownChild] = useState<NamingChild | null>(null)
  const [breakdown, setBreakdown] = useState<{ lines: { category: string; amount: number }[]; total: number } | null>(null)
  const [sharing, setSharing] = useState<NamingChild | null>(null)

  const load = useCallback(async () => {
    const { data: pool } = await supabase.from('support_pools').select('id').eq('code', 'POOL-KFL').single()
    const pid = (pool as { id: string } | null)?.id ?? null
    setPoolId(pid)

    const [{ data: kids }, { data: pos }, { data: myC }, { data: myA }, { data: dash }, { data: tpl }] = await Promise.all([
      supabase.rpc('kafalat_children_for_naming'),
      pid ? supabase.rpc('pool_position', { p_pool_id: pid }) : Promise.resolve({ data: null }),
      supabase.rpc('my_pool_commitments'),
      supabase.rpc('my_pool_announcements'),
      supabase.rpc('kafalat_public_dashboard'),
      supabase.from('message_templates').select('key, body')
        .in('key', ['kafalat_card_tagline', 'kafalat_end_sponsorship', 'kafalat_thank_you']),
    ])
    setChildren((kids ?? []) as NamingChild[])
    setPosition((pos ?? null) as Position | null)
    setCommitments(((myC ?? []) as Commitment[]).filter((c) => c.pool_id === pid))
    setAnnouncements(((myA ?? []) as (Announcement & { pool_id: string })[]).filter((a) => a.pool_id === pid))
    setDashboard((dash ?? null) as Dashboard | null)
    setTemplates(Object.fromEntries(((tpl ?? []) as { key: string; body: string }[]).map((r) => [r.key, r.body])))
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  // Everything this donor's own card for one child needs to know, derived
  // fresh each render from the same two lists every other part of this page
  // already loads — there is nothing per-child cached separately to drift
  // out of sync with it.
  // pool_leave() sets status to 'ended', not 'cancelled' — a commitment a
  // donor has deliberately ended must NOT keep showing as "Joined" here, so
  // only 'active' and 'lapsed' (missed a month, not yet ended) count as a
  // live relationship to a child. Anything else means the card starts over.
  const commitmentFor = (child: NamingChild) =>
    commitments.find((c) => c.kafalat_child_id === child.id && (c.status === 'active' || c.status === 'lapsed'))
  const announcementFor = (child: NamingChild) =>
    announcements.find((a) => a.kafalat_child_id === child.id && a.status === 'announced')

  type CardState = 'sponsor' | 'full' | 'lapsed' | 'confirm_payment' | 'awaiting' | 'joined'
  const stateFor = (child: NamingChild): CardState => {
    const c = commitmentFor(child)
    if (!c) return child.already_named >= child.this_year_requirement ? 'full' : 'sponsor'
    if (c.status === 'lapsed') return 'lapsed'
    const a = announcementFor(child)
    if (a) return a.has_proof ? 'awaiting' : 'confirm_payment'
    return 'joined'
  }

  const openGive = (child: NamingChild) => {
    const existing = commitmentFor(child)
    const remaining = Math.max(child.this_year_requirement - child.already_named, position?.min_share ?? 1000)
    // A lapsed commitment needs p_recurring=true to actually reactivate that
    // same row (pool_announce only reuses a commitment when told this is
    // recurring) — "Resume sponsoring" would otherwise silently create a
    // stray one-time announcement and leave the commitment lapsed forever.
    setForm({
      amount: existing?.monthly_amount ?? remaining,
      recurring: existing?.status === 'lapsed' ? true : !existing,
      funded_by: 'sadqa', show_name_publicly: false,
    })
    setGiving(child)
  }

  const submitGive = async () => {
    if (!giving || !poolId || !portalUser) return
    if (position && form.amount < position.min_share) {
      toast.error(t('pool.minimumIs').replace('{amt}', fmt(position.min_share))); return
    }
    setBusy(true)
    const { error } = await supabase.rpc('pool_announce', {
      p_pool_id: poolId, p_amount: form.amount, p_recurring: form.recurring,
      p_funded_by: form.funded_by, p_show_name_publicly: form.show_name_publicly,
      p_kafalat_child_id: giving.id,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.announced'))
    setGiving(null)
    load()
  }

  const submitChange = async () => {
    if (!changing) return
    setBusy(true)
    const { error } = await supabase.rpc('pool_change_my_share', {
      p_commitment_id: changing.id, p_monthly_amount: changeAmount,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.shareChanged'))
    setChanging(null)
    setManaging(null)
    load()
  }

  const confirmEnd = async () => {
    if (!endTarget) return
    setBusy(true)
    const { error } = await supabase.rpc('pool_leave', { p_commitment_id: endTarget.commitment.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const msg = templates.kafalat_thank_you
      ? renderTemplate(templates.kafalat_thank_you, { name: endTarget.child.first_name })
      : `Thank you for everything, from ${endTarget.child.first_name}.`
    setEndTarget(null)
    setManaging(null)
    setThankYou(msg)
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

  const openBreakdown = async (child: NamingChild) => {
    setBreakdownChild(child)
    setBreakdown(null)
    const { data, error } = await supabase.rpc('kafalat_child_package_breakdown', { p_child_id: child.id })
    if (error) { toast.error(friendlyError(error)); setBreakdownChild(null); return }
    setBreakdown(data as { lines: { category: string; amount: number }[]; total: number })
  }

  const publicShareUrl = (child: NamingChild) => `https://${SITE.domain}/kafalat/${child.code}`

  const shareChild = async (child: NamingChild) => {
    const url = publicShareUrl(child)
    const text = t('pkf.share.text').replace('{name}', child.first_name)
    // navigator.share hands off to the phone's own share sheet — WhatsApp,
    // Facebook, everything already installed — which is what most people on
    // this portal actually reach for first. The modal below is only the
    // fallback for a desktop browser that doesn't have one.
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: text, url }); return } catch { /* cancelled — fall through to nothing */ return }
    }
    setSharing(child)
  }

  const copyShareLink = async (child: NamingChild) => {
    await navigator.clipboard.writeText(publicShareUrl(child))
    toast.success(t('pkf.share.copied'))
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-4xl">
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <GraduationCap size={24} className="text-dp-secondary" /> {t('pkf.title')}
        </h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pkf.blurb')}</p>
      </div>

      {/* ── The whole programme, at a glance ─────────────────────────────
          What used to be scattered across a shared-pool position card and a
          separate measuring account: how many children, what they need,
          what's confirmed, and whether the committee is on the mark. */}
      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3.5">
            <p className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-1">{t('pkf.stats.kids')}</p>
            <p className="font-heading text-[24px] font-bold text-dp-primary">{dashboard.children_active}</p>
          </div>
          <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3.5">
            <p className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-1">{t('pkf.stats.required')}</p>
            <p className="font-heading text-[24px] font-bold text-dp-primary">Rs {fmt(dashboard.required)}</p>
          </div>
          <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3.5">
            <p className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-1">{t('pkf.stats.confirmed')}</p>
            <p className="font-heading text-[24px] font-bold text-dp-secondary">Rs {fmt(dashboard.confirmed)}</p>
            {dashboard.outstanding > 0 && (
              <p className="font-sans text-[11px] text-dp-on-surface-variant mt-0.5">{t('pkf.stats.outstanding').replace('{amt}', fmt(dashboard.outstanding))}</p>
            )}
          </div>
          <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3.5">
            <p className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-1">{t('pkf.stats.monthly')}</p>
            <p className="font-heading text-[24px] font-bold text-dp-primary">Rs {fmt(dashboard.monthly_target)}</p>
          </div>
        </div>
      )}

      <div className="bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-3">
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('pkf.poolNotice')}</p>
      </div>

      {/* ── How this works, before anybody commits ───────────────────────
          What "monthly" actually means here, and the one thing every donor
          deserves to know before they agree to it: nothing is ever taken
          from their account on its own. */}
      <button onClick={() => setShowGuide((v) => !v)}
        className="w-full flex items-center justify-between gap-2 bg-white border border-dp-outline-variant rounded-lg px-4 py-3 mb-5 hover:border-dp-secondary transition-all cursor-pointer">
        <span className="flex items-center gap-2 font-sans text-[13px] font-bold text-dp-primary">
          <HelpCircle size={16} /> {guideTitle}
        </span>
        <ChevronDown size={16} className={`text-dp-on-surface-variant transition-transform ${showGuide ? 'rotate-180' : ''}`} />
      </button>

      {showGuide && (
        <section className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-5">
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
            {[
              { icon: HandCoins, k: 'what' },
              { icon: TrendingUp, k: 'amount' },
              { icon: Calendar, k: 'when' },
              { icon: X, k: 'stop' },
              { icon: AlertTriangle, k: 'short' },
              { icon: ShieldCheck, k: 'privacy' },
            ].map(({ icon: Icon, k }) => (
              <div key={k} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-dp-surface-container-low flex items-center justify-center shrink-0 mt-0.5">
                  <Icon size={16} className="text-dp-secondary" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-heading text-[14px] font-bold text-dp-primary mb-1">{guideQ(k)}</h3>
                  <p className="font-sans text-[15px] leading-[2] text-dp-on-surface mb-1"
                    style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                    {guideUrduLine(k)}
                  </p>
                  <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">{guideAnswer(k)}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-dp-outline-variant bg-dp-surface-container-low px-5 py-4 flex items-start gap-2.5">
            <ShieldCheck size={17} className="text-dp-secondary shrink-0 mt-0.5" />
            <div>
              <p className="font-sans text-[15px] leading-[2] text-dp-on-surface font-bold"
                style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                {guidePromiseUrduLine}
              </p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">{guidePromise}</p>
            </div>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="font-heading text-[16px] font-bold text-dp-primary">{t('pkf.tab.available')}</h2>
        <button onClick={() => setShowNominate(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
          <Users size={15} /> {t('pkf.nominate')}
        </button>
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && children.length === 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('pkf.noneRegisteredYet')}</p>
        </div>
      )}

      {/* ── Every registered child, one card, one status each ───────────
          No separate "my giving" list and no anonymous shared-pool card —
          a donor's own relationship to a child lives entirely on that
          child's own card. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!loading && children.map((c) => {
          const remaining = Math.max(c.this_year_requirement - c.already_named, 0)
          const pct = c.this_year_requirement > 0 ? Math.min(100, Math.round((c.already_named / c.this_year_requirement) * 100)) : 0
          const state = stateFor(c)
          const commitment = commitmentFor(c)
          const announcement = announcementFor(c)
          const tagline = templates.kafalat_card_tagline ? renderTemplate(templates.kafalat_card_tagline, { name: c.first_name }) : null

          return (
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
                    {c.is_orphan && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('kf.orphan')}</span>}
                  </div>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                    {c.current_class && `${t('kf.class')} ${c.current_class}`}
                  </p>
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface mt-1.5">
                    Rs {fmt(c.this_year_requirement)}/{t('es.year')}
                  </p>
                </div>
              </div>

              {tagline && (
                <p className="font-sans text-[12px] text-dp-on-surface-variant italic mt-2.5 flex items-start gap-1.5">
                  <Sparkles size={12} className="text-dp-secondary shrink-0 mt-0.5" /> {tagline}
                </p>
              )}

              <div className="mt-3">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="h-2 flex-1 bg-dp-surface-container rounded-full overflow-hidden">
                    <div className="h-full bg-dp-secondary" style={{ width: `${Math.max(pct, 1)}%` }} />
                  </div>
                  {state === 'full' ? (
                    <span className="shrink-0 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10.5px] font-bold">{t('pkf.card.full')}</span>
                  ) : (
                    <span className="shrink-0 px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('pkf.card.inProgress')}</span>
                  )}
                </div>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">
                  {pct}% {t('kf.sponsored')} · <strong>Rs {fmt(remaining)} {t('kf.remaining')}</strong>
                </p>
              </div>

              {/* ── Two quiet secondary actions every card gets: see what the
                  money actually pays for, and pass this child on to someone
                  else who might join in. ─────────────────────────────────── */}
              <div className="flex items-center gap-4 mt-2">
                <button onClick={() => openBreakdown(c)}
                  className="flex items-center gap-1.5 font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer">
                  <ListChecks size={13} /> {t('pkf.viewBreakdown')}
                </button>
                <button onClick={() => shareChild(c)}
                  className="flex items-center gap-1.5 font-sans text-[12px] font-bold text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                  <Share2 size={13} /> {t('pkf.share.button')}
                </button>
              </div>

              {/* ── The one action this card needs, based on exactly where
                  this donor's own relationship to this child stands ────── */}
              <div className="mt-3">
                {state === 'sponsor' && (
                  <button onClick={() => openGive(c)}
                    className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    <Heart size={15} /> {t('pkf.sponsor')}
                  </button>
                )}
                {state === 'full' && (
                  <p className="w-full text-center py-2.5 rounded-lg bg-dp-surface-container-low font-sans text-[13px] font-semibold text-dp-on-surface-variant">
                    {t('pkf.card.fullySponsored')}
                  </p>
                )}
                {state === 'lapsed' && (
                  <button onClick={() => openGive(c)}
                    className="w-full flex items-center justify-center gap-2 border-2 border-amber-400 text-amber-800 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-amber-50 transition-all cursor-pointer">
                    <Heart size={15} /> {t('pkf.card.resume')}
                  </button>
                )}
                {state === 'confirm_payment' && announcement && (
                  <Link href={`/portal/statement?pay=${announcement.id}`}
                    className="w-full flex items-center justify-center gap-2 bg-amber-500 text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-amber-600 transition-all">
                    <ArrowRight size={15} /> {t('pkf.card.confirmPayment')}
                  </Link>
                )}
                {state === 'awaiting' && (
                  <p className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-dp-surface-container-low font-sans text-[13px] font-semibold text-dp-on-surface-variant">
                    <Clock size={14} /> {t('pkf.card.awaiting')}
                  </p>
                )}
                {state === 'joined' && commitment && (
                  <button onClick={() => setManaging({ commitment, child: c })}
                    className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-emerald-700 transition-all cursor-pointer">
                    <CheckCircle2 size={15} /> {t('pkf.card.joined').replace('{amt}', fmt(commitment.monthly_amount))}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Give — always for the one child whose card was tapped ───────── */}
      {giving && position && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setGiving(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('pkf.sponsorTitle')}</h2>
              <button onClick={() => setGiving(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <p className="font-sans text-[15px] font-bold">{giving.first_name}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                Rs {fmt(Math.max(giving.this_year_requirement - giving.already_named, 0))} {t('kf.remaining')} {t('es.year').toLowerCase()}
              </p>
            </div>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
              {t('pool.monthlyAmount')}
            </label>
            <input type="number" min={position.min_share} value={form.amount || ''}
              onChange={(e) => setForm({ ...form, amount: +e.target.value })}
              className="input-field mb-1" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">
              {t('pool.minimumIs').replace('{amt}', fmt(position.min_share))}
            </p>

            <div className="flex gap-2 mb-1">
              {([['recurring', true, 'pool.recurringMonthly'], ['one_time', false, 'pool.oneTime']] as const).map(([key, val, label]) => (
                <button key={key} disabled={commitmentFor(giving)?.status === 'active' && val} onClick={() => setForm({ ...form, recurring: val })}
                  className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold transition-all ${form.recurring === val ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'} ${commitmentFor(giving)?.status === 'active' && val ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                  {t(label)}
                </button>
              ))}
            </div>
            {commitmentFor(giving)?.status === 'active' ? (
              <p className="font-sans text-[11px] text-dp-on-surface-variant mb-3">{t('pkf.alreadyMonthlyHint')}</p>
            ) : (
              <div className="mb-4" />
            )}

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pool.fundedBy')}</label>
            <select value={form.funded_by} onChange={(e) => setForm({ ...form, funded_by: e.target.value })} className="input-field mb-1.5">
              <option value="sadqa">{t('pool.fundedBy.sadqa')}</option>
              <option value="general">{t('pool.fundedBy.general')}</option>
            </select>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mb-3.5">{t('pool.noZakat')}</p>

            <label className="flex items-start gap-2 cursor-pointer font-sans text-[12.5px] mb-5">
              <input type="checkbox" checked={form.show_name_publicly}
                onChange={(e) => setForm({ ...form, show_name_publicly: e.target.checked })} className="accent-dp-secondary mt-0.5" />
              <span>{t('pool.showNamePublicly')} <span className="block text-dp-on-surface-variant">{t('pool.showNamePubliclyHint')}</span></span>
            </label>

            <button disabled={busy || form.amount < position.min_share} onClick={submitGive}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Heart size={16} /> {busy ? t('action.saving') : t('pool.confirmAnnounce')}
            </button>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-3 text-center">{t('pool.announceTerms')}</p>
          </div>
        </div>
      )}

      {/* ── Manage a joined sponsorship — increase, or end it ────────────── */}
      {managing && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setManaging(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pkf.manage.title')}</h2>
              <button onClick={() => setManaging(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">
              {t('pkf.manage.subtitle').replace('{amt}', fmt(managing.commitment.monthly_amount)).replace('{name}', managing.child.first_name)}
            </p>
            <div className="space-y-2.5">
              <button onClick={() => { setChangeAmount(managing.commitment.monthly_amount); setChanging(managing.commitment) }}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <TrendingUp size={15} /> {t('pkf.manage.increase')}
              </button>
              <button onClick={() => setEndTarget({ commitment: managing.commitment, child: managing.child })}
                className="w-full flex items-center justify-center gap-2 border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:border-dp-error hover:text-dp-error transition-all cursor-pointer">
                <X size={15} /> {t('pkf.manage.end')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change my standing amount ────────────────────────────────── */}
      {changing && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setChanging(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pool.changeTitle')}</h2>
              <button onClick={() => setChanging(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <input type="number" min={1} value={changeAmount || ''}
              onChange={(e) => setChangeAmount(+e.target.value)} className="input-field mb-2" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('pkf.manage.increaseHint')}</p>
            <button disabled={busy} onClick={submitChange}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── End a sponsorship — a real goodbye, not a confirm() popup ──────
          The message itself is admin-editable (message_templates), never
          hardcoded here — only the two-step shape (ask once, warmly; act
          only if they still mean it) is fixed. */}
      {endTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEndTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">{t('pkf.manage.end')}</h2>
            <p className="font-sans text-[14px] text-dp-on-surface leading-relaxed mb-6">
              {templates.kafalat_end_sponsorship
                ? renderTemplate(templates.kafalat_end_sponsorship, { name: endTarget.child.first_name })
                : `Are you sure you want to stop sponsoring ${endTarget.child.first_name}?`}
            </p>
            <div className="flex flex-col gap-2.5">
              <button onClick={() => setEndTarget(null)}
                className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                {t('pkf.end.cancel')}
              </button>
              <button disabled={busy} onClick={confirmEnd}
                className="w-full text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:text-dp-error transition-all cursor-pointer disabled:opacity-50">
                {busy ? t('action.saving') : t('pkf.end.stillEnd')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Thank you, from the child ─────────────────────────────────── */}
      {thankYou && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setThankYou(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm text-center" onClick={(e) => e.stopPropagation()}>
            <Heart size={28} className="mx-auto text-dp-secondary mb-3" />
            <p className="font-sans text-[15px] text-dp-on-surface leading-relaxed mb-6">{thankYou}</p>
            <button onClick={() => setThankYou(null)}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              {t('pkf.thankYou.close')}
            </button>
          </div>
        </div>
      )}

      {/* ── What you're actually paying for — the annual figure, itemised ── */}
      {breakdownChild && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setBreakdownChild(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pkf.breakdown.title')}</h2>
              <button onClick={() => setBreakdownChild(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{breakdownChild.first_name}</p>
            {!breakdown ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant text-center py-6">{t('action.loading')}</p>
            ) : breakdown.lines.length === 0 ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant text-center py-6">{t('pkf.breakdown.none')}</p>
            ) : (
              <>
                <div className="divide-y divide-dp-outline-variant border border-dp-outline-variant rounded-lg overflow-hidden mb-3">
                  {breakdown.lines.map((l, i) => (
                    <div key={i} className="flex items-center justify-between px-3.5 py-2.5">
                      <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{t(`kf.cat.${l.category}`)}</p>
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface shrink-0 ms-3">Rs {fmt(l.amount)}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between px-1">
                  <p className="font-sans text-[13.5px] font-bold text-dp-primary">{t('pkf.breakdown.total')}</p>
                  <p className="font-heading text-[18px] font-bold text-dp-primary">Rs {fmt(breakdown.total)}</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Share this child's card — a fallback for browsers with no share
          sheet of their own; on a phone shareChild() skips this modal
          entirely and hands off to WhatsApp/Facebook/etc. directly. ────── */}
      {sharing && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setSharing(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pkf.share.title')}</h2>
              <button onClick={() => setSharing(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <div className="space-y-2.5">
              <a href={`https://wa.me/?text=${encodeURIComponent(`${t('pkf.share.text').replace('{name}', sharing.first_name)} ${publicShareUrl(sharing)}`)}`}
                target="_blank" rel="noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-[#25D366] text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:opacity-90 transition-all">
                <MessageCircle size={16} /> WhatsApp
              </a>
              <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(publicShareUrl(sharing))}`}
                target="_blank" rel="noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-[#1877F2] text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:opacity-90 transition-all">
                <span className="font-heading text-[15px] font-black leading-none">f</span> Facebook
              </a>
              <button onClick={() => copyShareLink(sharing)}
                className="w-full flex items-center justify-center gap-2 border border-dp-outline-variant text-dp-on-surface py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:border-dp-secondary transition-all cursor-pointer">
                <Copy size={15} /> {t('pkf.share.copyLink')}
              </button>
            </div>
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
