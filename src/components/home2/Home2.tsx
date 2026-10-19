'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Droplet, Siren, HandCoins, PhoneCall, ShoppingBag, AlertTriangle, Megaphone, Scale, Baby, Newspaper,
  Video, Play, Briefcase, Trophy, Eye, HandHeart, Wallet, GitBranch, Heart, Users, Lock, School, GraduationCap,
  BookOpen, Landmark, Search,
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
import { HeroWeatherDate } from '@/components/design2/HeroWeatherDate'
import { QuickTilesBelt } from '@/components/design2/QuickTilesBelt'
import { CommitteeNoteCard } from '@/components/home/CommitteeNoteCard'
import { ZakatCalculator } from '@/components/welfare/ZakatCalculator'
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
  donors: { id: string; name: string; amount_pkr: number; date: string }[]
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
  classifieds: { id: string; title: string; price_pkr: number | null; photo_url: string | null; category: string }[]
  cardImages: Record<string, string>
  latestCommitteeNote: Parameters<typeof CommitteeNoteCard>[0]['latest']
  committeeNotesArchive: Parameters<typeof CommitteeNoteCard>[0]['archive']
  paymentAccount: Parameters<typeof HomeDonateCard>[0]['account']
}

type SheetKind = 'bill' | 'emergency' | 'chanda' | 'complaint' | 'contacts' | 'zakat' | 'kafalat' | 'blood' | 'committee' | null

export function Home2(props: Home2Props) {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Real bug found 2026-10-12, caught live on device: `t(key, fallback)`
  // always returns the English fallback when `key` is missing from the
  // dictionary -- regardless of the current language -- so every NEW
  // label this redesign introduced (anything not already in
  // src/lib/i18n/messages.ts) silently showed English even in Urdu
  // mode. This bypasses the dictionary for exactly those new strings
  // with real, direct bilingual text instead of a guessed key name;
  // every t(...) call left elsewhere in this file is a key already
  // confirmed to exist (verified against messages.ts).
  const ub = (en: string, ur: string) => (isUrdu ? ur : en)

  // Real gap found live on device: the template's own tile belt has 20
  // tiles (tiles.concat(tiles) in its beltRows), this only ever had 10 --
  // every one of the missing ten now gets its own real route (per direct
  // instruction, the next step after expanding this was wiring real
  // links, not toast stubs), matching the exact same routes DrawerNav2
  // already uses for these pages.
  const tiles = [
    { emoji: Siren, label: t('em.pageTitle', 'Emergency'), tint: 'bg-red-50 text-red-600', action: () => setSheet('emergency') },
    { emoji: Droplet, label: t('site.waterBill', 'Water Bill'), tint: 'bg-sky-50 text-sky-700', action: () => setSheet('bill'), system: 'water_supply' as const },
    { emoji: HandCoins, label: t('ch.pageTitle', 'Chanda'), tint: 'bg-emerald-50 text-emerald-700', action: () => setSheet('chanda'), system: 'donors_projects' as const },
    { emoji: PhoneCall, label: t('ic.pageTitle', 'Contacts'), tint: 'bg-amber-50 text-amber-700', action: () => setSheet('contacts'), system: 'donors_projects' as const },
    { emoji: ShoppingBag, label: t('cl.pageTitle', 'Buy & Sell'), tint: 'bg-violet-50 text-violet-600', href: '/classifieds', system: 'donors_projects' as const },
    { emoji: AlertTriangle, label: t('cr.pageTitle', 'Village Problems'), tint: 'bg-sky-50 text-sky-600', action: () => setSheet('complaint'), system: 'donors_projects' as const },
    { emoji: Megaphone, label: t('nb.pageTitle', 'Notice Board'), tint: 'bg-indigo-50 text-indigo-600', href: '/notice-board', system: 'donors_projects' as const },
    { emoji: BookOpen, label: t('dir.pageTitle', 'Directory'), tint: 'bg-teal-50 text-teal-600', href: '/directory', system: 'donors_projects' as const },
    { emoji: Scale, label: ub('Zakat', 'زکوٰۃ'), tint: 'bg-lime-50 text-lime-700', action: () => setSheet('zakat'), system: 'donors_projects' as const },
    { emoji: Baby, label: ub('Kafalat', 'کفالت'), tint: 'bg-blue-50 text-blue-700', action: () => setSheet('kafalat'), system: 'donors_projects' as const },
    { emoji: Droplet, label: ub('Blood', 'خون'), tint: 'bg-rose-50 text-rose-600', action: () => setSheet('blood'), system: 'donors_projects' as const },
    { emoji: Newspaper, label: t('home.latestNews', 'News'), tint: 'bg-sky-50 text-sky-700', href: '/news', system: 'donors_projects' as const },
    { emoji: Video, label: t('home.featuredVideos', 'Videos'), tint: 'bg-rose-50 text-rose-700', href: '/videos', system: 'donors_projects' as const },
    { emoji: Briefcase, label: t('home.jobBoard', 'Jobs'), tint: 'bg-amber-50 text-amber-800', href: '/jobs', system: 'donors_projects' as const },
    { emoji: Heart, label: t('home.donorsTransparency', 'Donors'), tint: 'bg-violet-50 text-violet-700', href: '/donate', system: 'donors_projects' as const },
    { emoji: HandHeart, label: t('home.volunteers', 'Volunteers'), tint: 'bg-emerald-50 text-emerald-800', href: '/volunteer', system: 'donors_projects' as const },
    { emoji: Trophy, label: t('home.achievements', 'Achievements'), tint: 'bg-yellow-50 text-yellow-700', href: '/achievements', system: 'donors_projects' as const },
    { emoji: Landmark, label: ub('Village History', 'گاؤں کی تاریخ'), tint: 'bg-stone-50 text-stone-700', href: '/about' },
    { emoji: Search, label: t('lf.pageTitle', 'Lost & Found'), tint: 'bg-slate-50 text-slate-600', href: '/lost-found', system: 'donors_projects' as const },
    { emoji: Users, label: t('site.committee', 'Committee'), tint: 'bg-green-50 text-green-700', action: () => setSheet('committee') },
  ].filter((tile) => tile.system === undefined || (tile.system === 'water_supply' ? site.waterSupplyEnabled : site.donorsEnabled))

  // Real, admin-editable copy (migration 307 -- site_settings, Settings
  // page) for each card's headline/stat labels/CTA, not hardcoded text --
  // `wc(key, fallback)` reads the Urdu/English variant by language with
  // the same hardcoded string as a fallback only for a tenant that hasn't
  // customized it yet.
  const wc = (cardKey: string, field: string, fallback: string) =>
    props.welfareContent[`${cardKey}_${field}_${isUrdu ? 'ur' : 'en'}`] || fallback
  const welfareCards = [
    { key: 'welfare_1', emoji: '🕌', tint: 'bg-emerald-50', kicker: ub('Zakat & Ushr', 'زکوٰۃ و عشر'),
      head: wc('zakat', 'headline', isUrdu ? 'آپ کی زکوٰۃ ایک دروازے پر نہیں، ہر مستحق گھر تک' : 'Your zakat reaches every deserving door — not the same one twice.'),
      stat1: props.needs.verified_households ?? 0, stat1Label: wc('zakat', 'stat1', ub('households verified', 'تصدیق شدہ گھرانے')),
      stat2: props.needs.widow_headed ?? 0, stat2Label: wc('zakat', 'stat2', ub('widow-headed', 'بیوہ سربراہ')),
      cta: wc('zakat', 'cta', ub('Work out your zakat, or give', 'زکوٰۃ کا حساب لگائیں یا ادا کریں')), href: '/portal/zakat' },
    { key: 'welfare_2', emoji: '🎒', tint: 'bg-blue-50', kicker: ub('Kafalat — School', 'کفالت — سکول'),
      head: wc('kafalat', 'headline', isUrdu ? 'ایک بچے کا بستہ اٹھائیے — ایک سال کی فیس، ایک عمر کا فرق' : 'Carry one child’s schoolbag. One year of fees; a lifetime of difference.'),
      stat1: props.kafalat.in_school ?? 0, stat1Label: wc('kafalat', 'stat1', ub('children in school', 'سکول میں بچے')),
      stat2: props.kafalat.waiting_sponsor ?? 0, stat2Label: wc('kafalat', 'stat2', ub('waiting for a sponsor', 'کفیل کے منتظر')),
      cta: wc('kafalat', 'cta', ub('Sponsor a child', 'ایک بچے کی کفالت کریں')), href: '/portal/kafalat' },
    { key: 'welfare_3', emoji: '🎓', tint: 'bg-indigo-50', kicker: ub('Taleemi Wazifa', 'تعلیمی وظیفہ'),
      head: wc('wazifa', 'headline', isUrdu ? 'آئیے، اس ہونہار بچے کو افسر، ڈاکٹر، انجینئر بنائیں' : 'Let us make this bright child an officer, a doctor, an engineer.'),
      stat1: props.wazifa.students_carried ?? 0, stat1Label: wc('wazifa', 'stat1', ub('students carried', 'مدد پانے والے طلبہ')),
      stat2: props.wazifa.finished_degree ?? 0, stat2Label: wc('wazifa', 'stat2', ub('finished degree', 'ڈگری مکمل')),
      cta: wc('wazifa', 'cta', ub('Apply or sponsor a student', 'درخواست دیں یا سرپرستی کریں')), href: '/portal/wazifa' },
    { key: 'welfare_4', emoji: '🪔', tint: 'bg-amber-50', kicker: ub('Esal-e-Sawab', 'ایصالِ ثواب'),
      head: wc('esal', 'headline', isUrdu ? 'جب تک پانی بہتا رہے، ثواب پہنچتا رہے' : 'While the water still runs, the reward still reaches them.'),
      stat1: props.sadqaWorking, stat1Label: wc('esal', 'stat1', ub('still working today', 'آج بھی کارآمد')),
      stat2: props.sadqaTotal, stat2Label: wc('esal', 'stat2', ub('given in all', 'کل عطیات')),
      cta: wc('esal', 'cta', ub('See the board, or give one', 'بورڈ دیکھیں یا عطیہ کریں')), href: '/sadqa-jariya' },
  ]

  // Real routes (matching the original CareerCards.tsx component exactly):
  // mentors/institutes/training-programs are portal-only action flows,
  // not public info pages -- only Talent Showcase has a public page.
  const mentorCards = [
    { key: 'mentor_1', emoji: '🧑‍🏫', tint: 'bg-emerald-50', kicker: ub('Mentors available', 'رہنما دستیاب'), count: props.careerCounts.mentors_available ?? 0,
      head: ub('Talk to someone who’s already there', 'اپنے ہی گاؤں سے رہنمائی'), href: '/portal/mentors' },
    { key: 'mentor_2', emoji: '🏫', tint: 'bg-blue-50', kicker: ub('Institutes listed', 'ادارے'), count: props.careerCounts.institutes ?? 0,
      head: ub('Real places, not just links', 'کہاں سے سیکھیں'), href: '/portal/institutes' },
    { key: 'mentor_3', emoji: '🛠️', tint: 'bg-orange-50', kicker: ub('Open now', 'ابھی جاری'), count: props.careerCounts.training_programs_open ?? 0,
      head: ub('Hands-on sessions, close to home', 'گاؤں میں تربیت'), href: '/portal/training-programs' },
    { key: 'mentor_4', emoji: '⭐', tint: 'bg-yellow-50', kicker: ub('Featured', 'نمایاں'), count: props.careerCounts.talent_showcased ?? 0,
      head: ub('Talented villagers, and how to help', 'ہنر کی پہچان'), href: '/talent' },
  ]

  // Real gap found 2026-10-12, then corrected per direct instruction: the
  // original design template's own HUB content (online taxi, shared ride,
  // buy-for-me) was placeholder material from the design tool, not this
  // app's real marketplace -- this app already HAS a real, shipped
  // marketplace (the portal's own "Two Pillars": Shops & Market, and
  // Travel & Transport's adda board / city orders / city purchase /
  // commute / hourly / shadi vehicles -- see
  // src/app/portal/(dashboard)/marketplace/{page,travel}.tsx). These six
  // cards are that real feature set, with its own real, already-editable
  // dictionary copy (mp.*/af.*/vp.* keys), not invented text -- and real
  // routes, which the /portal auth gate already redirects to login for
  // a signed-out visitor, same as every other portal link on this page.
  const marketplaceHub = [
    { key: 'mp_shops', emoji: '🏪', title: t('mp.shopsPillarTitle', 'Shops & Market'), sub: t('mp.shopsPillarHint', 'Order from village shops or from the city'), chip: ub('Shops', 'دکانیں'), tags: [], bg: 'linear-gradient(to right,#005A36,#166534)', href: '/portal/marketplace/shops' },
    { key: 'mp_adda', emoji: '🚐', title: t('af.addaBoardPageTitle', 'Adda Board'), sub: t('af.addaBoardCardHint', 'Live queue, timings and seats for the village-to-city stands'), chip: ub('Live', 'لائیو'), tags: [], bg: 'linear-gradient(to right,#033a22,#005A36)', href: '/portal/marketplace/adda' },
    { key: 'mp_order_city', emoji: '🛒', title: t('vp.dispatchPageTitle', 'Order From a City Shop'), sub: t('vp.orderCityCardHint', 'Post what you need — nearby vehicles answer, cheaper if one is already there'), chip: ub('City', 'شہر'), tags: [], bg: 'linear-gradient(to right,#78350f,#b45309)', href: '/portal/marketplace/order-city' },
    { key: 'mp_city_purchase', emoji: '📦', title: t('vp.cityPurchasePageTitle', 'City Purchase'), sub: t('vp.cityPurchaseCardHint', 'Buy a specific item from a shop or pharmacy — attach a photo, pin the spot, a driver purchases and delivers it'), chip: ub('Purchase', 'خریداری'), tags: [], bg: 'linear-gradient(to right,#ab4823,#C85A32)', href: '/portal/marketplace/city-purchase' },
    { key: 'mp_parcel', emoji: '✉️', title: t('vp.parcelPageTitle', 'Parcel Delivery'), sub: t('vp.parcelCardHint', 'Send an existing item with a driver already headed that way'), chip: ub('Parcel', 'پارسل'), tags: [], bg: 'linear-gradient(to right,#713f12,#a16207)', href: '/portal/marketplace/parcel' },
    { key: 'mp_commute', emoji: '🚗', title: t('vp.commutePageTitle', 'Weekend Commute'), sub: t('vp.commuteCardHint', 'Match with a driver who runs your weekly city commute'), chip: ub('Commute', 'سفر'), tags: [], bg: 'linear-gradient(to right,#0c4a6e,#0369a1)', href: '/portal/marketplace/commute' },
    { key: 'mp_shadi', emoji: '💐', title: t('vp.shadiPageTitle', 'Shadi Vehicles'), sub: t('vp.shadiPageSubtitle', 'Hand-pick vehicles for a wedding day at their flat full-day rate.'), chip: ub('Shadi', 'شادی'), tags: [], bg: 'linear-gradient(to right,#3b0764,#6d28d9)', href: '/portal/marketplace/shadi' },
  ]

  const fundTabs = [
    { key: 'fund_available', emoji: Wallet, label: t('home.availableFunds', 'Available Funds'), value: `PKR ${fmtPKR(props.stats.available_funds)}`, cta: t('home.financialReport', 'Financial Report'), href: '/donate', visible: site.donorsEnabled,
      subs: [
        { v: `+${fmtPKR(props.stats.revenue_this_month)}`, k: t('home.revenueMonth', 'Revenue (month)'), c: '#86efac' },
        { v: `-${fmtPKR(props.stats.expenses_this_month)}`, k: t('home.expensesMonth', 'Expenses (month)'), c: '#fca5a5' },
      ] },
    { key: 'fund_drives', emoji: GitBranch, label: t('home.activeDrives', 'Active Drives'), value: `${props.stats.active_projects}`, cta: t('home.viewAll', 'View Projects'), href: '/projects', visible: site.donorsEnabled, subs: [] },
    { key: 'fund_month', emoji: Heart, label: t('home.thisMonth', 'This Month'), value: `PKR ${fmtPKR(props.stats.donations_this_month)}`, cta: ub('Donate', 'عطیہ دیں'), href: '/donate', visible: site.donorsEnabled, subs: [] },
    { key: 'fund_households', emoji: Users, label: t('home.registeredHouseholds', 'Households'), value: `${props.stats.registered_households}`, cta: ub('Register a Connection', 'کنکشن رجسٹر کریں'), href: '/water/apply', visible: site.waterSupplyEnabled, subs: [] },
  ].filter((f) => f.visible)
  const [fundTab, setFundTab] = useState(0)
  const cur = fundTabs[Math.min(fundTab, fundTabs.length - 1)]

  // Real gap found live on device: this never advanced on its own, same
  // issue as the carousels above (and fixed the same way) -- cycles on
  // its own cadence, restarting whenever a visitor taps a tab directly
  // so a manual choice doesn't get immediately overridden mid-read.
  useEffect(() => {
    if (fundTabs.length <= 1) return
    const id = setInterval(() => setFundTab((i) => (i + 1) % fundTabs.length), 5400)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundTabs.length, fundTab])

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="min-h-full flex flex-col bg-dp2-surface relative">
      <Header2 />

      <main className="flex-1 pb-20 lg:pb-8">
        <div className="max-w-[1200px] mx-auto px-3.5 lg:px-8 py-3.5 flex flex-col gap-4">

          {/* Hero — ayat card + the real compact weather/date mini-rows
              inside it, matching the original template's actual layout
              (not a separate full-size weather/date section below). */}
          <section className="relative rounded-2xl overflow-hidden bg-gradient-to-r from-dp2-primary to-dp2-primary-dark text-white p-5 lg:p-8 border border-dp2-gold/20 shadow-[0_4px_8px_rgba(0,0,0,.08)] text-center">
            <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'radial-gradient(#fff 1.4px, transparent 1.4px)', backgroundSize: '16px 16px' }} />
            <HeroWeatherDate />
            <span className="relative inline-flex items-center gap-1 bg-dp2-gold text-slate-900 text-[11px] font-bold px-2.5 py-0.5 rounded-full mt-3">📖 {ub('Verse of the day', 'آیتِ مبارکہ')}</span>
            <p dir="rtl" lang="ar" className="relative mt-2.5 font-quran font-medium text-[18px] lg:text-[23px] leading-[1.9]">
              ﴿وَيَسْأَلُونَكَ مَاذَا يُنفِقُونَ قُلِ الْعَفْوَ ۗ كَذَٰلِكَ يُبَيِّنُ اللَّهُ لَكُمُ الْآيَاتِ لَعَلَّكُمْ تَتَفَكَّرُونَ﴾
            </p>
            <div className="relative w-8 h-0.5 rounded bg-dp2-gold mx-auto my-2" />
            <p className="relative text-[13.5px] leading-[1.9] text-slate-100 max-w-xl mx-auto">
              {isUrdu
                ? 'اور آپ سے پوچھتے ہیں کہ کیا خرچ کریں؟ کہہ دیجیے: جو ضرورت سے زائد ہو (عفو)۔ اللہ اسی طرح تمہارے لیے احکام کھول کر بیان کرتا ہے تاکہ تم غور و فکر کرو۔'
                : 'They ask you what they should spend. Say: whatever is beyond your needs. This is how Allah makes His commands clear to you, so that you may reflect.'}
            </p>
            <p className="relative text-[11.5px] text-green-100/70 mt-1">{isUrdu ? '(سورۃ البقرہ، آیت 219)' : '(Surah Al-Baqarah, 2:219)'}</p>
            <h1 className="relative font-bold text-[19px] lg:text-[25px] mt-5">{isUrdu ? site.fullNameUrdu : site.fullName}</h1>
            <p className="relative text-green-100 text-[13.5px] mt-1.5 max-w-lg mx-auto">
              {isUrdu ? site.taglineUrdu : `Dedicated to the prosperity and welfare of ${site.name} village through transparent management, modern water systems, and communal support.`}
            </p>
          </section>

          {/* Emergency SOS bar */}
          <div className="bg-red-50 border border-red-200 rounded-2xl p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0 w-[34px] h-[34px] rounded-[11px] bg-red-600 text-white flex items-center justify-center animate-pulse"><Siren size={18} /></span>
              <div className="min-w-0">
                <div className="text-[13.5px] font-bold text-red-900">{t('em.pageTitle', 'Emergency')}</div>
                <div className="text-[11px] text-red-700">{ub('Police 15, Rescue 1122, Committee', 'پولیس 15، ریسکیو 1122، کمیٹی')}</div>
              </div>
            </div>
            <button onClick={() => setSheet('emergency')} className="shrink-0 bg-red-600 text-white text-[13px] font-bold px-3.5 py-2 rounded-xl cursor-pointer">{ub('CALL NOW', 'ابھی کال کریں')}</button>
          </div>

          {/* Quick-action tiles belt -- real gap found live on device: this
              was a static 5-col grid (duplicating VillageServicesQuickLinks'
              own tiles below it, now removed). The template's own tiles are
              a single continuously auto-scrolling belt, same marquee
              mechanic as the news ticker above -- QuickTilesBelt reuses
              that exact CSS (.ticker-track), not a paginated carousel. */}
          <section className="flex flex-col gap-2">
            <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5">⚡ {ub('What You Can Do', 'آپ کیا کر سکتے ہیں')}</h2>
            <QuickTilesBelt tiles={tiles} />
          </section>

          {/* Fund status panel -- moved above Marketplace per direct
              instruction. */}
          {fundTabs.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5">💰 {ub('Fund Status', 'فنڈ کی صورتحال')}</h2>
              <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${fundTabs.length}, 1fr)` }}>
                {fundTabs.map((f, i) => (
                  <button key={i} onClick={() => setFundTab(i)}
                    className="flex flex-col items-center gap-0.5 py-2 rounded-[14px] text-[10.5px] font-semibold cursor-pointer border"
                    style={{ background: i === fundTab ? '#166534' : '#fff', color: i === fundTab ? '#fff' : '#334155', borderColor: i === fundTab ? '#166534' : '#e2e8f0' }}>
                    <f.emoji size={15} /> {f.label}
                  </button>
                ))}
              </div>
              <Link href={cur.href} className="relative block h-[172px] rounded-2xl overflow-hidden border border-dp2-gold/20 shadow-[0_4px_8px_rgba(0,0,0,.08)]"
                style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
                <ImageSlot2 src={props.cardImages[cur.key]} placeholder="" />
                <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(3,58,34,.96) 0%, rgba(3,58,34,.75) 38%, transparent 62%)' }} />
                <div className="absolute inset-3.5 flex flex-col gap-1 text-white">
                  <span className="text-[23px] font-extrabold tracking-tight">{cur.value}</span>
                  {cur.subs.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      {cur.subs.map((s) => (
                        <div key={s.k} className="rounded-xl bg-white/10 px-2.5 py-1.5">
                          <div dir="ltr" className="font-bold text-[15px]" style={{ color: s.c }}>{s.v}</div>
                          <div className="text-[11px] text-green-100">{s.k}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12.5px] text-green-100 mt-1 leading-relaxed">{cur.label}</p>
                  )}
                  <span className="text-[12px] font-bold text-dp2-amber mt-auto">{cur.cta} ›</span>
                </div>
              </Link>
            </section>
          )}

          {/* Marketplace services carousel -- the real "Two Pillars" +
              Travel sub-features already shipped in the portal (see
              marketplaceHub's own comment), not placeholder content. */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-0.5">
              <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary">🛍️ {t('mp.pageTitle', 'Marketplace')}</h2>
              <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-dp2-primary-dark">● {ub('Live', 'لائیو')}</span>
            </div>
            <Carousel2
              autoMs={4800}
              items={marketplaceHub}
              render={(h) => (
                <Link
                  href={h.href}
                  className="relative block w-full h-[172px] overflow-hidden rounded-2xl border border-dp2-gold/25 shadow-[0_4px_10px_rgba(0,0,0,.08)]"
                  style={{ background: h.bg }}
                >
                  <ImageSlot2 src={props.cardImages[h.key]} placeholder="" />
                  <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(3,58,34,.94) 0%, rgba(3,58,34,.7) 40%, transparent 68%)' }} />
                  <div className="absolute inset-3.5 flex flex-col gap-2 text-white">
                    <span className="relative flex items-center justify-between gap-2">
                      <span className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center text-[20px] bg-dp2-gold">{h.emoji}</span>
                      <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp2-gold text-slate-900">{h.chip}</span>
                    </span>
                    <span className="relative block mt-auto">
                      <span className="block text-[14px] font-bold">{h.title}</span>
                      <span className="block text-[10.5px] opacity-90 mt-0.5">{h.sub}</span>
                    </span>
                  </div>
                </Link>
              )}
            />
          </section>

          {/* Ongoing Projects */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-0.5">
                <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary">🏗️ {t('home.ongoingProjects', 'Ongoing Projects')}</h2>
                <Link href="/projects" className="text-[11px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <Carousel2
                autoMs={5200}
                items={props.projects}
                render={(p) => (
                  <Link href={`/projects/${p.id}`} className="relative block h-[172px] rounded-2xl overflow-hidden border border-dp2-gold/20 shadow-[0_4px_8px_rgba(0,0,0,.08)]"
                    style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
                    <ImageSlot2 src={p.coverUrl} placeholder={ub('Add photo', 'تصویر لگائیں')} />
                    <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(3,58,34,.96) 0%, rgba(3,58,34,.75) 38%, transparent 62%)' }} />
                    <span className="absolute top-2.5 end-2.5 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp2-gold text-slate-900">{p.status}</span>
                    <div className="absolute inset-x-3.5 bottom-3 text-white flex flex-col gap-1.5">
                      <div className="text-[13px] font-bold">{p.display_name || p.title}</div>
                      <div className="h-[5px] rounded-full bg-white/20 overflow-hidden"><div className="h-full rounded-full bg-dp2-gold" style={{ width: `${p.progress_percent}%` }} /></div>
                      <div className="grid grid-cols-3 gap-1.5 text-[10.5px]">
                        <div><div className="text-green-100">{t('home.progress', 'Progress')}</div><div dir="ltr" className="font-bold">{p.progress_percent}%</div></div>
                        <div><div className="text-green-100">{t('home.budget', 'Budget')}</div><div dir="ltr" className="font-bold">PKR {fmtPKR(p.budget_pkr)}</div></div>
                        <div><div className="text-green-100">{t('home.spent', 'Spent')}</div><div dir="ltr" className="font-bold">PKR {fmtPKR(p.spent)}</div></div>
                      </div>
                    </div>
                  </Link>
                )}
              />
              {props.projects.length === 0 && <Card2 className="p-8 text-center text-[14px] text-dp-on-surface-variant">{t('home.noProjects', 'No ongoing projects yet.')}</Card2>}
            </section>
          )}

          {/* Welfare & Education */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary">🤝 {ub('Welfare & Education', 'فلاح و تعلیم')}</h2>
                  <Link href="/welfare" className="text-[11px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">{ub('Four ways the committee helps the people of the village. Nobody who registers for help is ever named on this website.', 'کمیٹی گاؤں کے لوگوں کی چار طریقوں سے مدد کرتی ہے۔ مدد لینے والے کسی شخص کا نام ویب سائٹ پر ظاہر نہیں کیا جاتا۔')}</p>
              </div>
              <Carousel2
                autoMs={6200}
                items={welfareCards}
                render={(w) => (
                  <Card2 className="h-[172px] flex flex-row overflow-hidden">
                    <div className="flex-none w-[36%] relative" style={{ background: 'linear-gradient(160deg,#005A36,#166534)' }}>
                      <ImageSlot2 src={props.cardImages[w.key]} placeholder="" />
                    </div>
                    <div className="flex-1 min-w-0 p-3 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 w-[30px] h-[30px] rounded-[10px] flex items-center justify-center text-[16px] ${w.tint}`}>{w.emoji}</span>
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold uppercase text-emerald-600">{w.kicker}</div>
                          <div className="text-[12px] font-bold text-dp2-primary line-clamp-2">{w.head}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <div className="rounded-[10px] bg-dp2-surface border border-dp2-card-border px-2 py-1 flex items-center gap-1.5 min-w-0">
                          <span dir="ltr" className="font-extrabold text-[13px] text-dp2-primary">{w.stat1}</span>
                          <span className="text-[10px] text-slate-500 truncate">{w.stat1Label}</span>
                        </div>
                        <div className="rounded-[10px] bg-dp2-surface border border-dp2-card-border px-2 py-1 flex items-center gap-1.5 min-w-0">
                          <span dir="ltr" className="font-extrabold text-[13px] text-dp2-primary">{w.stat2}</span>
                          <span className="text-[10px] text-slate-500 truncate">{w.stat2Label}</span>
                        </div>
                      </div>
                      <Link href={w.href} className="mt-auto rounded-xl py-1.5 px-2 bg-dp2-primary-dark text-white text-[11px] font-bold text-center">{w.cta}</Link>
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
                <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary">🧭 {ub('Mentors & Career Support', 'رہنمائی اور کیریئر')}</h2>
                <Link href="/portal/mentors" className="text-[11px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <Carousel2
                autoMs={5600}
                items={mentorCards}
                render={(m) => (
                  <Card2 className="h-[172px] flex flex-row overflow-hidden">
                    <div className="flex-none w-[36%] relative" style={{ background: 'linear-gradient(160deg,#005A36,#166534)' }}>
                      <ImageSlot2 src={props.cardImages[m.key]} placeholder={ub('Photo', 'تصویر لگائیں')} />
                    </div>
                    <div className="flex-1 min-w-0 p-3 flex flex-col gap-1.5">
                      <span className="text-[10px] font-bold uppercase text-emerald-600">{m.kicker}{m.count ? ` · ${m.count}` : ''}</span>
                      <span className="text-[13px] font-bold text-dp2-primary">{m.head}</span>
                      <Link href={m.href} className="mt-auto rounded-xl py-1.5 px-2 bg-dp2-primary-dark text-white text-[11px] font-bold text-center">{t('home.viewAll', 'View')}</Link>
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
                <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary"><Newspaper size={13} className="inline me-1" />{t('home.latestNews', 'Latest News')}</h2>
                <Link href="/news" className="text-[11px] font-semibold text-dp2-primary-dark">{t('home.fullArchive', 'Full Archive')}</Link>
              </div>
              <Carousel2
                autoMs={6800}
                items={props.news}
                render={(n) => (
                  <Link href="/news">
                    <Card2 className="h-[172px] p-3.5 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13.5px] font-bold text-slate-800 line-clamp-1">{n.title}</span>
                        {n.is_featured && <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">★</span>}
                      </div>
                      <p className="text-[12px] text-slate-600 line-clamp-4 whitespace-pre-line">{n.content?.slice(0, 180)}</p>
                      <span className="mt-auto text-[10.5px] text-slate-400 uppercase">{n.category}</span>
                    </Card2>
                  </Link>
                )}
              />
              {props.news.length === 0 && <Card2 className="p-8 text-center text-[14px] text-dp-on-surface-variant">{t('home.noNews', 'No news yet.')}</Card2>}
            </section>
          )}

          {/* Videos */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5"><Video size={13} className="inline me-1" />{t('home.featuredVideos', 'Featured Videos')}</h2>
              <Carousel2
                autoMs={7200}
                items={props.videos}
                render={(v) => (
                  <Link href={`/videos/${v.id}`}>
                    <Card2 className="h-[172px] overflow-hidden flex flex-col">
                      <div className="relative flex-1 min-h-0" style={{ background: 'linear-gradient(135deg,#005A36,#166534)' }}>
                        <ImageSlot2 src={v.thumbnail_url} placeholder={ub('Video thumbnail', 'ویڈیو کی تصویر')} />
                        <span className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                          <Play size={18} className="text-dp2-primary ms-0.5" fill="#005A36" />
                        </span>
                      </div>
                      <div className="px-3 py-2 text-[12px] font-bold text-slate-800 truncate">{v.title}</div>
                    </Card2>
                  </Link>
                )}
              />
              {props.videos.length === 0 && <Card2 className="p-8 text-center text-[14px] text-dp-on-surface-variant">{t('home.noVideos', 'No videos yet.')}</Card2>}
            </section>
          )}

          {/* Buy & Sell -- real gap found live on device: this section was
              entirely missing. Real classified_listings data (same table
              /classifieds and the portal posting flow use), not the
              template's own fake tractor/wheat-straw placeholder items. No
              per-listing detail page exists (classifieds is a flat browse
              list), so every card links to /classifieds itself. */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5 flex items-center justify-between">
                <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary">🛒 {t('cl.pageTitle', 'Buy & Sell')}</h2>
                <Link href="/classifieds" className="text-[11px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              {props.classifieds.length === 0 ? (
                <Card2 className="p-8 text-center text-[14px] text-dp-on-surface-variant">{ub('No listings yet.', 'ابھی تک کوئی چیز شامل نہیں کی گئی۔')}</Card2>
              ) : (
                <div className="grid grid-cols-2 gap-2.5">
                  {props.classifieds.map((c) => (
                    <Link key={c.id} href="/classifieds">
                      <Card2 className="overflow-hidden flex flex-col">
                        <div className="relative h-24" style={{ background: 'linear-gradient(135deg,#166534,#005A36)' }}>
                          <ImageSlot2 src={c.photo_url} placeholder={ub('Photo', 'تصویر')} />
                          <span className="absolute top-1.5 end-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-dp2-gold text-slate-900">{t(`cl.cat.${c.category}`, c.category)}</span>
                        </div>
                        <div className="p-2.5 flex flex-col gap-0.5">
                          <span className="text-[12.5px] font-bold text-slate-800 line-clamp-1">{c.title}</span>
                          {c.price_pkr != null && <span dir="ltr" className="text-[13px] font-extrabold text-dp2-primary-dark">PKR {fmtPKR(c.price_pkr)}</span>}
                        </div>
                      </Card2>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Blood registry */}
          {site.donorsEnabled && props.bloodGroups.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary px-0.5">🩸 {t('home.bloodRegistry', 'Blood Donor Registry')}</h2>
              <Card2 className="p-3">
                <div className="grid grid-cols-4 gap-1.5">
                  {props.bloodGroups.map((g) => (
                    <div key={g.blood_group} className="rounded-xl bg-red-50 py-1.5 text-center">
                      <div dir="ltr" className="font-extrabold text-[14px] text-red-700">{g.blood_group}</div>
                      <div className="text-[10.5px] text-slate-500">{g.available_now} {t('home.ready', 'ready')}</div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2.5">
                  <Link href="/blood" className="rounded-xl py-2 bg-red-600 text-white text-[12.5px] font-bold text-center">{t('home.requestBlood', 'Request Blood')}</Link>
                  <Link href="/portal/blood-donor" className="rounded-xl py-2 border border-dp2-card-border text-[12.5px] font-bold text-center">{t('home.registerBloodDonor', 'Register as Donor')}</Link>
                </div>
              </Card2>
            </section>
          )}

          {/* Jobs / Donors / Volunteers */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5 flex items-center justify-between">
                <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary"><Briefcase size={13} className="inline me-1" />{t('home.jobBoard', 'Village Job Board')}</h2>
                <Link href="/jobs" className="text-[11px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {props.jobs.length === 0 ? (
                  <Card2 className="sm:col-span-3 p-3 flex items-center justify-between gap-3 border-dashed">
                    <span className="text-[12px] text-slate-500">{t('home.noListings', 'No listings yet.')}</span>
                    <Link href="/portal/post-job" className="shrink-0 rounded-xl px-3 py-1.5 bg-dp2-primary-dark text-white text-[11.5px] font-semibold">{t('home.postJob', 'Post the first one')}</Link>
                  </Card2>
                ) : props.jobs.map((j) => (
                  <Link key={j.id} href="/jobs"><Card2 className="p-3"><span className="text-[10.5px] uppercase text-slate-400">{j.category}</span><p className="text-[13px] font-semibold text-dp2-primary line-clamp-2 mt-1">{j.headline}</p></Card2></Link>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2.5 mt-1">
                <Card2 className="p-3 min-h-[172px] flex flex-col gap-1.5 overflow-hidden">
                  <span className="text-[12px] font-bold text-dp2-primary">🤲 {t('home.donorsTransparency', 'Donors')}</span>
                  {props.donors.length === 0 ? (
                    <span className="text-[10.5px] text-slate-400">{t('home.noDonors', 'No donors yet.')}</span>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {props.donors.map((d) => (
                        <div key={d.id} className="flex items-center justify-between gap-2 text-[11.5px]">
                          <span className="truncate text-slate-700 font-medium">{d.name}</span>
                          <span dir="ltr" className="shrink-0 font-bold text-dp2-primary-dark">{fmtPKR(d.amount_pkr)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <Link href="/donate" className="mt-auto rounded-xl py-1.5 border border-dp2-primary-dark text-dp2-primary-dark text-[11px] font-bold text-center">{t('home.viewFullList', 'View Full List')}</Link>
                </Card2>
                <Card2 className="p-3 min-h-[172px] flex flex-col gap-1.5 overflow-hidden">
                  <span className="text-[12px] font-bold text-dp2-primary"><HandHeart size={12} className="inline me-1" />{t('home.volunteers', 'Volunteers')}</span>
                  {props.volunteers.length === 0 ? (
                    <span className="text-[10.5px] text-slate-400">{t('home.noVolunteers', 'No volunteers yet.')}</span>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {props.volunteers.map((v) => (
                        <div key={v.id} className="text-[11.5px]">
                          <div className="truncate text-slate-700 font-medium">{v.full_name}</div>
                          <div className="truncate text-[10.5px] text-dp2-primary-dark">{v.projectTitle}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <Link href="/volunteer" className="mt-auto rounded-xl py-1.5 bg-dp2-primary-dark text-white text-[11px] font-bold text-center">{t('home.joinVolunteer', 'Join as Volunteer')}</Link>
                </Card2>
              </div>
            </section>
          )}

          {/* Achievements */}
          {site.donorsEnabled && (
            <section className="flex flex-col gap-2">
              <div className="px-0.5 flex items-center justify-between">
                <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-dp2-primary"><Trophy size={13} className="inline me-1" />{t('home.achievements', 'Our Achievements')}</h2>
                <Link href="/achievements" className="text-[11px] font-semibold text-dp2-primary-dark">{t('home.viewAll', 'View All')}</Link>
              </div>
              <Card2 className="divide-y divide-slate-100 overflow-hidden">
                {props.achievements.length === 0 ? (
                  <div className="p-6 text-center text-[13px] text-slate-400">{t('home.nothingCompleted', 'Nothing completed yet.')}</div>
                ) : props.achievements.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 px-3 py-2.5">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                      {a.is_private ? <Lock size={11} /> : <span className="text-[12px] font-extrabold">✓</span>}
                    </span>
                    <span dir={a.is_private ? undefined : 'rtl'} className="text-[12.5px] text-slate-800">
                      {a.is_private ? `${t('home.privateTask', 'A private task was completed by')} ${a.done_by_name ?? 'a committee member'}` : a.text_ur}
                    </span>
                  </div>
                ))}
              </Card2>
            </section>
          )}

          {/* Committee note + Donate Now -- its own Cash Position card
              removed (real duplicate of the Fund Status panel above,
              same figures, just restyled). Same row on desktop, stacked
              on mobile (the grid's own default, lg:grid-cols-2 only
              kicking in above that breakpoint). */}
          <section className="grid lg:grid-cols-2 gap-3.5">
            <CommitteeNoteCard latest={props.latestCommitteeNote} archive={props.committeeNotesArchive} />
            {site.donorsEnabled && <HomeDonateCard account={props.paymentAccount} />}
          </section>

          <DownloadAppBanner />
          <Footer2 />
        </div>
      </main>

      <BottomNav2 onOpenMore={() => setDrawerOpen(true)} />
      <DrawerNav2 open={drawerOpen} onClose={() => setDrawerOpen(false)} isPortalUser={false} isStaffUser={false} />

      {sheet === 'bill' && <BillSheet onClose={() => setSheet(null)} />}
      {sheet === 'emergency' && <EmergencySheet onClose={() => setSheet(null)} site={site} />}
      {sheet === 'chanda' && <ChandaSheet onClose={() => setSheet(null)} />}
      {sheet === 'contacts' && <ContactsSheet onClose={() => setSheet(null)} />}
      {sheet === 'complaint' && <ComplaintSheet onClose={() => setSheet(null)} />}
      {sheet === 'zakat' && <ZakatSheet onClose={() => setSheet(null)} />}
      {sheet === 'kafalat' && <KafalatSheet onClose={() => setSheet(null)} kafalat={props.kafalat} />}
      {sheet === 'blood' && <BloodSheet onClose={() => setSheet(null)} bloodGroups={props.bloodGroups} />}
      {sheet === 'committee' && <CommitteeSheet onClose={() => setSheet(null)} site={site} />}
    </div>
  )
}

function BillSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLocale()
  const [ref, setRef] = useState('')
  const [checked, setChecked] = useState(false)
  return (
    <BottomSheet2 title={t('v.checkBill', 'Check Water Bill')} onClose={onClose}>
      <label className="block text-[12px] font-semibold text-slate-600 mb-1">{t('v.connectionNo', 'Connection Number')}</label>
      <input dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="DP-0214" className="w-full border border-slate-200 rounded-xl px-3 py-2 text-[14px] outline-none" />
      <button onClick={() => ref.trim() && setChecked(true)} className="w-full mt-2 rounded-xl py-2.5 bg-dp2-primary-dark text-white text-[14px] font-bold cursor-pointer">{t('v.checkBill', 'Check Bill')}</button>
      {checked && (
        <Link href={`/water?ref=${encodeURIComponent(ref)}`} className="block mt-3 rounded-xl bg-emerald-50 p-3 text-[13px] font-bold text-dp2-primary">{t('v.openFullBillPage', 'Open your full bill on the Water Bill page')} →</Link>
      )}
    </BottomSheet2>
  )
}

function EmergencySheet({ onClose, site }: { onClose: () => void; site: ReturnType<typeof useSite> }) {
  const { t } = useLocale()
  return (
    <BottomSheet2 title={t('em.pageTitle', 'Emergency Helplines')} titleColor="#dc2626" onClose={onClose}>
      <div className="flex flex-col gap-2 text-[14px]">
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
  const { t, isUrdu } = useLocale()
  const ub = (en: string, ur: string) => (isUrdu ? ur : en)
  return (
    <BottomSheet2 title={t('ch.pageTitle', 'Give Chanda')} onClose={onClose}>
      <p className="text-[13px] text-slate-600 mb-3">{ub('Donate towards the general fund or any specific project, with your payment receipt.', 'جنرل فنڈ یا کسی مخصوص منصوبے کے لیے، رسید کے ساتھ عطیہ کریں۔')}</p>
      <Link href="/donate" onClick={onClose} className="block w-full rounded-xl py-2.5 bg-dp2-primary-dark text-white text-[14px] font-bold text-center">{ub('Continue to Donate', 'عطیہ کی طرف جائیں')}</Link>
    </BottomSheet2>
  )
}

function ContactsSheet({ onClose }: { onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const ub = (en: string, ur: string) => (isUrdu ? ur : en)
  return (
    <BottomSheet2 title={t('ic.pageTitle', 'Important Contacts')} onClose={onClose}>
      <p className="text-[13px] text-slate-600 mb-3">{ub('Doctors, shops, tradesmen and services the village actually uses — numbers kept current by the committee.', 'ڈاکٹر، دکاندار، کاریگر اور خدمات کے نمبر — کمیٹی کی جانب سے تازہ رکھے جاتے ہیں۔')}</p>
      <Link href="/contacts" onClick={onClose} className="block w-full rounded-xl py-2.5 bg-dp2-primary-dark text-white text-[14px] font-bold text-center">{ub('Open Full Directory', 'مکمل فہرست دیکھیں')}</Link>
    </BottomSheet2>
  )
}

function ComplaintSheet({ onClose }: { onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const ub = (en: string, ur: string) => (isUrdu ? ur : en)
  return (
    <BottomSheet2 title={t('cr.pageTitle', 'Village Problems')} titleColor="#0284c7" onClose={onClose}>
      <p className="text-[13px] text-slate-600 mb-3">{ub('Report a broken streetlight, a road issue, a water leak — anything the committee should know about, with a photo if you have one.', 'ٹوٹی سٹریٹ لائٹ، سڑک کا مسئلہ، پانی کا رساؤ — جو بھی کمیٹی کو معلوم ہونا چاہیے، تصویر کے ساتھ بتائیں۔')}</p>
      <Link href="/civic-reports" onClick={onClose} className="block w-full rounded-xl py-2.5 bg-sky-600 text-white text-[14px] font-bold text-center">{ub('Report a Problem', 'مسئلہ درج کریں')}</Link>
    </BottomSheet2>
  )
}

function ZakatSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLocale()
  return (
    <BottomSheet2 title={t('zc.title', 'Zakat & Ushr Calculator')} onClose={onClose}>
      <ZakatCalculator compact />
    </BottomSheet2>
  )
}

function KafalatSheet({ onClose, kafalat }: { onClose: () => void; kafalat: Record<string, number> }) {
  const { t, isUrdu } = useLocale()
  const ub = (en: string, ur: string) => (isUrdu ? ur : en)
  return (
    <BottomSheet2 title={ub('Kafalat — School Sponsorship', 'کفالت — سکول کی کفالت')} onClose={onClose}>
      <p className="text-[13px] text-slate-600 mb-3">{ub('Carry one child’s schoolbag. One year of fees; a lifetime of difference.', 'ایک بچے کا بستہ اٹھائیے — ایک سال کی فیس، ایک عمر کا فرق۔')}</p>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-xl bg-blue-50 px-2.5 py-2"><div className="font-extrabold text-[16px] text-dp2-primary">{kafalat.in_school ?? 0}</div><div className="text-[11px] text-slate-500">{ub('children in school', 'سکول میں بچے')}</div></div>
        <div className="rounded-xl bg-amber-50 px-2.5 py-2"><div className="font-extrabold text-[16px] text-dp2-primary">{kafalat.waiting_sponsor ?? 0}</div><div className="text-[11px] text-slate-500">{ub('waiting for a sponsor', 'کفیل کے منتظر')}</div></div>
      </div>
      <Link href="/portal/kafalat" onClick={onClose} className="block w-full rounded-xl py-2.5 bg-dp2-primary-dark text-white text-[14px] font-bold text-center">{ub('Sponsor a Child', 'ایک بچے کی کفالت کریں')}</Link>
    </BottomSheet2>
  )
}

function BloodSheet({ onClose, bloodGroups }: { onClose: () => void; bloodGroups: { blood_group: string; registered: number; available_now: number }[] }) {
  const { t } = useLocale()
  return (
    <BottomSheet2 title={t('home.bloodRegistry', 'Blood Donor Registry')} titleColor="#dc2626" onClose={onClose}>
      {bloodGroups.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5 mb-3">
          {bloodGroups.map((g) => (
            <div key={g.blood_group} className="rounded-xl bg-red-50 py-1.5 text-center">
              <div dir="ltr" className="font-extrabold text-[14px] text-red-700">{g.blood_group}</div>
              <div className="text-[10.5px] text-slate-500">{g.available_now} {t('home.ready', 'ready')}</div>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Link href="/blood" onClick={onClose} className="rounded-xl py-2.5 bg-red-600 text-white text-[13px] font-bold text-center">{t('home.requestBlood', 'Request Blood')}</Link>
        <Link href="/portal/blood-donor" onClick={onClose} className="rounded-xl py-2.5 border border-slate-200 text-[13px] font-bold text-center">{t('home.registerBloodDonor', 'Register as Donor')}</Link>
      </div>
    </BottomSheet2>
  )
}

function CommitteeSheet({ onClose, site }: { onClose: () => void; site: ReturnType<typeof useSite> }) {
  const { isUrdu } = useLocale()
  const ub = (en: string, ur: string) => (isUrdu ? ur : en)
  return (
    <BottomSheet2 title={ub('The Committee', 'کمیٹی')} onClose={onClose}>
      <h4 className="font-bold text-[15px] text-dp2-primary mb-1">{isUrdu ? site.fullNameUrdu : site.fullName}</h4>
      {(site.location || site.officeHours) && (
        <div className="text-[13px] text-slate-600 mb-3 flex flex-col gap-0.5">
          {site.location && <span>📍 {site.location}</span>}
          {site.officeHours && <span dir="ltr">🕘 {site.officeHours}</span>}
        </div>
      )}
      <Link href="/about" onClick={onClose} className="block w-full rounded-xl py-2.5 bg-dp2-primary-dark text-white text-[14px] font-bold text-center">{ub('About the Committee', 'کمیٹی کے بارے میں')}</Link>
    </BottomSheet2>
  )
}
