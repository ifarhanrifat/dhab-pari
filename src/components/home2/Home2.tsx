'use client'
import { useState } from 'react'
import Link from 'next/link'
import {
  Droplet, Siren, HandCoins, PhoneCall, ShoppingBag, AlertTriangle, Megaphone, Scale, Baby, Newspaper,
  Video, Play, Briefcase, Trophy, Eye, HandHeart, Wallet, GitBranch, Heart, Users, Lock, School, GraduationCap,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { Header2 } from '@/components/design2/Header2'
import { Footer2 } from '@/components/design2/Footer2'
import { BottomNav2 } from '@/components/design2/BottomNav2'
import { DrawerNav2 } from '@/components/design2/DrawerNav2'
import { Card2 } from '@/components/design2/Card2'
import { Carousel2 } from '@/components/design2/Carousel2'
import { BottomSheet2 } from '@/components/design2/BottomSheet2'
import { ImageSlot2 } from '@/components/design2/ImageSlot2'
import { WeatherDateRow } from '@/components/home/WeatherDateRow'
import { VillageServicesQuickLinks } from '@/components/home/VillageServicesQuickLinks'
import { CommitteeNoteCard } from '@/components/home/CommitteeNoteCard'
import { HomeDonateCard } from '@/components/public/HomeDonateCard'
import { DownloadAppBanner } from '@/components/portal/DownloadAppBanner'

function fmtPKR(n: number) {
  return Math.round(n).toLocaleString()
}

interface Project {
  id: string; title: string; title_ur: string | null; display_name: string | null; status: string
  progress_percent: number; budget_pkr: number; category: string | null
  coverUrl: string | null; spent: number
}
interface Home2Props {
  projects: Project[]
  news: { id: string; title: string; category: string | null; content: string | null; is_featured: boolean }[]
  videos: { id: string; title: string; thumbnail_url: string | null; duration_seconds: number | null }[]
  donors: { id: string; name: string; amount_pkr: number; date: string; is_anonymous: boolean }[]
  stats: { available_funds: number; active_projects: number; donations_this_month: number; registered_households: number; revenue_this_month: number; expenses_this_month: number }
  jobs: { id: string; category: string | null; headline: string }[]
  volunteers: { id: string; full_name: string; projectTitle: string }[]
  achievements: { id: string; is_private: boolean; text_ur: string | null; done_by_name: string | null }[]
  bloodGroups: { blood_group: string; registered: number; available_now: number }[]
  bloodTotal: number
  needs: Record<string, number>
  kafalat: Record<string, number>
  wazifa: Record<string, number>
  sadqaWorking: number
  sadqaTotal: number
  careerCounts: Record<string, number>
  welfareContent: Record<string, string>
  cardImages: Record<string, string>
  latestCommitteeNote: Parameters<typeof CommitteeNoteCard>[0]['latest']
  committeeNotesArchive: Parameters<typeof CommitteeNoteCard>[0]['archive']
  paymentAccount: Parameters<typeof HomeDonateCard>[0]['account']
}

type SheetKind = 'bill' | 'emergency' | 'chanda' | 'complaint' | null

export function Home2(props: Home2Props) {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const tiles = [
    { emoji: Siren, label: t('em.pageTitle', 'Emergency'), tint: 'bg-red-50 text-red-600', action: () => setSheet('emergency') },
    { emoji: Droplet, label: t('site.waterBill', 'Water Bill'), tint: 'bg-sky-50 text-sky-700', action: () => setSheet('bill'), system: 'water_supply' as const },
    { emoji: HandCoins, label: t('ch.pageTitle', 'Chanda'), tint: 'bg-emerald-50 text-emerald-700', action: () => setSheet('chanda'), system: 'donors_projects' as const },
    { emoji: PhoneCall, label: t('ic.pageTitle', 'Contacts'), tint: 'bg-amber-50 text-amber-700', href: '/contacts', system: 'donors_projects' as const },
    { emoji: ShoppingBag, label: t('cl.pageTitle', 'Buy & Sell'), tint: 'bg-violet-50 text-violet-600', href: '/classifieds', system: 'donors_projects' as const },
    { emoji: AlertTriangle, label: t('cr.pageTitle', 'Village Problems'), tint: 'bg-sky-50 text-sky-600', href: '/civic-reports', system: 'donors_projects' as const },
    { emoji: Megaphone, label: t('nb.pageTitle', 'Notice Board'), tint: 'bg-indigo-50 text-indigo-600', href: '/notice-board', system: 'donors_projects' as const },
    { emoji: Scale, label: t('z.pageTitle', 'Zakat'), tint: 'bg-lime-50 text-lime-700', href: '/zakat', system: 'donors_projects' as const },
    { emoji: Baby, label: t('kf.pageTitle', 'Kafalat'), tint: 'bg-blue-50 text-blue-700', href: '/kafalat', system: 'donors_projects' as const },
    { emoji: Droplet, label: t('bl.pageTitle', 'Blood'), tint: 'bg-rose-50 text-rose-600', href: '/blood', system: 'donors_projects' as const },
  ].filter((tile) => tile.system === undefined || (tile.system === 'water_supply' ? site.waterSupplyEnabled : site.donorsEnabled))

  // Real, admin-editable copy (migration 307 -- site_settings, Settings
  // page) for each card's headline/stat labels/CTA, not hardcoded text --
  // `wc(key, fallback)` reads the Urdu/English variant by language with
  // the same hardcoded string as a fallback only for a tenant that hasn't
  // customized it yet.
  const wc = (cardKey: string, field: string, fallback: string) =>
    props.welfareContent[`${cardKey}_${field}_${isUrdu ? 'ur' : 'en'}`] || fallback
  const welfareCards = [
    { key: 'welfare_1', emoji: '🕌', tint: 'bg-emerald-50', kicker: t('z.pageTitle', 'Zakat & Ushr'),
      head: wc('zakat', 'headline', isUrdu ? 'آپ کی زکوٰۃ ایک دروازے پر نہیں، ہر مستحق گھر تک' : 'Your zakat reaches every deserving door — not the same one twice.'),
      stat1: props.needs.verified_households ?? 0, stat1Label: wc('zakat', 'stat1', t('home.verifiedHouseholds', 'households verified')),
      stat2: props.needs.widow_headed ?? 0, stat2Label: wc('zakat', 'stat2', t('home.widowHeaded', 'widow-headed')),
      cta: wc('zakat', 'cta', t('home.zakatCta', 'Work out your zakat, or give')), href: '/zakat' },
    { key: 'welfare_2', emoji: '🎒', tint: 'bg-blue-50', kicker: t('kf.pageTitle', 'Kafalat — School'),
      head: wc('kafalat', 'headline', isUrdu ? 'ایک بچے کا بستہ اٹھائیے — ایک سال کی فیس، ایک عمر کا فرق' : 'Carry one child’s schoolbag. One year of fees; a lifetime of difference.'),
      stat1: props.kafalat.in_school ?? 0, stat1Label: wc('kafalat', 'stat1', t('home.childrenInSchool', 'children in school')),
      stat2: props.kafalat.waiting_sponsor ?? 0, stat2Label: wc('kafalat', 'stat2', t('home.waitingSponsor', 'waiting for a sponsor')),
      cta: wc('kafalat', 'cta', t('home.sponsorChild', 'Sponsor a child')), href: '/kafalat' },
    { key: 'welfare_3', emoji: '🎓', tint: 'bg-indigo-50', kicker: t('wz.pageTitle', 'Taleemi Wazifa'),
      head: wc('wazifa', 'headline', isUrdu ? 'آئیے، اس ہونہار بچے کو افسر، ڈاکٹر، انجینئر بنائیں' : 'Let us make this bright child an officer, a doctor, an engineer.'),
      stat1: props.wazifa.students_carried ?? 0, stat1Label: wc('wazifa', 'stat1', t('home.studentsCarried', 'students carried')),
      stat2: props.wazifa.finished_degree ?? 0, stat2Label: wc('wazifa', 'stat2', t('home.finishedDegree', 'finished degree')),
      cta: wc('wazifa', 'cta', t('home.applyOrSponsor', 'Apply or sponsor a student')), href: '/education' },
    { key: 'welfare_4', emoji: '🪔', tint: 'bg-amber-50', kicker: t('sj.pageTitle', 'Esal-e-Sawab'),
      head: wc('esal', 'headline', isUrdu ? 'جب تک پانی بہتا رہے، ثواب پہنچتا رہے' : 'While the water still runs, the reward still reaches them.'),
      stat1: props.sadqaWorking, stat1Label: wc('esal', 'stat1', t('home.stillWorking', 'still working today')),
      stat2: props.sadqaTotal, stat2Label: wc('esal', 'stat2', t('home.givenInAll', 'given in all')),
      cta: wc('esal', 'cta', t('home.seeBoard', 'See the board, or give one')), href: '/sadqa-jariya' },
  ]

  const mentorCards = [
    { key: 'mentor_1', emoji: '🧑‍🏫', tint: 'bg-emerald-50', kicker: t('home.mentorsAvailable', 'Mentors available'), count: props.careerCounts.mentors_available ?? 0,
      head: t('home.mentorHead', 'Talk to someone who’s already there'), href: '/mentor-directory' },
    { key: 'mentor_2', emoji: '🏫', tint: 'bg-blue-50', kicker: t('home.institutesListed', 'Institutes listed'), count: props.careerCounts.institutes ?? 0,
      head: t('home.institutesHead', 'Real places, not just links'), href: '/education' },
    { key: 'mentor_3', emoji: '🛠️', tint: 'bg-orange-50', kicker: t('home.openNow', 'Open now'), count: props.careerCounts.training_programs_open ?? 0,
      head: t('home.trainingHead', 'Hands-on sessions, close to home'), href: '/training-programs' },
    { key: 'mentor_4', emoji: '⭐', tint: 'bg-yellow-50', kicker: t('home.featured', 'Featured'), count: props.careerCounts.talent_showcased ?? 0,
      head: t('home.talentHead', 'Talented villagers, and how to help'), href: '/talent' },
  ]

  const fundTabs = [
    { emoji: Wallet, label: t('home.availableFunds', 'Available Funds'), value: `PKR ${fmtPKR(props.stats.available_funds)}`, cta: t('home.financialReport', 'Financial Report'), href: '/donate', visible: site.donorsEnabled },
    { emoji: GitBranch, label: t('home.activeDrives', 'Active Drives'), value: `${props.stats.active_projects}`, cta: t('home.viewAll', 'View Projects'), href: '/projects', visible: site.donorsEnabled },
    { emoji: Heart, label: t('home.thisMonth', 'This Month'), value: `PKR ${fmtPKR(props.stats.donations_this_month)}`, cta: t('home.donate', 'Donate'), href: '/donate', visible: site.donorsEnabled },
    { emoji: Users, label: t('home.registeredHouseholds', 'Households'), value: `${props.stats.registered_households}`, cta: t('home.registerConnection', 'Register a Connection'), href: '/water/apply', visible: site.waterSupplyEnabled },
  ].filter((f) => f.visible)
  const [fundTab, setFundTab] = useState(0)
  const cur = fundTabs[Math.min(fundTab, fundTabs.length - 1)]

  return (
    <div className="min-h-full flex flex-col bg-dp2-surface relative">
      <Header2 />

      <main className="flex-1 pb-20 lg:pb-8">
        <div className="max-w-[1200px] mx-auto px-3.5 lg:px-8 py-3.5 flex flex-col gap-4">

          {/* Hero — ayat card, same content HomeHero already shows */}
          <section className="relative rounded-2xl overflow-hidden bg-gradient-to-r from-dp2-primary to-dp2-primary-dark text-white p-5 lg:p-8 border border-dp2-gold/20 shadow-[0_4px_8px_rgba(0,0,0,.08)] text-center">
            <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'radial-gradient(#fff 1.4px, transparent 1.4px)', backgroundSize: '16px 16px' }} />
            <span className="relative inline-flex items-center gap-1 bg-dp2-gold text-slate-900 text-[10px] font-bold px-2.5 py-0.5 rounded-full">📖 {t('home.ayahChip', 'Verse of the day')}</span>
            <p dir="rtl" lang="ar" className="relative mt-2.5 font-quran font-medium text-[17px] lg:text-[22px] leading-[1.9]">
              ﴿وَيَسْأَلُونَكَ مَاذَا يُنفِقُونَ قُلِ الْعَفْوَ ۗ كَذَٰلِكَ يُبَيِّنُ اللَّهُ لَكُمُ الْآيَاتِ لَعَلَّكُمْ تَتَفَكَّرُونَ﴾
            </p>
            <div className="relative w-8 h-0.5 rounded bg-dp2-gold mx-auto my-2" />
            <p className="relative text-[12.5px] leading-[1.9] text-slate-100 max-w-xl mx-auto">
              {isUrdu
                ? 'اور آپ سے پوچھتے ہیں کہ کیا خرچ کریں؟ کہہ دیجیے: جو ضرورت سے زائد ہو (عفو)۔ اللہ اسی طرح تمہارے لیے احکام کھول کر بیان کرتا ہے تاکہ تم غور و فکر کرو۔'
                : 'They ask you what they should spend. Say: whatever is beyond your needs. This is how Allah makes His commands clear to you, so that you may reflect.'}
            </p>
            <p className="relative text-[10.5px] text-green-100/70 mt-1">{isUrdu ? '(سورۃ البقرہ، آیت 219)' : '(Surah Al-Baqarah, 2:219)'}</p>
            <h1 className="relative font-bold text-[18px] lg:text-[24px] mt-5">{isUrdu ? site.fullNameUrdu : site.fullName}</h1>
            <p className="relative text-green-100 text-[12.5px] mt-1.5 max-w-lg mx-auto">
              {isUrdu ? site.taglineUrdu : `Dedicated to the prosperity and welfare of ${site.name} village through transparent management, modern water systems, and communal support.`}
            </p>
          </section>

          <Card2 className="p-3.5">
            <WeatherDateRow />
            <VillageServicesQuickLinks />
          </Card2>

          {/* Emergency SOS bar */}
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0 w-[34px] h-[34px] rounded-[11px] bg-red-600 text-white flex items-center justify-center animate-pulse"><Siren size={18} /></span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-bold text-red-900">{t('em.pageTitle', 'Emergency')}</div>
                <div className="text-[10px] text-red-700">{t('home.sosSub', 'Police 15, Rescue 1122, Committee')}</div>
              </div>
            </div>
            <button onClick={() => setSheet('emergency')} className="shrink-0 bg-red-600 text-white text-[12px] font-bold px-3.5 py-2 rounded-xl cursor-pointer">{t('home.callNow', 'CALL NOW')}</button>
          </div>

          {/* Quick-action tiles belt */}
          <section className="flex flex-col gap-2">
            <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5">⚡ {t('home.whatYouCan', 'What You Can Do')}</h2>
            <Carousel2
              items={[tiles]}
              itemWidthClass="w-full"
              render={(row) => (
                <div className="grid grid-cols-5 gap-2">
                  {row.map((tile, i) => {
                    const inner = (
                      <>
                        <span className={`w-8 h-8 rounded-[10px] flex items-center justify-center ${tile.tint}`}><tile.emoji size={16} /></span>
                        <span className="text-[9px] font-semibold text-center leading-tight">{tile.label}</span>
                      </>
                    )
                    return tile.href ? (
                      <Link key={i} href={tile.href} className="bg-white border border-dp2-card-border rounded-2xl py-2.5 px-1 flex flex-col items-center gap-1.5">{inner}</Link>
                    ) : (
                      <button key={i} onClick={tile.action} className="bg-white border border-dp2-card-border rounded-2xl py-2.5 px-1 flex flex-col items-center gap-1.5 cursor-pointer">{inner}</button>
                    )
                  })}
                </div>
              )}
            />
          </section>

          {/* Fund status panel */}
          {fundTabs.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5">💰 {t('home.funds', 'Fund Status')}</h2>
              <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${fundTabs.length}, 1fr)` }}>
                {fundTabs.map((f, i) => (
                  <button key={i} onClick={() => setFundTab(i)}
                    className="flex flex-col items-center gap-0.5 py-2 rounded-[14px] text-[9.5px] font-semibold cursor-pointer border"
                    style={{ background: i === fundTab ? '#166534' : '#fff', color: i === fundTab ? '#fff' : '#334155', borderColor: i === fundTab ? '#166534' : '#e2e8f0' }}>
                    <f.emoji size={15} /> {f.label}
                  </button>
                ))}
              </div>
              <Link href={cur.href} className="rounded-2xl p-4 bg-gradient-to-r from-dp2-primary to-dp2-primary-dark text-white border border-dp2-gold/20 flex flex-col gap-1">
                <span className="text-[22px] font-extrabold tracking-tight">{cur.value}</span>
                <span className="text-[11px] font-bold text-dp2-amber">{cur.cta} ›</span>
              </Link>
            </section>
          )}

          {/* Ongoing Projects */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-0.5">
                <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary">🏗️ {t('home.ongoingProjects', 'Ongoing Projects')}</h2>
                <Link href="/projects" className="text-[10px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <Carousel2
                items={props.projects}
                render={(p) => (
                  <Link href={`/projects/${p.id}`} className="relative block h-[172px] rounded-2xl overflow-hidden border border-dp2-gold/20 shadow-[0_4px_8px_rgba(0,0,0,.08)]"
                    style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
                    <ImageSlot2 src={p.coverUrl} placeholder={t('home.addPhoto', 'Add photo')} />
                    <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(3,58,34,.96) 0%, rgba(3,58,34,.7) 40%, rgba(3,58,34,.1) 75%, transparent)' }} />
                    <span className="absolute top-2.5 end-2.5 text-[9.5px] font-bold px-2 py-0.5 rounded-full bg-dp2-gold text-slate-900">{p.status}</span>
                    <div className="absolute inset-x-3.5 bottom-3 text-white flex flex-col gap-1.5">
                      <div className="text-[12px] font-bold">{p.display_name || p.title}</div>
                      <div className="h-[5px] rounded-full bg-white/20 overflow-hidden"><div className="h-full rounded-full bg-dp2-gold" style={{ width: `${p.progress_percent}%` }} /></div>
                      <div className="grid grid-cols-3 gap-1.5 text-[9.5px]">
                        <div><div className="text-green-100">{t('home.progress', 'Progress')}</div><div dir="ltr" className="font-bold">{p.progress_percent}%</div></div>
                        <div><div className="text-green-100">{t('home.budget', 'Budget')}</div><div dir="ltr" className="font-bold">PKR {fmtPKR(p.budget_pkr)}</div></div>
                        <div><div className="text-green-100">{t('home.spent', 'Spent')}</div><div dir="ltr" className="font-bold">PKR {fmtPKR(p.spent)}</div></div>
                      </div>
                    </div>
                  </Link>
                )}
              />
              {props.projects.length === 0 && <Card2 className="p-8 text-center text-[13px] text-dp-on-surface-variant">{t('home.noProjects', 'No ongoing projects yet.')}</Card2>}
            </section>
          )}

          {/* Welfare & Education */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary">🤝 {t('home.welfareEducation', 'Welfare & Education')}</h2>
                  <Link href="/welfare" className="text-[10px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
                </div>
                <p className="text-[10px] text-slate-500 mt-0.5">{t('home.welfareIntro', 'Four ways the committee helps the people of the village. Nobody who registers for help is ever named on this website.')}</p>
              </div>
              <Carousel2
                items={welfareCards}
                render={(w) => (
                  <Card2 className="h-[172px] flex flex-row overflow-hidden" dir="ltr">
                    <div className="flex-none w-[36%] relative" style={{ background: 'linear-gradient(160deg,#005A36,#166534)' }}>
                      <ImageSlot2 src={props.cardImages[w.key]} placeholder="" />
                    </div>
                    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex-1 min-w-0 p-3 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 w-[30px] h-[30px] rounded-[10px] flex items-center justify-center text-[15px] ${w.tint}`}>{w.emoji}</span>
                        <div className="min-w-0">
                          <div className="text-[9px] font-bold uppercase text-emerald-600">{w.kicker}</div>
                          <div className="text-[11px] font-bold text-dp2-primary line-clamp-2">{w.head}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <div className="rounded-[10px] bg-dp2-surface border border-dp2-card-border px-2 py-1 flex items-center gap-1.5 min-w-0">
                          <span dir="ltr" className="font-extrabold text-[12px] text-dp2-primary">{w.stat1}</span>
                          <span className="text-[9px] text-slate-500 truncate">{w.stat1Label}</span>
                        </div>
                        <div className="rounded-[10px] bg-dp2-surface border border-dp2-card-border px-2 py-1 flex items-center gap-1.5 min-w-0">
                          <span dir="ltr" className="font-extrabold text-[12px] text-dp2-primary">{w.stat2}</span>
                          <span className="text-[9px] text-slate-500 truncate">{w.stat2Label}</span>
                        </div>
                      </div>
                      <Link href={w.href} className="mt-auto rounded-xl py-1.5 px-2 bg-dp2-primary-dark text-white text-[10px] font-bold text-center">{w.cta}</Link>
                    </div>
                  </Card2>
                )}
              />
            </section>
          )}

          {/* Mentors & Career Support */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5 flex items-center justify-between">
                <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary">🧭 {t('home.mentorsCareer', 'Mentors & Career Support')}</h2>
                <Link href="/mentor-directory" className="text-[10px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <Carousel2
                items={mentorCards}
                render={(m) => (
                  <Card2 className="h-[172px] flex flex-row overflow-hidden" dir="ltr">
                    <div className="flex-none w-[36%] relative" style={{ background: 'linear-gradient(160deg,#005A36,#166534)' }}>
                      <ImageSlot2 src={props.cardImages[m.key]} placeholder={t('home.studentPhoto', 'Photo')} />
                    </div>
                    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex-1 min-w-0 p-3 flex flex-col gap-1.5">
                      <span className="text-[9px] font-bold uppercase text-emerald-600">{m.kicker}{m.count ? ` · ${m.count}` : ''}</span>
                      <span className="text-[12px] font-bold text-dp2-primary">{m.head}</span>
                      <Link href={m.href} className="mt-auto rounded-xl py-1.5 px-2 bg-dp2-primary-dark text-white text-[10px] font-bold text-center">{t('home.viewAll', 'View')}</Link>
                    </div>
                  </Card2>
                )}
              />
            </section>
          )}

          {/* News */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5 flex items-center justify-between">
                <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary"><Newspaper size={13} className="inline me-1" />{t('home.latestNews', 'Latest News')}</h2>
                <Link href="/news" className="text-[10px] font-semibold text-dp2-primary-dark">{t('home.fullArchive', 'Full Archive')}</Link>
              </div>
              <Carousel2
                items={props.news}
                render={(n) => (
                  <Link href="/news">
                    <Card2 className="h-[172px] p-3.5 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12.5px] font-bold text-slate-800 line-clamp-1">{n.title}</span>
                        {n.is_featured && <span className="shrink-0 text-[9px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">★</span>}
                      </div>
                      <p className="text-[11px] text-slate-600 line-clamp-4 whitespace-pre-line">{n.content?.slice(0, 180)}</p>
                      <span className="mt-auto text-[9.5px] text-slate-400 uppercase">{n.category}</span>
                    </Card2>
                  </Link>
                )}
              />
              {props.news.length === 0 && <Card2 className="p-8 text-center text-[13px] text-dp-on-surface-variant">{t('home.noNews', 'No news yet.')}</Card2>}
            </section>
          )}

          {/* Videos */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5"><Video size={13} className="inline me-1" />{t('home.featuredVideos', 'Featured Videos')}</h2>
              <Carousel2
                items={props.videos}
                render={(v) => (
                  <Link href={`/videos/${v.id}`}>
                    <Card2 className="h-[172px] overflow-hidden flex flex-col">
                      <div className="relative flex-1 min-h-0" style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
                        <ImageSlot2 src={v.thumbnail_url} placeholder={t('home.thumb', 'Video thumbnail')} />
                        <span className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                          <Play size={18} className="text-dp2-primary ms-0.5" fill="#005A36" />
                        </span>
                      </div>
                      <div className="px-3 py-2 text-[11px] font-bold text-slate-800 truncate">{v.title}</div>
                    </Card2>
                  </Link>
                )}
              />
              {props.videos.length === 0 && <Card2 className="p-8 text-center text-[13px] text-dp-on-surface-variant">{t('home.noVideos', 'No videos yet.')}</Card2>}
            </section>
          )}

          {/* Blood registry */}
          {site.donorsEnabled && props.bloodGroups.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5">🩸 {t('home.bloodRegistry', 'Blood Donor Registry')}</h2>
              <Card2 className="p-3">
                <div className="grid grid-cols-4 gap-1.5">
                  {props.bloodGroups.map((g) => (
                    <div key={g.blood_group} className="rounded-xl bg-red-50 py-1.5 text-center">
                      <div dir="ltr" className="font-extrabold text-[13px] text-red-700">{g.blood_group}</div>
                      <div className="text-[9.5px] text-slate-500">{g.available_now} {t('home.ready', 'ready')}</div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2.5">
                  <Link href="/blood" className="rounded-xl py-2 bg-red-600 text-white text-[11.5px] font-bold text-center">{t('home.requestBlood', 'Request Blood')}</Link>
                  <Link href="/portal/blood-donor" className="rounded-xl py-2 border border-dp2-card-border text-[11.5px] font-bold text-center">{t('home.registerBloodDonor', 'Register as Donor')}</Link>
                </div>
              </Card2>
            </section>
          )}

          {/* Jobs / Donors / Volunteers */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5 flex items-center justify-between">
                <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary"><Briefcase size={13} className="inline me-1" />{t('home.jobBoard', 'Village Job Board')}</h2>
                <Link href="/jobs" className="text-[10px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {props.jobs.length === 0 ? (
                  <Card2 className="sm:col-span-3 p-3 flex items-center justify-between gap-3 border-dashed">
                    <span className="text-[11px] text-slate-500">{t('home.noListings', 'No listings yet.')}</span>
                    <Link href="/portal/post-job" className="shrink-0 rounded-xl px-3 py-1.5 bg-dp2-primary-dark text-white text-[10.5px] font-semibold">{t('home.postJob', 'Post the first one')}</Link>
                  </Card2>
                ) : props.jobs.map((j) => (
                  <Link key={j.id} href="/jobs"><Card2 className="p-3"><span className="text-[9.5px] uppercase text-slate-400">{j.category}</span><p className="text-[12px] font-semibold text-dp2-primary line-clamp-2 mt-1">{j.headline}</p></Card2></Link>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2.5 mt-1">
                <Card2 className="p-3 flex flex-col gap-1.5 overflow-hidden">
                  <span className="text-[11px] font-bold text-dp2-primary">🤲 {t('home.donorsTransparency', 'Donors')}</span>
                  {props.donors.length === 0 ? (
                    <span className="text-[9.5px] text-slate-400">{t('home.noDonors', 'No donors yet.')}</span>
                  ) : (
                    <div className="flex flex-col gap-1 max-h-[88px] overflow-y-auto">
                      {props.donors.map((d) => (
                        <div key={d.id} className="flex items-center justify-between gap-2 text-[10px]">
                          <span className="truncate text-slate-700 font-medium">{d.name}</span>
                          <span dir="ltr" className="shrink-0 font-bold text-dp2-primary-dark">{fmtPKR(d.amount_pkr)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <Link href="/donate" className="mt-auto rounded-xl py-1.5 border border-dp2-primary-dark text-dp2-primary-dark text-[10px] font-bold text-center">{t('home.viewFullList', 'View Full List')}</Link>
                </Card2>
                <Card2 className="p-3 flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold text-dp2-primary"><HandHeart size={12} className="inline me-1" />{t('home.volunteers', 'Volunteers')}</span>
                  <span className="text-[9.5px] text-slate-400">{props.volunteers.length === 0 ? t('home.noVolunteers', 'No volunteers yet.') : `${props.volunteers.length} ${t('home.active', 'active')}`}</span>
                  <Link href="/volunteer" className="mt-auto rounded-xl py-1.5 bg-dp2-primary-dark text-white text-[10px] font-bold text-center">{t('home.joinVolunteer', 'Join as Volunteer')}</Link>
                </Card2>
              </div>
            </section>
          )}

          {/* Achievements */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5 flex items-center justify-between">
                <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-dp2-primary"><Trophy size={13} className="inline me-1" />{t('home.achievements', 'Our Achievements')}</h2>
                <Link href="/achievements" className="text-[10px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <Card2 className="divide-y divide-slate-100 overflow-hidden">
                {props.achievements.length === 0 ? (
                  <div className="p-6 text-center text-[12px] text-slate-400">{t('home.nothingCompleted', 'Nothing completed yet.')}</div>
                ) : props.achievements.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 px-3 py-2.5">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                      {a.is_private ? <Lock size={11} /> : <span className="text-[11px] font-extrabold">✓</span>}
                    </span>
                    <span dir={a.is_private ? undefined : 'rtl'} className="text-[11.5px] text-slate-800">
                      {a.is_private ? `${t('home.privateTask', 'A private task was completed by')} ${a.done_by_name ?? 'a committee member'}` : a.text_ur}
                    </span>
                  </div>
                ))}
              </Card2>
            </section>
          )}

          {/* Committee note + Cash position + Donate (reusing existing, encapsulated real logic, restyled shell) */}
          <section className="grid lg:grid-cols-2 gap-3.5">
            <CommitteeNoteCard latest={props.latestCommitteeNote} archive={props.committeeNotesArchive} />
            <Card2 className="p-4" style={{ background: 'linear-gradient(to right,#005A36,#166534)', color: '#fff', border: '1px solid rgba(212,175,55,.2)' }}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-green-100 mb-1">{t('home.cashPosition', 'Cash Position')}</div>
              <div className="text-[22px] font-extrabold">PKR {fmtPKR(props.stats.available_funds)}</div>
              <div className="text-[10px] text-green-100">{t('home.totalLiquid', 'Total liquid balance')}</div>
              <div className="grid grid-cols-2 gap-2 mt-2.5">
                <div className="rounded-xl bg-white/10 px-2.5 py-1.5"><div dir="ltr" className="font-bold text-[13px] text-emerald-300">+{fmtPKR(props.stats.revenue_this_month)}</div><div className="text-[9.5px] text-green-100">{t('home.revenueMonth', 'Revenue (month)')}</div></div>
                <div className="rounded-xl bg-white/10 px-2.5 py-1.5"><div dir="ltr" className="font-bold text-[13px] text-red-300">-{fmtPKR(props.stats.expenses_this_month)}</div><div className="text-[9.5px] text-green-100">{t('home.expensesMonth', 'Expenses (month)')}</div></div>
              </div>
              <Link href="/donate" className="mt-3 inline-block text-[10.5px] font-bold text-dp2-amber">{t('home.financialReport', 'Financial Report')} ›</Link>
            </Card2>
          </section>

          {site.donorsEnabled && <HomeDonateCard account={props.paymentAccount} />}

          <DownloadAppBanner />
          <Footer2 />
        </div>
      </main>

      <BottomNav2 onOpenMore={() => setDrawerOpen(true)} />
      <DrawerNav2 open={drawerOpen} onClose={() => setDrawerOpen(false)} isPortalUser={false} isStaffUser={false} />

      {sheet === 'bill' && <BillSheet onClose={() => setSheet(null)} />}
      {sheet === 'emergency' && <EmergencySheet onClose={() => setSheet(null)} site={site} />}
      {sheet === 'chanda' && <ChandaSheet onClose={() => setSheet(null)} />}
    </div>
  )
}

function BillSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLocale()
  const [ref, setRef] = useState('')
  const [checked, setChecked] = useState(false)
  return (
    <BottomSheet2 title={t('v.checkBill', 'Check Water Bill')} onClose={onClose}>
      <label className="block text-[11px] font-semibold text-slate-600 mb-1">{t('v.connectionNo', 'Connection Number')}</label>
      <input dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="DP-0214" className="w-full border border-slate-200 rounded-xl px-3 py-2 text-[13px] outline-none" />
      <button onClick={() => ref.trim() && setChecked(true)} className="w-full mt-2 rounded-xl py-2.5 bg-dp2-primary-dark text-white text-[13px] font-bold cursor-pointer">{t('v.checkBill', 'Check Bill')}</button>
      {checked && (
        <Link href={`/water?ref=${encodeURIComponent(ref)}`} className="block mt-3 rounded-xl bg-emerald-50 p-3 text-[12px] font-bold text-dp2-primary">{t('v.openFullBillPage', 'Open your full bill on the Water Bill page')} →</Link>
      )}
    </BottomSheet2>
  )
}

function EmergencySheet({ onClose, site }: { onClose: () => void; site: ReturnType<typeof useSite> }) {
  const { t } = useLocale()
  return (
    <BottomSheet2 title={t('em.pageTitle', 'Emergency Helplines')} titleColor="#dc2626" onClose={onClose}>
      <div className="flex flex-col gap-2 text-[13px]">
        <a href="tel:1122" className="flex justify-between items-center p-2.5 bg-red-50 rounded-xl"><span className="font-bold">{t('em.rescue', 'Rescue 1122')}</span><span dir="ltr" className="bg-red-600 text-white px-3 py-1 rounded font-bold">1122</span></a>
        <a href="tel:15" className="flex justify-between items-center p-2.5 bg-blue-50 rounded-xl"><span className="font-bold">{t('em.police', 'Police')}</span><span dir="ltr" className="bg-blue-600 text-white px-3 py-1 rounded font-bold">15</span></a>
        {site.whatsapp && (
          <a href={`tel:${site.whatsapp.replace(/\D/g, '')}`} className="flex justify-between items-center p-2.5 bg-emerald-50 rounded-xl"><span className="font-bold">{t('em.committee', 'Committee Contact')}</span><span dir="ltr" className="bg-emerald-600 text-white px-3 py-1 rounded font-bold">{site.whatsapp}</span></a>
        )}
      </div>
    </BottomSheet2>
  )
}

function ChandaSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLocale()
  return (
    <BottomSheet2 title={t('ch.pageTitle', 'Give Chanda')} onClose={onClose}>
      <p className="text-[12px] text-slate-600 mb-3">{t('home.chandaSheetBody', 'Donate towards the general fund or any specific project, with your payment receipt.')}</p>
      <Link href="/donate" onClick={onClose} className="block w-full rounded-xl py-2.5 bg-dp2-primary-dark text-white text-[13px] font-bold text-center">{t('home.goToDonate', 'Continue to Donate')}</Link>
    </BottomSheet2>
  )
}
