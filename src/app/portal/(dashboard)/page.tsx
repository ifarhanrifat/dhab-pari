'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { HeartHandshake, Droplets, Repeat, ArrowRight, HandCoins, HandHeart, Wallet } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalBadgeCard } from '@/components/portal/PortalBadgeCard'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { DownloadAppBanner } from '@/components/portal/DownloadAppBanner'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { ImageSlot2 } from '@/components/design2/ImageSlot2'

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

// Same fixed cover + privacy rule every other project listing on the site
// already uses (Home2, ProjectsListClient) -- a medical project's real
// photo is never shown publicly here either.
const HEALTH_COVER_IMAGE = '/images/health-project-cover.jpg'
const isHealthCategory = (category: string | null) => category === 'health'

interface ProjectCard { id: string; title: string; display_name: string | null; category: string | null; progress_percent: number; coverUrl?: string | null }
interface AcademyCard { id: string; title: string; display_name: string | null; category: string | null; funding_model: string | null; monthly_operating_cost_pkr: number | null; coverUrl?: string | null }
interface BatchFee { project_id: string; fee_villager_monthly_pkr: number | null; fee_outsider_monthly_pkr: number | null }
interface FundingRow { project_id: string; raised: number; spent: number }

const CATEGORY_LABEL: Record<string, string> = {
  infrastructure: 'pj.catInfrastructure', water: 'pj.catWater', health: 'pj.catHealth', education: 'pj.catEducation',
  environment: 'pj.catEnvironment', welfare: 'pj.catWelfare', other: 'pj.catOther',
  sports: 'pj.catSports', training: 'pj.catTraining',
}

export default function PortalDashboardPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading } = usePortalUser()
  const [totalDonated, setTotalDonated] = useState(0)
  const [waterOutstanding, setWaterOutstanding] = useState(0)
  const [activeRecurring, setActiveRecurring] = useState(0)
  const [projects, setProjects] = useState<ProjectCard[]>([])
  const [academies, setAcademies] = useState<AcademyCard[]>([])
  const [batchFees, setBatchFees] = useState<BatchFee[]>([])
  const [funding, setFunding] = useState<Record<string, FundingRow>>({})

  useEffect(() => {
    if (!user) return
    const supabase = createClient()

    if (user.donor_account_id) {
      supabase.from('ledger_entries').select('debit, credit').eq('account_id', user.donor_account_id).then(({ data }) => {
        const total = (data ?? []).reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0)
        setTotalDonated(total)
      })
    }
    if (user.consumer_id) {
      supabase.from('bills').select('amount_pkr, paid_amount, discount_amount').eq('consumer_id', user.consumer_id).neq('status', 'paid').then(({ data }) => {
        const outstanding = (data ?? []).reduce((s, b) => s + (Number(b.amount_pkr) - Number(b.paid_amount ?? 0) - Number(b.discount_amount ?? 0)), 0)
        setWaterOutstanding(outstanding)
      })
    }
    supabase.from('recurring_schedules').select('id', { count: 'exact', head: true })
      .eq('created_by_portal_user_id', user.id).eq('is_active', true).then(({ count }) => setActiveRecurring(count ?? 0))

    // Funding position (raised + spent) for whatever cards end up on
    // screen — real ledger totals for the project's own account, not the
    // manual budget_pkr/spent_pkr fields (those are mostly unset).
    //
    // project_income_public/project_expenses_public (migration 378), not
    // donors_public — an academy's training fees post straight to the
    // project's account via a voucher, never through the donors table, so
    // donors_public alone was blind to every fee payment; both views also
    // exclude reversed vouchers (and the reversals themselves) so a
    // cancelled transaction nets to zero instead of still counting as
    // real money raised or spent.
    const loadFunding = (ids: string[]) => {
      if (ids.length === 0) return
      Promise.all([
        supabase.from('project_income_public').select('project_id, credit').in('project_id', ids),
        supabase.from('project_expenses_public').select('project_id, debit').in('project_id', ids),
      ]).then(([{ data: incomeRows }, { data: expenseRows }]) => {
        // Computed fresh into a local object, not accumulated on top of
        // whatever was already in state — React 18 Strict Mode (on by
        // default in dev) runs this effect twice, and usePortalUser's
        // own refresh() does too, so loadFunding can genuinely run more
        // than once for the exact same ids. Reusing/adding onto a prior
        // entry across calls silently doubled every Raised/Spent figure;
        // recomputing from scratch each time and merging the result is
        // idempotent no matter how many times this fires.
        const computed: Record<string, FundingRow> = {}
        for (const id of ids) computed[id] = { project_id: id, raised: 0, spent: 0 }
        for (const c of incomeRows ?? []) computed[c.project_id].raised += Number(c.credit)
        for (const e of expenseRows ?? []) computed[e.project_id].spent += Number(e.debit)
        setFunding((prev) => ({ ...prev, ...computed }))
      })
    }

    // Real gap found live on device, 2026-10-13: these cards had no photo
    // at all, unlike every other project card on the site (Home2's own
    // carousel, /projects) — same cover-image fetch those already use
    // (project_media's is_cover row, falling back to after/before, with
    // the fixed health placeholder taking priority for a medical project).
    const loadCovers = async (ids: string[]): Promise<Record<string, string>> => {
      if (ids.length === 0) return {}
      const { data } = await supabase.from('project_media').select('project_id, url').eq('is_cover', true).in('project_id', ids)
      const covers: Record<string, string> = {}
      for (const c of data ?? []) covers[c.project_id] = c.url
      return covers
    }

    supabase.from('projects').select('id, title, display_name, category, progress_percent, before_image_url, after_image_url')
      .not('category', 'in', '(sports,training)').or('status.eq.ongoing,funding_model.eq.recurring_support')
      .eq('unlisted', false).order('created_at', { ascending: false }).limit(4)
      .then(async ({ data }) => {
        const rows = data ?? []
        const covers = await loadCovers(rows.map((p) => p.id))
        setProjects(rows.map((p) => ({
          ...p,
          coverUrl: isHealthCategory(p.category) ? HEALTH_COVER_IMAGE : (covers[p.id] ?? p.after_image_url ?? p.before_image_url ?? null),
        })))
        loadFunding(rows.map((p) => p.id))
      })

    supabase.from('projects').select('id, title, display_name, category, funding_model, monthly_operating_cost_pkr, before_image_url, after_image_url')
      .in('category', ['sports', 'training']).in('status', ['ongoing', 'upcoming'])
      .order('created_at', { ascending: false }).limit(4)
      .then(async ({ data }) => {
        const rows = data ?? []
        const covers = await loadCovers(rows.map((a) => a.id))
        setAcademies(rows.map((a) => ({ ...a, coverUrl: covers[a.id] ?? a.after_image_url ?? a.before_image_url ?? null })))
        loadFunding(rows.map((a) => a.id))
        if (rows.length > 0) {
          supabase.from('training_batches').select('project_id, fee_villager_monthly_pkr, fee_outsider_monthly_pkr')
            .in('project_id', rows.map((a) => a.id)).eq('status', 'active')
            .then(({ data: fees }) => setBatchFees(fees ?? []))
        }
      })
  }, [user])

  if (loading) return <div className="text-center py-12 text-slate-500 font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-slate-500 font-sans">{t('p.couldNotLoad')}</div>

  const cards = [
    { href: '/portal/statement', icon: HeartHandshake, label: t('p.totalDonated'), value: `${fmt(totalDonated)}`, color: 'text-dp2-primary-dark' },
    ...(user.consumer_id ? [{ href: '/portal/water', icon: Droplets, label: t('p.waterBillsOutstanding'), value: `${fmt(waterOutstanding)}`, color: waterOutstanding > 0 ? 'text-red-600' : 'text-dp2-primary-dark' }] : []),
    { href: '/portal/recurring', icon: Repeat, label: t('p.activeRecurringDonations'), value: String(activeRecurring), color: 'text-dp2-primary' },
  ]

  const links = [
    { href: '/portal/my-credit', label: t('sk.myCreditBtn'), icon: Wallet },
    ...(user.consumer_id ? [{ href: '/portal/water', label: t('p.waterBillsPayments'), icon: Droplets }] : []),
  ]

  const cheapestFee = (projectId: string) => {
    const fees = batchFees.filter((b) => b.project_id === projectId).map((b) => b.fee_villager_monthly_pkr ?? 0).filter((f) => f > 0)
    return fees.length > 0 ? Math.min(...fees) : 0
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-8">
        <h1 className="font-heading text-[27px] font-bold text-dp2-primary flex items-center gap-2">{t('p.welcome')}, {user.full_name} <PortalHelp pageKey="dashboard" /></h1>
        <p className="font-sans text-[15px] text-slate-500 mt-1">
          {user.consumer_id ? <>{t('p.consumerNo')}<span className="ltr-num">{user.consumer_id}</span></> : t('p.noLinkedWaterConnection')} · {t('p.mobileLabel')} <span className="ltr-num">{user.mobile}</span>
        </p>
      </div>

      <DownloadAppBanner />

      {user.donor_account_id && <PortalBadgeCard portalUserId={user.id} totalDonated={totalDonated} />}

      {/* Real ask, live on device: "total donation and active recurring
          tabs on the same row" -- grid-cols-1 kept every stat card
          stacked one-per-row on mobile until sm: kicked in. Two-up from
          the smallest width fixes this for both languages (grid pairing
          is direction-agnostic; RTL just mirrors which card sits on
          which side of the row). */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-8">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="bg-white border border-dp2-card-border rounded-2xl p-4 sm:p-5 hover:border-dp2-primary-dark transition-all">
            <c.icon size={20} className={c.color} />
            <p className="font-sans text-[12px] sm:text-[13px] font-semibold text-slate-500 uppercase tracking-wide mt-2.5 sm:mt-3">{c.label}</p>
            <p className={`font-heading text-[20px] sm:text-[23px] font-bold mt-1 ${c.color}`}>{c.value}</p>
          </Link>
        ))}
      </div>

      {links.length > 0 && (
        <div className="bg-white border border-dp2-card-border rounded-2xl overflow-hidden mb-8">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="flex items-center gap-3 px-5 py-4 border-b border-dp2-card-border last:border-b-0 hover:bg-dp2-surface transition-all">
              <l.icon size={19} className="text-dp2-primary-dark" />
              <span className="font-sans text-[15px] font-semibold text-slate-800">{l.label}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Projects — compact preview, full list lives on the public site.
          Re-skinned 2026-10-13 onto the same photo-card language as
          Home2's own Projects carousel (real ask: "cards are too small,
          display with images"), then sized back down the same day (real
          ask: "too big now, keep 2 per row like before") -- real photo +
          gradient-overlay treatment kept, card height brought down from
          Home2's full h-[172px] to fit two per row on a phone screen
          the way this dashboard always has. */}
      {projects.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2.5">
            <p className="font-sans text-[13px] font-bold text-slate-500 uppercase tracking-[0.05em]">{t('p.projectsHeading')}</p>
            <Link href="/projects" className="flex items-center gap-1 text-dp2-primary-dark font-sans text-[13px] font-semibold hover:underline">
              {t('p.viewAll')} <ArrowRight size={12} className={isUrdu ? 'rotate-180' : ''} />
            </Link>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            {projects.map((p) => {
              const f = funding[p.id]
              return (
                <div key={p.id} className="flex flex-col gap-1.5">
                  <Link href={`/projects/${p.id}`} className="relative block h-[128px] rounded-xl overflow-hidden border border-dp2-gold/20 shadow-[0_4px_8px_rgba(0,0,0,.08)]"
                    style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
                    <ImageSlot2 src={p.coverUrl} placeholder={isUrdu ? 'تصویر لگائیں' : 'Add photo'} />
                    <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(3,58,34,.96) 0%, rgba(3,58,34,.75) 42%, transparent 65%)' }} />
                    <span className="absolute top-1.5 end-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-dp2-gold text-slate-900">{t(CATEGORY_LABEL[p.category ?? 'other'] ?? 'pj.catOther')}</span>
                    <div className="absolute inset-x-2 bottom-1.5 text-white flex flex-col gap-1">
                      <div className={`text-[11px] font-bold line-clamp-2 ${isUrdu ? 'leading-[18px]' : 'leading-[14px]'}`}>{p.display_name || p.title}</div>
                      <div className="h-[4px] rounded-full bg-white/20 overflow-hidden"><div className="h-full rounded-full bg-dp2-gold" style={{ width: `${Math.min(100, p.progress_percent ?? 0)}%` }} /></div>
                      {f && (
                        <div className="flex items-center justify-between gap-1 text-[8.5px] text-green-100">
                          <span>{t('pj.raisedShort')} <span className="ltr-num font-bold">{fmt(f.raised)}</span></span>
                          <span>{t('pj.spentShort')} <span className="ltr-num font-bold">{fmt(f.spent)}</span></span>
                        </div>
                      )}
                    </div>
                  </Link>
                  <Link href={`/portal/donate?project=${p.id}`}
                    className="flex items-center justify-center gap-1 bg-dp2-primary-dark text-white text-[11px] font-sans font-semibold py-1.5 rounded-lg hover:brightness-110 transition-colors">
                    <HandHeart size={11} /> {t('p.donateNow')}
                  </Link>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Academies — compact preview, full catalog + booking lives on the Academies tab */}
      {academies.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <p className="font-sans text-[13px] font-bold text-slate-500 uppercase tracking-[0.05em]">{t('p.academiesHeading')}</p>
            <Link href="/portal/training-programs" className="flex items-center gap-1 text-dp2-primary-dark font-sans text-[13px] font-semibold hover:underline">
              {t('p.viewAll')} <ArrowRight size={12} className={isUrdu ? 'rotate-180' : ''} />
            </Link>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            {academies.map((a) => {
              const fee = cheapestFee(a.id)
              const f = funding[a.id]
              const isSalaryFunded = a.funding_model === 'recurring_support'
              return (
                <div key={a.id} className="flex flex-col gap-1.5">
                  <Link href="/portal/training-programs" className="relative block h-[128px] rounded-xl overflow-hidden border border-dp2-gold/20 shadow-[0_4px_8px_rgba(0,0,0,.08)]"
                    style={{ background: 'linear-gradient(135deg,#78350f,#b45309)' }}>
                    <ImageSlot2 src={a.coverUrl} placeholder={isUrdu ? 'تصویر لگائیں' : 'Add photo'} />
                    <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(69,26,3,.96) 0%, rgba(69,26,3,.75) 42%, transparent 65%)' }} />
                    <span className="absolute top-1.5 end-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-dp2-gold text-slate-900 flex items-center gap-0.5"><HandCoins size={10} /> {t(CATEGORY_LABEL[a.category ?? 'sports'] ?? 'pj.catSports')}</span>
                    <div className="absolute inset-x-2 bottom-1.5 text-white flex flex-col gap-1">
                      <div className={`text-[11px] font-bold line-clamp-2 ${isUrdu ? 'leading-[18px]' : 'leading-[14px]'}`}>{a.display_name || a.title}</div>
                      <div className="text-[9.5px] text-amber-100">{fee > 0 ? <><span className="ltr-num font-bold">{fmt(fee)}</span>/{t('af.perMonth')}</> : t('tp.freeLabel')}</div>
                      {isSalaryFunded && f ? (
                        <div className="flex items-center justify-between gap-1 text-[8.5px] text-amber-100">
                          <span>{t('af.salaryFundingLabel')}</span>
                          <span className="ltr-num font-bold">{fmt(f.raised)}{a.monthly_operating_cost_pkr ? ` / ${fmt(a.monthly_operating_cost_pkr)} ${t('af.perMonthShort')}` : ''}</span>
                        </div>
                      ) : f && (
                        <div className="flex items-center justify-between gap-1 text-[8.5px] text-amber-100">
                          <span>{t('pj.raisedShort')} <span className="ltr-num font-bold">{fmt(f.raised)}</span></span>
                          <span>{t('pj.spentShort')} <span className="ltr-num font-bold">{fmt(f.spent)}</span></span>
                        </div>
                      )}
                    </div>
                  </Link>
                  <Link href={`/portal/donate?project=${a.id}`}
                    className="flex items-center justify-center gap-1 bg-dp2-primary-dark text-white text-[11px] font-sans font-semibold py-1.5 rounded-lg hover:brightness-110 transition-colors">
                    <HandHeart size={11} /> {t('p.donateNow')}
                  </Link>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
