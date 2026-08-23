'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Vote, Sparkles, ListChecks, Lock, Zap } from 'lucide-react'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { DonorBadge } from '@/components/public/DonorBadge'
import { canFastTrack, type DonorBadgeTier } from '@/lib/donorBadges'

const CATEGORIES = ['infrastructure', 'water', 'health', 'education', 'environment', 'welfare', 'sports', 'other']

interface ChatTurn { role: 'user' | 'model'; text: string }
type Lang = 'en' | 'ur'

// Same site-wide "Accounts Display Language" toggle /water/apply already
// respects (fetched from site_settings.display_language) — a public/portal
// visitor picks one language for the page, not both at once.
const t: Record<string, { en: string; ur: string }> = {
  heading: { en: 'Propose a Project', ur: 'منصوبہ تجویز کریں' },
  subtitle: { en: "Have an idea for the village? Propose it here — once your commitment is confirmed and enough members vote for it, the committee reviews and can launch it.", ur: 'گاؤں کے لیے کوئی خیال ہے؟ یہاں تجویز کریں — آپ کا وعدہ تصدیق ہونے اور کافی ووٹ ملنے کے بعد کمیٹی جائزہ لے کر اسے شروع کر سکتی ہے۔' },
  badgeRequiredTitle: { en: 'Proposing needs a donor badge first', ur: 'تجویز دینے کے لیے پہلے عطیہ دہندہ بیج درکار ہے' },
  badgeRequiredBody: { en: 'Proposing a project is open to donors who have reached at least the Chashma (Spring) badge — real, confirmed giving. Make a donation to start earning yours, then come back here.', ur: 'منصوبہ تجویز کرنا اُن عطیہ دہندگان کے لیے کھلا ہے جو کم از کم چشمہ بیج تک پہنچ چکے ہیں — حقیقی، تصدیق شدہ عطیات۔ اپنا پہلا بیج کمانے کے لیے عطیہ دیں، پھر یہاں واپس آئیں۔' },
  badgeRequiredCta: { en: 'Go to My Giving', ur: 'میرے عطیات پر جائیں' },
  fastTrackNote: { en: '⚡ Your badge fast-tracks this proposal — once your self-commitment is confirmed, it skips community voting and goes straight to the committee for review.', ur: '⚡ آپ کا بیج اس تجویز کو فاسٹ ٹریک کرتا ہے — آپ کا وعدہ تصدیق ہوتے ہی یہ کمیونٹی ووٹنگ کو چھوڑ کر براہ راست کمیٹی کے جائزے کے لیے جائے گی۔' },
  conditionsTitle: { en: 'Conditions to get your project approved & voted', ur: 'اپنے منصوبے کی منظوری اور ووٹ حاصل کرنے کی شرائط' },
  cond1: { en: 'Keep the total cost under Rs. 500,000 for the best chance of approval — projects under Rs. 200,000 are the most favored by the community and the committee. Votes needed scale with cost (50 votes per Rs. 100,000, minimum 50).', ur: 'منظوری کے بہترین امکان کے لیے کل لاگت روپے 500,000 سے کم رکھیں — روپے 200,000 سے کم منصوبے کمیونٹی اور کمیٹی کو سب سے زیادہ پسند ہیں۔ درکار ووٹ لاگت کے مطابق بڑھتے ہیں (ہر روپے 100,000 پر 50 ووٹ، کم از کم 50)۔' },
  cond2: { en: 'You must back your own proposal with a self-commitment — a minimum percentage of your requested budget (at least Rs. 10,000), shown live below as you type your budget. Pay it once, or commit to it monthly.', ur: 'آپ کو اپنی تجویز کی حمایت اپنے وعدے سے کرنی ہوگی — آپ کے مطلوبہ بجٹ کا کم از کم فیصد (کم از کم روپے 10,000)، جو نیچے بجٹ لکھتے ہی خودکار دکھایا جائے گا۔ یہ ایک بار ادا کریں یا ماہانہ وعدہ کریں۔' },
  cond3: { en: 'Your proposal is posted immediately as "Announced" — paused, and NOT open for voting yet. It stays paused with a "Waiting for the announced payment confirmation" label until you pay your commitment and staff confirms it.', ur: 'آپ کی تجویز فوری طور پر "اعلان شدہ" کے طور پر پوسٹ ہو جاتی ہے — رکی ہوئی، اور ابھی ووٹنگ کے لیے کھلی نہیں۔ یہ "اعلان شدہ ادائیگی کی تصدیق کا انتظار" کے لیبل کے ساتھ رکی رہتی ہے جب تک آپ اپنا وعدہ ادا نہ کریں اور عملہ اس کی تصدیق نہ کر دے۔' },
  cond4: { en: 'Once confirmed, your proposal opens for voting and you can share its card on social media / WhatsApp groups to gather votes.', ur: 'تصدیق کے بعد، آپ کی تجویز ووٹنگ کے لیے کھل جاتی ہے اور آپ ووٹ جمع کرنے کے لیے اس کا کارڈ سوشل میڈیا / واٹس ایپ گروپس پر شیئر کر سکتے ہیں۔' },
  cond5: { en: 'You can have only one undecided proposal (Announced or Upcoming) at a time.', ur: 'آپ کی ایک وقت میں صرف ایک زیرِ فیصلہ تجویز (اعلان شدہ یا آئندہ) ہو سکتی ہے۔' },
  cond6: { en: 'The community can keep donating to your project until it is marked completed. Once its confirmed funding is complete, its status changes to "Committee Reviewing" — the committee finalizes the budget from there.', ur: 'کمیونٹی آپ کے منصوبے کو مکمل قرار دیے جانے تک عطیہ دیتی رہ سکتی ہے۔ تصدیق شدہ فنڈنگ مکمل ہونے پر اس کی حیثیت "کمیٹی جائزہ لے رہی ہے" میں بدل جاتی ہے — وہاں سے کمیٹی حتمی بجٹ طے کرتی ہے۔' },
  titleLabel: { en: 'Project Title', ur: 'منصوبے کا عنوان' },
  descLabel: { en: 'Description', ur: 'تفصیل' },
  descGuide: { en: 'Before you post, consider covering: exactly what will be built/done and where; how many households or people it helps; why it’s needed now; what materials/approach you have in mind; any ongoing cost after completion (maintenance); and anything that could affect cost (site conditions, access, etc). A detailed, specific description gets more votes and a faster committee decision.', ur: 'پوسٹ کرنے سے پہلے ان باتوں کا خیال رکھیں: بالکل کیا اور کہاں بنایا/کیا جائے گا؛ کتنے گھرانوں یا افراد کو فائدہ ہوگا؛ ابھی اس کی ضرورت کیوں ہے؛ کن مواد/طریقہ کار کا ارادہ ہے؛ تکمیل کے بعد کوئی جاری لاگت (دیکھ بھال)؛ اور کوئی بھی چیز جو لاگت پر اثر ڈال سکتی ہے۔ تفصیلی اور واضح تفصیل زیادہ ووٹ اور تیز کمیٹی فیصلہ لاتی ہے۔' },
  categoryLabel: { en: 'Category', ur: 'قسم' },
  locationLabel: { en: 'Location / Sector', ur: 'مقام / سیکٹر' },
  imageLabel: { en: 'Project Photo (optional)', ur: 'منصوبے کی تصویر (اختیاری)' },
  imageGuide: { en: 'A real, relevant photo makes your project stand out and looks far better when shared on WhatsApp/Facebook. Shown on the project card and in the shared link preview.', ur: 'ایک حقیقی، متعلقہ تصویر آپ کے منصوبے کو نمایاں کرتی ہے اور واٹس ایپ/فیس بک پر شیئر کرتے وقت بہتر نظر آتی ہے۔ یہ پراجیکٹ کارڈ اور شیئر کردہ لنک پریویو میں دکھائی جاتی ہے۔' },
  aiToggle: { en: 'Let AI estimate the cost in Pakistani Rupees', ur: 'اے آئی کو پاکستانی روپے میں لاگت کا تخمینہ لگانے دیں' },
  aiGuide: { en: 'First calculates cost with modern/quality equipment, then (2nd click) the cheapest realistic way. This is a rough estimate only — not a real quote — to help you set a sensible budget.', ur: 'پہلے جدید/معیاری سامان کے ساتھ لاگت کا حساب لگاتا ہے، پھر (دوسری بار کلک پر) سب سے سستا حقیقت پسندانہ طریقہ۔ یہ صرف ایک اندازہ ہے — حقیقی قیمت نہیں — تاکہ آپ مناسب بجٹ طے کر سکیں۔' },
  budgetLabel: { en: 'Requested Budget (PKR)', ur: 'مطلوبہ بجٹ (روپے)' },
  votesNeeded: { en: 'Votes needed at this budget:', ur: 'اس بجٹ پر درکار ووٹ:' },
  autoCalc: { en: '(auto-calculated, 50 votes per Rs. 100,000)', ur: '(خودکار حساب، ہر روپے 100,000 پر 50 ووٹ)' },
  commitmentTitle: { en: 'Your Self-Commitment', ur: 'آپ کا ذاتی وعدہ' },
  commitmentGuide: { en: 'This is your own money backing the proposal — required before it can even be posted for voting.', ur: 'یہ آپ کی اپنی رقم ہے جو تجویز کی حمایت کرتی ہے — ووٹنگ کے لیے پوسٹ ہونے سے پہلے لازمی ہے۔' },
  requiredNow: { en: 'Required self-commitment at this budget:', ur: 'اس بجٹ پر درکار ذاتی وعدہ:' },
  oneTime: { en: 'Pay Once', ur: 'ایک بار ادائیگی' },
  monthly: { en: 'Commit Monthly', ur: 'ماہانہ وعدہ' },
  oneTimeAmountLabel: { en: 'One-Time Amount (PKR)', ur: 'یک وقتی رقم (روپے)' },
  monthlyAmountLabel: { en: 'Monthly Amount (PKR)', ur: 'ماہانہ رقم (روپے)' },
  monthlyNote: { en: 'A monthly commitment must total at least the required amount over 6 months.', ur: 'ماہانہ وعدہ 6 ماہ میں کم از کم مطلوبہ رقم کے برابر ہونا چاہیے۔' },
  recurringToggle: { en: 'This project will need ongoing monthly support after completion (e.g. a teacher’s or staff salary)', ur: 'اس منصوبے کو تکمیل کے بعد جاری ماہانہ مدد درکار ہوگی (مثلاً استاد یا عملے کی تنخواہ)' },
  monthlyCostLabel: { en: 'Estimated Monthly Operating Cost (PKR)', ur: 'تخمینی ماہانہ آپریٹنگ لاگت (روپے)' },
  monthlyCostGuide: { en: 'Kept separate from the one-time budget above — donors can sponsor this ongoing cost monthly once the project launches.', ur: 'اوپر دی گئی یک وقتی بجٹ سے الگ — منصوبہ شروع ہونے کے بعد عطیہ دہندگان اس جاری لاگت کو ماہانہ سپانسر کر سکتے ہیں۔' },
  submit: { en: 'Submit Proposal', ur: 'تجویز جمع کرائیں' },
  submitting: { en: 'Submitting...', ur: 'جمع ہو رہا ہے...' },
  confirmTitle: { en: 'Confirm Your Proposal', ur: 'اپنی تجویز کی تصدیق کریں' },
  confirmBody: { en: 'You are posting a project with your commitment', ur: 'آپ اپنے وعدے کے ساتھ ایک منصوبہ پوسٹ کر رہے ہیں' },
  confirmBody2: { en: 'It will be labeled "Announced" but will NOT be open for voting until your payment is confirmed.', ur: 'اسے "اعلان شدہ" کا لیبل دیا جائے گا لیکن آپ کی ادائیگی کی تصدیق تک یہ ووٹنگ کے لیے کھلا نہیں ہوگا۔' },
  confirmCancel: { en: 'Cancel', ur: 'منسوخ کریں' },
  confirmProceed: { en: 'Confirm & Submit', ur: 'تصدیق کریں اور جمع کرائیں' },
  catInfrastructure: { en: 'Infrastructure', ur: 'بنیادی ڈھانچہ' },
  catWater: { en: 'Water', ur: 'پانی' },
  catHealth: { en: 'Health', ur: 'صحت' },
  catEducation: { en: 'Education', ur: 'تعلیم' },
  catEnvironment: { en: 'Environment', ur: 'ماحولیات' },
  catWelfare: { en: 'Welfare', ur: 'فلاح و بہبود' },
  catSports: { en: 'Sports', ur: 'کھیل' },
  catOther: { en: 'Other', ur: 'دیگر' },
  yourAnswer: { en: 'Your answer...', ur: 'آپ کا جواب...' },
  thinking: { en: 'Thinking...', ur: 'سوچ رہا ہے...' },
  generateModern: { en: 'Generate Estimate (Modern Equipment)', ur: 'تخمینہ بنائیں (جدید سامان)' },
  calculateCheapest: { en: 'Calculate Cheapest Option', ur: 'سستا ترین آپشن نکالیں' },
  modernEstimateLabel: { en: 'Modern Equipment Estimate: Rs.', ur: 'جدید سامان کا تخمینہ: روپے' },
  cheapestEstimateLabel: { en: 'Cheapest Option Estimate: Rs.', ur: 'سستا ترین آپشن کا تخمینہ: روپے' },
  fillTitleDescBudget: { en: 'Fill in the title, description, and requested budget', ur: 'عنوان، تفصیل اور مطلوبہ بجٹ درج کریں' },
  commitmentAtLeastOneTime: { en: 'Your self-commitment must be at least Rs.', ur: 'آپ کا ذاتی وعدہ کم از کم روپے ہونا چاہیے:' },
  commitmentAtLeastMonthly: { en: 'Your monthly self-commitment must be at least Rs. {amount} (6-month equivalent)', ur: 'آپ کا ماہانہ ذاتی وعدہ کم از کم روپے {amount} ہونا چاہیے (6 ماہ کے برابر)' },
  enterMonthlyOperatingCost: { en: 'Enter the estimated monthly operating cost, or uncheck ongoing monthly support', ur: 'تخمینی ماہانہ آپریٹنگ لاگت درج کریں، یا جاری ماہانہ مدد کا خانہ غیر منتخب کریں' },
  proposalAnnouncedToast: { en: 'Proposal announced — pay your self-commitment from your portal, then it opens for voting once confirmed.', ur: 'تجویز کا اعلان ہو گیا — اپنا ذاتی وعدہ اپنے پورٹل سے ادا کریں، تصدیق کے بعد یہ ووٹنگ کے لیے کھل جائے گی۔' },
  needsAtLeastOneTime: { en: 'Needs to be at least Rs.', ur: 'کم از کم روپے ہونا چاہیے:' },
  needsAtLeastMonthly: { en: 'Needs to be at least Rs. {amount}/month', ur: 'کم از کم روپے {amount}/ماہانہ ہونا چاہیے' },
  aiEstimationFailed: { en: 'AI estimation failed', ur: 'اے آئی تخمینہ ناکام ہو گیا' },
  aiNetworkError: { en: 'Network error contacting the AI estimator', ur: 'اے آئی تخمینہ کار سے رابطے میں نیٹ ورک کی خرابی' },
  fillTitleDescFirst: { en: 'Fill in the title and description first', ur: 'پہلے عنوان اور تفصیل درج کریں' },
}
const CATEGORY_KEY: Record<string, keyof typeof t> = {
  infrastructure: 'catInfrastructure', water: 'catWater', health: 'catHealth', education: 'catEducation',
  environment: 'catEnvironment', welfare: 'catWelfare', sports: 'catSports', other: 'catOther',
}

function voteTargetFor(budget: number) {
  if (!budget || budget <= 0) return 50
  return Math.max(50, Math.ceil(budget / 100000) * 50)
}

// Mirrors project_self_commitment_required_pkr() (migration 141) exactly —
// lower budgets pay a higher percentage of their own cost upfront, higher
// budgets a lower percentage, always at least Rs. 10,000. Kept in sync by
// hand (same duplication convention already used for voteTargetFor above,
// which mirrors trg_project_proposal_defaults' GREATEST/CEIL formula).
function selfCommitmentRequiredFor(budget: number) {
  const b = budget || 0
  const pct = b <= 150000 ? 0.08 : b <= 300000 ? 0.05 : 0.03
  return Math.max(10000, Math.round(b * pct))
}

// A proposal is a `projects` row with status='announced' — paused, not
// votable, until the proposer's own self-commitment is paid and confirmed
// (trg_project_proposal_commitment + confirm_donation, migration 141), at
// which point it flips to 'upcoming' and voting opens. Vote target and the
// self-commitment floor both auto-scale with budget (enforced again
// server-side by trg_project_proposal_defaults). Committee approval + real
// funded budget still happens later, via the existing admin Projects page.
export default function ProposeProjectPage() {
  const { t: tr } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const [lang, setLang] = useState<Lang>('en')
  const dt = (key: keyof typeof t) => t[key][lang]
  const isUrdu = lang === 'ur'

  // Badge-gated per migration 311: no badge at all blocks the form
  // entirely; River/Ocean/Wellspring fast-track past community voting.
  // undefined = still loading, null = no badge yet.
  const [tier, setTier] = useState<DonorBadgeTier | null | undefined>(undefined)
  useEffect(() => {
    if (!user) return
    createClient().rpc('donor_badge_tier', { p_portal_user_id: user.id }).then(({ data }) => setTier((data ?? null) as DonorBadgeTier | null))
  }, [user])

  const [form, setForm] = useState({
    title: '', description: '', category: 'welfare', location: '', image_url: '',
    budget_pkr: 0, self_commitment_type: 'one_time' as 'one_time' | 'monthly', self_commitment_amount_pkr: 0,
    needs_recurring_support: false, monthly_operating_cost_pkr: 0,
  })
  const [saving, setSaving] = useState(false)
  const [useAi, setUseAi] = useState(true)
  const [showConfirm, setShowConfirm] = useState(false)

  const [aiStage, setAiStage] = useState<0 | 1 | 2>(0)
  const [aiHistory, setAiHistory] = useState<ChatTurn[]>([])
  const [aiReply, setAiReply] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiWaitingForAnswer, setAiWaitingForAnswer] = useState(false)
  const [modernEstimate, setModernEstimate] = useState<number | null>(null)
  const [cheapestEstimate, setCheapestEstimate] = useState<number | null>(null)

  useEffect(() => {
    createClient().from('site_settings').select('value').eq('key', 'display_language').maybeSingle().then(({ data }) => {
      if (data?.value === 'ur') setLang('ur')
    })
  }, [])

  const runAiTurn = async (stage: 'modern' | 'cheapest', history: ChatTurn[]) => {
    setAiBusy(true)
    try {
      const res = await fetch('/api/portal/estimate-project-cost', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: form.title, description: form.description, category: form.category, stage, history }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? dt('aiEstimationFailed')); setAiBusy(false); return }
      const newHistory = [...history, { role: 'model' as const, text: data.text }]
      setAiHistory(newHistory)
      if (data.finalEstimate) {
        if (stage === 'modern') { setModernEstimate(data.finalEstimate); setAiStage(1) }
        else { setCheapestEstimate(data.finalEstimate); setAiStage(2) }
        setAiWaitingForAnswer(false)
      } else {
        setAiWaitingForAnswer(true)
      }
    } catch {
      toast.error(dt('aiNetworkError'))
    }
    setAiBusy(false)
  }

  const startModernEstimate = () => {
    if (!form.title.trim() || !form.description.trim()) { toast.error(dt('fillTitleDescFirst')); return }
    setAiHistory([])
    runAiTurn('modern', [])
  }
  const startCheapestEstimate = () => {
    setAiHistory([])
    runAiTurn('cheapest', [])
  }
  const sendAiReply = async () => {
    if (!aiReply.trim()) return
    const newHistory = [...aiHistory, { role: 'user' as const, text: aiReply.trim() }]
    setAiHistory(newHistory)
    setAiReply('')
    await runAiTurn(aiStage === 0 ? 'modern' : 'cheapest', newHistory)
  }

  const required = selfCommitmentRequiredFor(form.budget_pkr)
  const commitmentOk = form.self_commitment_type === 'one_time'
    ? form.self_commitment_amount_pkr >= required
    : form.self_commitment_amount_pkr * 6 >= required

  const openConfirm = () => {
    if (!user) return
    if (!form.title.trim() || !form.description.trim() || !form.budget_pkr) {
      toast.error(dt('fillTitleDescBudget'))
      return
    }
    if (!form.self_commitment_amount_pkr || !commitmentOk) {
      toast.error(
        form.self_commitment_type === 'one_time'
          ? `${dt('commitmentAtLeastOneTime')} ${required.toLocaleString()}`
          : dt('commitmentAtLeastMonthly').replace('{amount}', Math.ceil(required / 6).toLocaleString())
      )
      return
    }
    if (form.needs_recurring_support && !form.monthly_operating_cost_pkr) {
      toast.error(dt('enterMonthlyOperatingCost'))
      return
    }
    setShowConfirm(true)
  }

  const submit = async () => {
    if (!user) return
    setSaving(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('projects').insert({
      title: form.title.trim(), description: form.description.trim(), category: form.category,
      location: form.location.trim() || null, budget_pkr: form.budget_pkr, status: 'announced',
      proposal_image_url: form.image_url || null,
      proposed_by_portal_user_id: user.id,
      self_commitment_type: form.self_commitment_type, self_commitment_amount_pkr: form.self_commitment_amount_pkr,
      minimum_monthly_commitment_pkr: form.self_commitment_type === 'monthly' ? form.self_commitment_amount_pkr : null,
      funding_model: form.needs_recurring_support ? 'recurring_support' : 'one_time',
      monthly_operating_cost_pkr: form.needs_recurring_support ? form.monthly_operating_cost_pkr : null,
    }).select('id').single()
    setSaving(false)
    setShowConfirm(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(dt('proposalAnnouncedToast'))
    router.push(`/projects/${data.id}`)
  }

  if (userLoading || tier === undefined) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{tr('action.loading')}</div>

  if (tier === null) {
    return (
      <div className="max-w-lg" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <Lock size={28} className="text-dp-on-surface-variant mx-auto mb-3" />
          <h1 className="font-heading text-[20px] font-bold text-dp-primary mb-2">{dt('badgeRequiredTitle')}</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant leading-relaxed mb-5">{dt('badgeRequiredBody')}</p>
          <Link href="/portal/statement" className="inline-block px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all">
            {dt('badgeRequiredCta')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Vote size={22} className="text-dp-secondary" /> {dt('heading')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{dt('subtitle')}</p>
        <div className="mt-2 flex items-center gap-2">
          <DonorBadge tier={tier} isUrdu={isUrdu} />
        </div>
      </div>

      {canFastTrack(tier) && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3.5 mb-4 max-w-lg flex items-start gap-2.5" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
          <Zap size={16} className="text-indigo-700 shrink-0 mt-0.5" />
          <p className="font-sans text-[12.5px] text-indigo-900 leading-relaxed">{dt('fastTrackNote')}</p>
        </div>
      )}

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 max-w-lg" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
        <div className="flex gap-3 mb-2">
          <ListChecks size={18} className="text-amber-700 shrink-0 mt-0.5" />
          <strong className="font-sans text-[13.5px] text-amber-900">{dt('conditionsTitle')}</strong>
        </div>
        <ol className="list-decimal ps-9 space-y-1.5 font-sans text-[12.5px] text-amber-900 leading-[19px]">
          <li>{dt('cond1')}</li>
          <li>{dt('cond2')}</li>
          <li>{dt('cond3')}</li>
          <li>{dt('cond4')}</li>
          <li>{dt('cond5')}</li>
          <li>{dt('cond6')}</li>
        </ol>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-lg space-y-4">
        <div dir={isUrdu ? 'rtl' : 'ltr'}>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('titleLabel')} *</label>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="input-field" />
        </div>
        <div dir={isUrdu ? 'rtl' : 'ltr'}>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{dt('descLabel')} *</label>
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={4} className="input-field resize-none" />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5 leading-[17px]" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif', direction: 'rtl' } : undefined}>{dt('descGuide')}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('categoryLabel')}</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
              {CATEGORIES.map((c) => <option key={c} value={c}>{dt(CATEGORY_KEY[c])}</option>)}
            </select>
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('locationLabel')}</label>
            <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="input-field" />
          </div>
        </div>

        <div>
          <ImageUpload bucket="images" label={dt('imageLabel')} currentUrl={form.image_url} onUpload={(url) => setForm({ ...form, image_url: url })} />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5" style={isUrdu ? { fontFamily: 'var(--font-urdu), serif', direction: 'rtl' } : undefined}>{dt('imageGuide')}</p>
        </div>

        {/* AI cost estimate */}
        <div className="border border-dp-outline-variant rounded-lg p-4 bg-dp-surface-container-low/40">
          <label className="flex items-center gap-2 cursor-pointer mb-3">
            <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="accent-dp-secondary" />
            <span className="font-sans text-[13.5px] font-semibold flex items-center gap-1.5"><Sparkles size={14} className="text-dp-secondary" /> {dt('aiToggle')}</span>
          </label>
          {useAi && (
            <div className="space-y-3">
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{dt('aiGuide')}</p>
              {aiHistory.length > 0 && (
                <div className="space-y-2 max-h-56 overflow-y-auto bg-white border border-dp-outline-variant rounded-lg p-3">
                  {aiHistory.map((turn, i) => (
                    <p key={i} className={`font-sans text-[13px] ${turn.role === 'model' ? 'text-dp-on-surface' : 'text-dp-secondary font-semibold'}`}>
                      {turn.role === 'model' ? '🤖 ' : '🙂 '}{turn.text.replace(/FINAL_ESTIMATE:.*$/, '').trim()}
                    </p>
                  ))}
                </div>
              )}
              {aiWaitingForAnswer && aiStage < 2 && (
                <div className="flex gap-2">
                  <input value={aiReply} onChange={(e) => setAiReply(e.target.value)} placeholder={dt('yourAnswer')} className="input-field flex-1" />
                  <button onClick={sendAiReply} disabled={aiBusy} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{tr('p.send')}</button>
                </div>
              )}
              {modernEstimate && <p className="font-sans text-[13.5px] font-bold text-dp-secondary">{dt('modernEstimateLabel')} {modernEstimate.toLocaleString()}</p>}
              {cheapestEstimate && <p className="font-sans text-[13.5px] font-bold text-dp-primary">{dt('cheapestEstimateLabel')} {cheapestEstimate.toLocaleString()}</p>}
              <div className="flex gap-2">
                {aiStage === 0 && !aiWaitingForAnswer && (
                  <button onClick={startModernEstimate} disabled={aiBusy} className="px-4 py-2 border-2 border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-secondary hover:text-white transition-all disabled:opacity-50">
                    {aiBusy ? dt('thinking') : dt('generateModern')}
                  </button>
                )}
                {aiStage === 1 && !aiWaitingForAnswer && (
                  <button onClick={startCheapestEstimate} disabled={aiBusy} className="px-4 py-2 border-2 border-dp-primary text-dp-primary rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary hover:text-white transition-all disabled:opacity-50">
                    {aiBusy ? dt('thinking') : dt('calculateCheapest')}
                  </button>
                )}
                {aiStage === 2 && (
                  <p className="font-sans text-[12px] text-dp-on-surface-variant italic">{tr('p.aiEstimateDone')}</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('budgetLabel')} *</label>
          <input type="number" min={1} value={form.budget_pkr || ''} onChange={(e) => setForm({ ...form, budget_pkr: +e.target.value })} className="input-field" />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{dt('votesNeeded')} <strong>{voteTargetFor(form.budget_pkr)}</strong> {dt('autoCalc')}</p>
        </div>

        {/* Self-commitment — required before the proposal can even post for voting */}
        <div className="border border-dp-secondary/40 rounded-lg p-4 bg-dp-secondary/5 space-y-3">
          <p className="font-sans text-[13.5px] font-bold text-dp-primary">{dt('commitmentTitle')}</p>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{dt('commitmentGuide')}</p>
          <p className="font-sans text-[13px]">{dt('requiredNow')} <strong className="text-dp-secondary">Rs. {required.toLocaleString()}</strong></p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setForm({ ...form, self_commitment_type: 'one_time' })}
              className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer border-2 transition-all ${form.self_commitment_type === 'one_time' ? 'bg-dp-secondary text-white border-dp-secondary' : 'border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary'}`}>
              {dt('oneTime')}
            </button>
            <button type="button" onClick={() => setForm({ ...form, self_commitment_type: 'monthly' })}
              className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer border-2 transition-all ${form.self_commitment_type === 'monthly' ? 'bg-dp-secondary text-white border-dp-secondary' : 'border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary'}`}>
              {dt('monthly')}
            </button>
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
              {form.self_commitment_type === 'one_time' ? dt('oneTimeAmountLabel') : dt('monthlyAmountLabel')} *
            </label>
            <input type="number" min={1} value={form.self_commitment_amount_pkr || ''} onChange={(e) => setForm({ ...form, self_commitment_amount_pkr: +e.target.value })} className="input-field" />
            {form.self_commitment_type === 'monthly' && <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{dt('monthlyNote')}</p>}
            {form.self_commitment_amount_pkr > 0 && !commitmentOk && (
              <p className="font-sans text-[11.5px] text-red-600 mt-1">
                {form.self_commitment_type === 'one_time'
                  ? `${dt('needsAtLeastOneTime')} ${required.toLocaleString()}`
                  : dt('needsAtLeastMonthly').replace('{amount}', Math.ceil(required / 6).toLocaleString())}
              </p>
            )}
          </div>
        </div>

        {/* Recurring / ongoing operational support */}
        <div className="border border-dp-outline-variant rounded-lg p-4 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.needs_recurring_support} onChange={(e) => setForm({ ...form, needs_recurring_support: e.target.checked })} className="accent-dp-secondary" />
            <span className="font-sans text-[13px]">{dt('recurringToggle')}</span>
          </label>
          {form.needs_recurring_support && (
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{dt('monthlyCostLabel')} *</label>
              <input type="number" min={1} value={form.monthly_operating_cost_pkr || ''} onChange={(e) => setForm({ ...form, monthly_operating_cost_pkr: +e.target.value })} className="input-field" />
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{dt('monthlyCostGuide')}</p>
            </div>
          )}
        </div>

        <button onClick={openConfirm} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          {saving ? dt('submitting') : dt('submit')}
        </button>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowConfirm(false)}>
          <div className="bg-white rounded-lg p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()} dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
            <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">{dt('confirmTitle')}</h2>
            <p className="font-sans text-[13.5px] text-dp-on-surface mb-2">
              {dt('confirmBody')} <strong>Rs. {form.self_commitment_amount_pkr.toLocaleString()}</strong> ({form.self_commitment_type === 'one_time' ? dt('oneTime') : dt('monthly')}).
            </p>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{dt('confirmBody2')}</p>
            <div className="flex gap-2">
              <button onClick={() => setShowConfirm(false)} className="flex-1 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all">{dt('confirmCancel')}</button>
              <button onClick={submit} disabled={saving} className="flex-1 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                {saving ? dt('submitting') : dt('confirmProceed')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
