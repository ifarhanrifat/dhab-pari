import Link from 'next/link'
import { SITE } from '@/lib/constants'

// Was `motion`-animated (a JS animation library) for two one-shot fade-ins
// on the homepage's above-the-fold hero — the single heaviest page for a
// first-time/mobile visitor. `tw-animate-css` (already a dependency, used
// elsewhere in this app) gives the identical fade+slide-in as pure CSS
// classes, so the hero no longer needs to ship or run any animation JS at
// all. motion is still used as-is on Gallery/Projects (their interactivity
// is genuinely motion-driven, not just decorative), just not here.
export function HomeHero() {
  return (
    <section className="bg-dp-primary-container relative overflow-hidden">
      {/* Desktop Hero */}
      <div className="hidden md:block pt-16 pb-32">
        <div className="max-w-[1200px] mx-auto px-6 relative z-10 text-center">
          <div className="max-w-3xl mx-auto mb-10 animate-in fade-in slide-in-from-top-3 duration-700">
            <p dir="rtl" className="text-white text-[30px] lg:text-[36px] font-bold leading-[1.9]" style={{ fontFamily: 'var(--font-quran), serif' }}>
              ﴿وَيَسْأَلُونَكَ مَاذَا يُنفِقُونَ قُلِ الْعَفْوَ ۗ كَذَٰلِكَ يُبَيِّنُ اللَّهُ لَكُمُ الْآيَاتِ لَعَلَّكُمْ تَتَفَكَّرُونَ﴾
            </p>
            <p dir="rtl" className="text-dp-on-primary-container text-[18px] lg:text-[20px] mt-3 leading-[2]" style={{ fontFamily: 'var(--font-urdu), serif' }}>
              اور آپ سے پوچھتے ہیں کہ کیا خرچ کریں؟ کہہ دیجیے: جو ضرورت سے زائد ہو (عفو)۔ اللہ اسی طرح تمہارے لیے احکام کھول کر بیان کرتا ہے تاکہ تم غور و فکر کرو۔
            </p>
            <p dir="rtl" className="text-white/60 text-[13px] mt-2" style={{ fontFamily: 'var(--font-urdu), serif' }}>
              (سورۃ البقرہ، آیت 219)
            </p>
          </div>
          <h1
            dir="rtl"
            className="font-bold text-white drop-shadow-xl leading-tight text-[32px] lg:text-[38px] animate-in fade-in slide-in-from-top-3 duration-700 [animation-delay:200ms] [animation-fill-mode:both]"
            style={{ fontFamily: 'var(--font-urdu), serif' }}
          >
            {SITE.committeeUrdu}
          </h1>
          <p className="font-heading text-[26px] lg:text-[30px] font-semibold text-dp-on-primary-container mb-6 mt-1 tracking-wide">
            {SITE.name}
          </p>
          <p
            className="text-dp-on-primary-container text-[22px] mb-8 leading-relaxed"
            style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
          >
            {SITE.taglineUrdu}
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              href="/water"
              className="px-8 py-3 bg-dp-secondary-fixed text-dp-on-secondary-fixed rounded-lg font-bold font-sans shadow-lg hover:brightness-110 transition-all"
            >
              Pay Water Bill
            </Link>
            <Link
              href="/about"
              className="px-8 py-3 border-2 border-dp-secondary-fixed text-dp-secondary-fixed rounded-lg font-bold font-sans hover:bg-dp-secondary-fixed/10 transition-all"
            >
              Join Committee
            </Link>
          </div>
        </div>
      </div>

      {/* Mobile Hero */}
      <div className="md:hidden">
        <div className="px-6 pt-8 pb-2 text-center">
          <p dir="rtl" className="text-white text-[22px] font-bold leading-[1.9]" style={{ fontFamily: 'var(--font-quran), serif' }}>
            ﴿وَيَسْأَلُونَكَ مَاذَا يُنفِقُونَ قُلِ الْعَفْوَ ۗ كَذَٰلِكَ يُبَيِّنُ اللَّهُ لَكُمُ الْآيَاتِ لَعَلَّكُمْ تَتَفَكَّرُونَ﴾
          </p>
          <p dir="rtl" className="text-dp-on-primary-container text-[14px] mt-2.5 leading-[2]" style={{ fontFamily: 'var(--font-urdu), serif' }}>
            اور آپ سے پوچھتے ہیں کہ کیا خرچ کریں؟ کہہ دیجیے: جو ضرورت سے زائد ہو (عفو)۔ اللہ اسی طرح تمہارے لیے احکام کھول کر بیان کرتا ہے تاکہ تم غور و فکر کرو۔
          </p>
        </div>
        {/* min-h, not a fixed h-64 with overflow-hidden: the heading wraps to
            three lines on a narrow phone, which pushed the paragraph out of
            the clipped box entirely. mb-6 keeps it off the stat cards below,
            which it was previously butting straight into. */}
        <div className="relative min-h-64 overflow-hidden flex flex-col justify-end p-6 mx-4 mt-6 mb-6 rounded-lg border border-dp-outline-variant">
          <div className="absolute inset-0 z-0 bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent z-[1]" />
          <div className="relative z-10 text-white">
            <h2 className="font-heading text-[24px] font-bold leading-tight mb-2">
              Building a Sustainable Village Together
            </h2>
            <p className="text-[16px] font-sans text-white/90 leading-[24px]">
              Official portal for the {SITE.committee} of {SITE.name} village.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
