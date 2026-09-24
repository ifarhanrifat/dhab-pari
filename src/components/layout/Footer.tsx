'use client'

import Link from 'next/link'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function Footer() {
  const { t, isUrdu } = useLocale()
  // Real report with screenshots, 2026-09-24: two screenshots of this same
  // page (one in English, one in Urdu) showed an identical English footer
  // in both -- it never actually followed the language toggle at all. Only
  // 5 of its strings ever went through t(); the brand blurb, all four Quick
  // Links labels, "Main Market", and the copyright line were plain hardcoded
  // English. Quick Links now reuses the same keys the header nav already
  // uses for Committee/Projects/News, instead of a second, drifting copy.
  const quickLinks = [
    { href: '/about', label: t('x.villageHistory') },
    { href: '/projects', label: t('site.projects') },
    { href: '/about', label: t('site.committee') },
    { href: '/news', label: t('site.news') },
  ]
  return (
    <footer className="bg-dp-surface-container-highest w-full py-12 px-6 md:px-12 border-t border-dp-outline-variant" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="col-span-1 md:col-span-2">
            <div className="font-heading text-[20px] font-bold leading-[28px] text-dp-primary mb-4">
              {isUrdu ? SITE.fullNameUrdu : SITE.fullName}
            </div>
            <p className="font-sans text-[16px] leading-[24px] text-dp-on-surface-variant max-w-md">
              {t('y.footerBlurb').replaceAll('{name}', isUrdu ? SITE.nameUrdu : SITE.name)}
            </p>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="font-sans font-bold text-dp-on-surface mb-4 text-[16px]">
              {t('y.quickLinks')}
            </h4>
            <ul className="space-y-2">
              {quickLinks.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-dp-on-surface-variant hover:text-dp-primary transition-all text-[14px] font-sans font-semibold tracking-[0.05em]"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact / Office */}
          <div>
            <h4 className="font-sans font-bold text-dp-on-surface mb-4 text-[16px]">
              {t('y.office')}
            </h4>
            <p className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant leading-relaxed">
              {t('y.mainMarket')}, {isUrdu ? SITE.nameUrdu : SITE.name}
              <br />
              {t('y.district')}
              <br />
              {t('y.pakistan')}
            </p>
            {/* dir="ltr" only, not .ltr-num -- that class also swaps in the
                monospace font, meant for phone numbers/amounts, which reads
                oddly on "Mon-Sat: 9AM-2PM" (real words, not a numeric code).
                No Urdu translation exists for this env-configured string
                (SITE.officeHours), so it stays English either way -- this
                just keeps it reading left-to-right inside an RTL row. */}
            <p className="text-[14px] font-sans text-dp-on-surface-variant mt-3" dir="ltr">
              {SITE.officeHours}
            </p>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="pt-8 border-t border-dp-outline-variant flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant text-center md:text-start">
            © {new Date().getFullYear()} {isUrdu ? SITE.fullNameUrdu : SITE.fullName}.{' '}
            {t('y.allRightsReserved')}
          </p>
          <div className="flex gap-6 text-[14px] font-sans text-dp-on-surface-variant">
            <Link href="/privacy" className="hover:text-dp-primary transition-all">
              {t('y.privacyPolicy')}
            </Link>
            <Link href="/terms" className="hover:text-dp-primary transition-all">
              {t('y.termsService')}
            </Link>
            {/* Deliberately understated — this is for the handful of committee
                staff, not villagers — but it has to exist somewhere on the
                public site, because nothing linked to /admin at all. */}
            <Link href="/admin" className="hover:text-dp-primary transition-all">
              {t('y.staffLogIn')}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
