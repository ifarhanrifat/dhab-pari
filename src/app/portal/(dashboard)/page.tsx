'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { HeartHandshake, Droplets, Repeat, ArrowRight, Layers, HandCoins, HandHeart } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalBadgeCard } from '@/components/portal/PortalBadgeCard'
import { PortalHelp } from '@/components/portal/PortalHelp'

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

interface ProjectCard { id: string; title: string; display_name: string | null; category: string | null; progress_percent: number }
interface AcademyCard { id: string; title: string; display_name: string | null; category: string | null; funding_model: string | null; monthly_operating_cost_pkr: number | null }
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

    supabase.from('projects').select('id, title, display_name, category, progress_percent')
      .not('category', 'in', '(sports,training)').or('status.eq.ongoing,funding_model.eq.recurring_support')
      .eq('unlisted', false).order('created_at', { ascending: false }).limit(4)
      .then(({ data }) => {
        setProjects(data ?? [])
        loadFunding((data ?? []).map((p) => p.id))
      })

    supabase.from('projects').select('id, title, display_name, category, funding_model, monthly_operating_cost_pkr')
      .in('category', ['sports', 'training']).in('status', ['ongoing', 'upcoming'])
      .order('created_at', { ascending: false }).limit(4)
      .then(({ data }) => {
        setAcademies(data ?? [])
        loadFunding((data ?? []).map((a) => a.id))
        if (data && data.length > 0) {
          supabase.from('training_batches').select('project_id, fee_villager_monthly_pkr, fee_outsider_monthly_pkr')
            .in('project_id', data.map((a) => a.id)).eq('status', 'active')
            .then(({ data: fees }) => setBatchFees(fees ?? []))
        }
      })
  }, [user])

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const cards = [
    { href: '/portal/statement', icon: HeartHandshake, label: t('p.totalDonated'), value: `${fmt(totalDonated)}`, color: 'text-dp-secondary' },
    ...(user.consumer_id ? [{ href: '/portal/water', icon: Droplets, label: t('p.waterBillsOutstanding'), value: `${fmt(waterOutstanding)}`, color: waterOutstanding > 0 ? 'text-dp-error' : 'text-dp-secondary' }] : []),
    { href: '/portal/recurring', icon: Repeat, label: t('p.activeRecurringDonations'), value: String(activeRecurring), color: 'text-dp-primary' },
  ]

  const links = [
    ...(user.consumer_id ? [{ href: '/portal/water', label: t('p.waterBillsPayments'), icon: Droplets }] : []),
  ]

  const cheapestFee = (projectId: string) => {
    const fees = batchFees.filter((b) => b.project_id === projectId).map((b) => b.fee_villager_monthly_pkr ?? 0).filter((f) => f > 0)
    return fees.length > 0 ? Math.min(...fees) : 0
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-8">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2">{t('p.welcome')}, {user.full_name} <PortalHelp pageKey="dashboard" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">
          {user.consumer_id ? <>{t('p.consumerNo')}<span className="ltr-num">{user.consumer_id}</span></> : t('p.noLinkedWaterConnection')} · {t('p.mobileLabel')} <span className="ltr-num">{user.mobile}</span>
        </p>
      </div>

      {user.donor_account_id && <PortalBadgeCard portalUserId={user.id} totalDonated={totalDonated} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="bg-white border border-dp-outline-variant rounded-lg p-5 hover:border-dp-secondary transition-all">
            <c.icon size={20} className={c.color} />
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant uppercase tracking-wide mt-3">{c.label}</p>
            <p className={`font-heading text-[22px] font-bold mt-1 ${c.color}`}>{c.value}</p>
          </Link>
        ))}
      </div>

      {links.length > 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-8">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="flex items-center gap-3 px-5 py-4 border-b border-dp-outline-variant last:border-b-0 hover:bg-dp-surface-container-low transition-all">
              <l.icon size={18} className="text-dp-secondary" />
              <span className="font-sans text-[14px] font-semibold text-dp-on-surface">{l.label}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Projects — compact preview, full list lives on the public site */}
      {projects.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2.5">
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('p.projectsHeading')}</p>
            <Link href="/projects" className="flex items-center gap-1 text-dp-secondary font-sans text-[12px] font-semibold hover:underline">
              {t('p.viewAll')} <ArrowRight size={12} className={isUrdu ? 'rotate-180' : ''} />
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            {projects.map((p) => {
              const f = funding[p.id]
              return (
                <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg p-3 hover:border-dp-secondary transition-colors flex flex-col">
                  <Link href={`/projects/${p.id}`}>
                    <p className="text-[9.5px] font-bold text-dp-secondary uppercase tracking-wide flex items-center gap-1"><Layers size={10} /> {t(CATEGORY_LABEL[p.category ?? 'other'] ?? 'pj.catOther')}</p>
                    {/* A fixed 16px line-height clips Nastaliq's taller
                        glyphs against line-clamp's overflow-hidden — the
                        reported "cut off from the bottom". Urdu needs a
                        visibly taller line-height for the same 2 lines to
                        render whole. */}
                    <p className={`font-sans text-[12.5px] font-semibold text-dp-on-surface mt-1 line-clamp-2 ${isUrdu ? 'leading-[22px]' : 'leading-[16px]'}`}>{p.display_name || p.title}</p>
                    <div className="h-1.5 bg-dp-surface-container rounded-full mt-2 overflow-hidden">
                      <div className="h-full bg-dp-secondary rounded-full" style={{ width: `${Math.min(100, p.progress_percent ?? 0)}%` }} />
                    </div>
                    {f && (
                      <div className="flex items-center justify-between gap-1 mt-1.5 font-sans text-[9px] text-dp-on-surface-variant">
                        <span>{t('pj.raisedShort')} <span className="ltr-num">{fmt(f.raised)}</span></span>
                        <span>{t('pj.spentShort')} <span className="ltr-num">{fmt(f.spent)}</span></span>
                      </div>
                    )}
                  </Link>
                  <Link href={`/portal/donate?project=${p.id}`}
                    className="mt-2 flex items-center justify-center gap-1 bg-dp-secondary text-white text-[10.5px] font-sans font-semibold py-1.5 rounded-md hover:bg-dp-primary transition-colors">
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
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('p.academiesHeading')}</p>
            <Link href="/portal/training-programs" className="flex items-center gap-1 text-dp-secondary font-sans text-[12px] font-semibold hover:underline">
              {t('p.viewAll')} <ArrowRight size={12} className={isUrdu ? 'rotate-180' : ''} />
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            {academies.map((a) => {
              const fee = cheapestFee(a.id)
              const f = funding[a.id]
              const isSalaryFunded = a.funding_model === 'recurring_support'
              return (
                <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-3 hover:border-dp-secondary transition-colors flex flex-col">
                  <Link href="/portal/training-programs">
                    <p className="text-[9.5px] font-bold text-amber-600 uppercase tracking-wide flex items-center gap-1"><HandCoins size={10} /> {t(CATEGORY_LABEL[a.category ?? 'sports'] ?? 'pj.catSports')}</p>
                    <p className={`font-sans text-[12.5px] font-semibold text-dp-on-surface mt-1 line-clamp-2 ${isUrdu ? 'leading-[22px]' : 'leading-[16px]'}`}>{a.display_name || a.title}</p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">{fee > 0 ? <><span className="ltr-num">{fmt(fee)}</span>/{t('af.perMonth')}</> : t('tp.freeLabel')}</p>
                    {/* A trainer-salary academy (funding_model=recurring_support)
                        shows what it's raised against the actual monthly need,
                        not a generic Raised/Spent pair — same distinction the
                        Academies catalog and admin summary already make. */}
                    {isSalaryFunded && f ? (
                      <div className="flex items-center justify-between gap-1 mt-1.5 font-sans text-[9px] text-dp-on-surface-variant">
                        <span>{t('af.salaryFundingLabel')}</span>
                        <span className="ltr-num">{fmt(f.raised)}{a.monthly_operating_cost_pkr ? ` / ${fmt(a.monthly_operating_cost_pkr)} ${t('af.perMonthShort')}` : ''}</span>
                      </div>
                    ) : f && (
                      <div className="flex items-center justify-between gap-1 mt-1.5 font-sans text-[9px] text-dp-on-surface-variant">
                        <span>{t('pj.raisedShort')} <span className="ltr-num">{fmt(f.raised)}</span></span>
                        <span>{t('pj.spentShort')} <span className="ltr-num">{fmt(f.spent)}</span></span>
                      </div>
                    )}
                  </Link>
                  <Link href={`/portal/donate?project=${a.id}`}
                    className="mt-2 flex items-center justify-center gap-1 bg-dp-secondary text-white text-[10.5px] font-sans font-semibold py-1.5 rounded-md hover:bg-dp-primary transition-colors">
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
