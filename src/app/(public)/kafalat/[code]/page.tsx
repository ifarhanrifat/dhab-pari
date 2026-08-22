import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'
import { GraduationCap, Users, CheckCircle2, Heart, ShieldCheck } from 'lucide-react'
import { ShareButtons } from '@/components/public/ShareButtons'

/**
 * The shareable card for one child — the page a WhatsApp/Facebook link
 * actually lands on. Built to be forwarded: one child, one number, one
 * button. No family name, no house, no school named outright — the same
 * privacy rule the portal card follows, because a page built to travel
 * further than the village needs it more, not less.
 */

interface NamingChild {
  id: string; code: string; first_name: string; first_name_ur: string | null
  current_class: string | null; is_orphan: boolean
  this_year_requirement: number; already_named: number
  photo_url: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

const CATEGORY_LABEL_UR: Record<string, string> = {
  school_fee: 'سکول فیس', uniform: 'یونیفارم', books: 'کتابیں و سٹیشنری',
  transport: 'آمد و رفت', pocket_money: 'جیب خرچ', medical: 'طبی',
  exam_fee: 'امتحانی فیس', tuition: 'ٹیوشن', other: 'دیگر',
}
const CATEGORY_LABEL_EN: Record<string, string> = {
  school_fee: 'School fee', uniform: 'Uniform', books: 'Books & stationery',
  transport: 'Transport', pocket_money: 'Pocket money', medical: 'Medical',
  exam_fee: 'Exam fee', tuition: 'Tuition', other: 'Other',
}

export default async function KafalatChildSharePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const supabase = await createClient()

  const { data: children } = await supabase.rpc('kafalat_children_for_naming')
  const child = ((children ?? []) as NamingChild[]).find((c) => c.code === code)
  if (!child) notFound()

  const [{ data: donorCount }, { data: breakdown }] = await Promise.all([
    supabase.rpc('kafalat_child_donor_count', { p_child_id: child.id }),
    supabase.rpc('kafalat_child_package_breakdown', { p_child_id: child.id }),
  ])

  const remaining = Math.max(child.this_year_requirement - child.already_named, 0)
  const pct = child.this_year_requirement > 0
    ? Math.min(100, Math.round((child.already_named / child.this_year_requirement) * 100)) : 0
  const isFull = child.this_year_requirement > 0 && child.already_named >= child.this_year_requirement
  const lines = (breakdown as { lines: { category: string; amount: number }[] } | null)?.lines ?? []
  const shareUrl = `https://${SITE.domain}/kafalat/${child.code}`

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <div className="bg-white border border-dp-outline-variant rounded-2xl overflow-hidden shadow-sm">
        <div className="bg-dp-primary px-6 py-8 text-center text-white">
          {child.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={child.photo_url} alt="" className="w-28 h-28 rounded-full object-cover mx-auto border-4 border-white/30" />
          ) : (
            <div className="w-28 h-28 rounded-full bg-white/15 flex items-center justify-center mx-auto font-heading text-[42px] font-bold border-4 border-white/30">
              {child.first_name.charAt(0)}
            </div>
          )}
          <h1 className="font-heading text-[26px] font-bold mt-4">{child.first_name}</h1>
          {child.first_name_ur && (
            <p className="text-[20px] mt-1 opacity-90" style={{ fontFamily: 'var(--font-urdu), serif' }}>{child.first_name_ur}</p>
          )}
          <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
            {child.is_orphan && <span className="px-2.5 py-1 rounded-full bg-sky-500/90 text-[11.5px] font-bold">یتیم · Orphan</span>}
            {child.current_class && <span className="px-2.5 py-1 rounded-full bg-white/15 text-[11.5px] font-bold">جماعت {child.current_class} · Class {child.current_class}</span>}
            {/* A percentage sign sitting next to Urdu text in one string
                reorders unpredictably under the browser's bidi algorithm —
                kept LTR/numeric-only here rather than risk it garbling,
                same reasoning as the OG image's English-only constraint. */}
            <span dir="ltr" className={`px-2.5 py-1 rounded-full text-[11.5px] font-bold ${isFull ? 'bg-emerald-500/90' : 'bg-amber-500/90'}`}>
              {isFull ? 'Fully Sponsored' : `${pct}% Sponsored`}
            </span>
          </div>
        </div>

        {/* ── The pitch, in Urdu first ──────────────────────────────────── */}
        <div className="px-6 py-6">
          <p className="text-[19px] leading-[2.1] text-dp-on-surface font-bold text-center"
            style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
            {isFull
              ? `${child.first_name_ur ?? child.first_name} کی اس سال کی تعلیمی ضرورت مکمل طور پر پوری ہو چکی ہے، الحمدللہ۔`
              : `${child.first_name_ur ?? child.first_name} کو اس سال تعلیم جاری رکھنے کے لیے آپ کی مدد کی ضرورت ہے۔ ایک ماہانہ حصہ، اپنے بچے کی طرح ساتھ دیں۔`}
          </p>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant text-center mt-2 leading-relaxed">
            {isFull
              ? `${child.first_name}'s education for this year is fully funded, Alhamdulillah — thank you to everyone who joined.`
              : `${child.first_name} needs help staying in school this year. Join with a monthly share, like your own child.`}
          </p>

          {/* ── Progress ────────────────────────────────────────────────── */}
          <div className="mt-6">
            <div className="h-3 w-full bg-dp-surface-container rounded-full overflow-hidden">
              <div className={`h-full ${isFull ? 'bg-emerald-500' : 'bg-dp-secondary'}`} style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4 text-center">
              <div>
                <p className="font-heading text-[20px] font-bold text-dp-primary">Rs {fmt(child.this_year_requirement)}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">سالانہ ضرورت · Annual need</p>
              </div>
              <div>
                <p className="font-heading text-[20px] font-bold text-dp-secondary">Rs {fmt(child.already_named)}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">موصول شدہ · Confirmed</p>
              </div>
              <div>
                <p className="font-heading text-[20px] font-bold text-dp-on-surface">Rs {fmt(remaining)}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">باقی · Remaining</p>
              </div>
            </div>
            <p className="flex items-center justify-center gap-1.5 font-sans text-[12.5px] text-dp-on-surface-variant mt-4">
              <Users size={14} /> {donorCount ?? 0} {(donorCount ?? 0) === 1 ? 'donor has' : 'donors have'} already joined · {donorCount ?? 0} عطیہ دہندگان شامل ہیں
            </p>
          </div>

          {/* ── What this covers ───────────────────────────────────────── */}
          {lines.length > 0 && (
            <div className="mt-6 bg-dp-surface-container-low rounded-lg p-4">
              <p className="font-sans text-[12px] font-bold text-dp-primary mb-2.5">یہ رقم کس چیز میں خرچ ہوتی ہے؟ · What this covers</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {lines.map((l, i) => (
                  <div key={i} className="flex items-center justify-between font-sans text-[12.5px]">
                    <span className="text-dp-on-surface-variant">{CATEGORY_LABEL_UR[l.category] ?? l.category} · {CATEGORY_LABEL_EN[l.category] ?? l.category}</span>
                    <span className="font-semibold text-dp-on-surface shrink-0 ms-2">Rs {fmt(l.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Call to action ──────────────────────────────────────────── */}
          <div className="mt-6 space-y-3">
            {isFull ? (
              <Link href="/portal/kafalat"
                className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3.5 rounded-lg font-sans text-[15px] font-bold hover:bg-emerald-700 transition-all">
                <CheckCircle2 size={18} /> دوسرے بچوں کی مدد کریں · Help another child
              </Link>
            ) : (
              <Link href="/portal/kafalat"
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3.5 rounded-lg font-sans text-[15px] font-bold hover:bg-dp-primary transition-all">
                <Heart size={18} /> کفالت میں شامل ہوں · Join this sponsorship
              </Link>
            )}
            <ShareButtons url={shareUrl} text={`${child.first_name} کی تعلیم میں مدد کریں — ${SITE.fullName}`} />
          </div>

          <div className="flex items-start gap-2 mt-5 pt-5 border-t border-dp-outline-variant">
            <ShieldCheck size={16} className="text-dp-secondary shrink-0 mt-0.5" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant leading-relaxed">
              کوئی رقم خودکار طریقے سے نہیں کاٹی جاتی — آپ خود بھیجتے ہیں، اور کمیٹی تصدیق کرتی ہے۔ Nothing is charged automatically — you send it yourself, and the committee confirms it.
            </p>
          </div>
        </div>
      </div>

      <p className="flex items-center justify-center gap-1.5 font-sans text-[12px] text-dp-on-surface-variant mt-4">
        <GraduationCap size={13} /> {SITE.fullName} — Kafalat
      </p>
    </div>
  )
}
