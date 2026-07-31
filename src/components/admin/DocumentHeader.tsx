'use client'

import { useEffect, useState } from 'react'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'

interface Props { title: string; subtitle?: string; className?: string }

// Shared header for printed/on-screen documents (reports, registers, statements) —
// logo sits independently in the top-left corner (absolute, sized/nudged from
// Settings) so it never drags the heading off-center, and the Urdu heading only
// renders when the site's display language is actually set to Urdu. Company name
// (English/Urdu) comes from the same fetchBrandingSettings() source bills and
// receipts already use, instead of a separate hardcoded string.
export function DocumentHeader({ title, subtitle, className = '' }: Props) {
  const [branding, setBranding] = useState<Pick<BrandingSettings, 'companyNameEn' | 'companyNameUr' | 'language' | 'logoUrl' | 'logoWidth' | 'logoOffsetY'> | null>(null)

  useEffect(() => {
    fetchBrandingSettings().then(setBranding)
  }, [])

  const companyNameEn = branding?.companyNameEn ?? 'Dhab Pari'
  const companyNameUr = branding?.companyNameUr ?? 'واٹر اینڈ ویلفئیر کمیٹی'
  const showUrdu = branding?.language === 'ur'

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
        <p className="text-[18px] font-bold mb-1.5" style={{ fontFamily: 'var(--font-urdu), serif' }}>{companyNameUr}</p>
      )}
      <p className="text-[15px] font-bold">{companyNameEn}</p>
      <p className="text-[13px] text-dp-on-surface-variant mt-1">{title}</p>
      {subtitle && <p className="text-[12px] text-dp-on-surface-variant">{subtitle}</p>}
    </div>
  )
}
