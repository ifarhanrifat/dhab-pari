'use client'

import { useEffect, useState } from 'react'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'
import { SITE } from '@/lib/constants'

interface Props { title: string; subtitle?: string; className?: string; lang?: 'en' | 'ur' }

// Shared header for printed/on-screen documents (reports, registers, statements) —
// logo sits independently in the top-left corner (absolute, sized/nudged from
// Settings) so it never drags the heading off-center. Company name (English/Urdu)
// comes from the same fetchBrandingSettings() source bills and receipts already
// use, instead of a separate hardcoded string.
//
// Whether the Urdu name line shows: an internal admin document (a report,
// register, statement) already has its own explicit language toggle the admin
// picked for that document — pass it as `lang` and it wins. A consumer-facing
// slip (a bill, a receipt) has no such toggle and is meant to always come out
// in whatever language the committee configured for what villagers receive,
// regardless of which admin happened to print it or what language their own
// UI is in — that path is `lang` omitted, falling back to the site's
// branding.language setting exactly as before. Real report, 2026-09-28: an
// admin viewing a report in English still got an Urdu company-name line stuck
// at the top because this only ever read the unrelated site-wide setting.
export function DocumentHeader({ title, subtitle, className = '', lang }: Props) {
  const [branding, setBranding] = useState<Pick<BrandingSettings, 'companyNameEn' | 'companyNameUr' | 'language' | 'logoUrl' | 'logoWidth' | 'logoOffsetY'> | null>(null)

  useEffect(() => {
    fetchBrandingSettings().then(setBranding)
  }, [])

  const companyNameEn = branding?.companyNameEn ?? SITE.name
  const companyNameUr = branding?.companyNameUr ?? 'واٹر اینڈ ویلفئیر کمیٹی'
  const showUrdu = lang ? lang === 'ur' : branding?.language === 'ur'

  return (
    <div className={`relative text-center mb-4 pb-4 border-b border-dp-outline-variant ${className}`}>
      {branding?.logoUrl && (
        <img
          src={branding.logoUrl} alt="Logo"
          className="absolute left-0 top-0 object-contain"
          style={{ width: branding.logoWidth, height: branding.logoWidth, marginTop: branding.logoOffsetY }}
        />
      )}
      {showUrdu && (
        <p className="text-[18px] font-bold mb-1.5" style={{ fontFamily: 'var(--font-urdu-ui)' }}>{companyNameUr}</p>
      )}
      <p className="text-[15px] font-bold">{companyNameEn}</p>
      <p className="text-[13px] text-dp-on-surface-variant mt-1">{title}</p>
      {subtitle && <p className="text-[12px] text-dp-on-surface-variant">{subtitle}</p>}
    </div>
  )
}
