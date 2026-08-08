import Link from 'next/link'
import { SITE } from '@/lib/constants'

export function Footer() {
  return (
    <footer className="bg-dp-surface-container-highest w-full py-12 px-6 md:px-12 border-t border-dp-outline-variant">
      <div className="max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="col-span-1 md:col-span-2">
            <div className="font-heading text-[20px] font-bold leading-[28px] text-dp-primary mb-4">
              Dhab Pari Water & Welfare Committee
            </div>
            <p className="font-sans text-[16px] leading-[24px] text-dp-on-surface-variant max-w-md">
              Dedicated to the prosperity and welfare of Dhab Pari village
              through transparent management, modern water systems, and
              communal support.
            </p>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="font-sans font-bold text-dp-on-surface mb-4 text-[16px]">
              Quick Links
            </h4>
            <ul className="space-y-2">
              {[
                { href: '/about', label: 'Village History' },
                { href: '/projects', label: 'Projects' },
                { href: '/about', label: 'Committee' },
                { href: '/news', label: 'News & Updates' },
              ].map((link) => (
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
              Office
            </h4>
            <p className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant leading-relaxed">
              Main Market, Dhab Pari
              <br />
              District Chakwal, Punjab
              <br />
              Pakistan
            </p>
            <p className="text-[14px] font-sans text-dp-on-surface-variant mt-3">
              {SITE.officeHours}
            </p>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="pt-8 border-t border-dp-outline-variant flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant text-center md:text-left">
            © {new Date().getFullYear()} Dhab Pari Water & Welfare Committee.
            All rights reserved.
          </p>
          <div className="flex gap-6 text-[14px] font-sans text-dp-on-surface-variant">
            <Link href="/privacy" className="hover:text-dp-primary transition-all">
              Privacy Policy
            </Link>
            <Link href="/terms" className="hover:text-dp-primary transition-all">
              Terms of Service
            </Link>
            {/* Deliberately understated — this is for the handful of committee
                staff, not villagers — but it has to exist somewhere on the
                public site, because nothing linked to /admin at all. */}
            <Link href="/admin" className="hover:text-dp-primary transition-all">
              Staff Log In
            </Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
