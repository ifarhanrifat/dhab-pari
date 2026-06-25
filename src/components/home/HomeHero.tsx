import Link from 'next/link'
import { SITE } from '@/lib/constants'

export function HomeHero() {
  return (
    <section className="bg-dp-primary-container relative overflow-hidden">
      {/* Desktop Hero */}
      <div className="hidden md:block pt-16 pb-32">
        <div className="max-w-[1200px] mx-auto px-6 relative z-10 text-center">
          <h1 className="font-heading text-[80px] lg:text-[96px] font-bold text-white mb-4 drop-shadow-xl leading-tight">
            Dhab Pari
          </h1>
          <p
            className="text-dp-on-primary-container text-[28px] mb-8 leading-relaxed"
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
        <div className="relative h-64 overflow-hidden flex flex-col justify-end p-6 mx-4 mt-6 rounded-lg border border-dp-outline-variant">
          <div className="absolute inset-0 z-0 bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent z-[1]" />
          <div className="relative z-10 text-white">
            <h2 className="font-heading text-[24px] font-bold leading-tight mb-2">
              Building a Sustainable Village Together
            </h2>
            <p className="text-[16px] font-sans text-white/90 leading-[24px]">
              Official portal for the Water & Welfare Committee of Dhab Pari village.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
