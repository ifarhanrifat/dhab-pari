'use client'

import { forwardRef } from 'react'
import type { BrandingSettings } from '@/lib/branding'

export interface HiringRequestData {
  roleUr: string
  requirements: string
  procedure: string
  skills: string
  salary: number
  date: string
}

interface Props { data: HiringRequestData; branding: Partial<BrandingSettings> }

function fmt(n: number) {
  return Number(n).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

// Urdu-only letterhead document — no dt()/bilingual toggle involved (unlike
// ReceiptDocument), same rationale as monthlyClosingNarrative.ts: this is
// inherently an Urdu-authored committee document, not something that flips
// with the site's display_language setting. Only literal contact numbers/
// email stay as-is, per the request.
export const HiringRequestDocument = forwardRef<HTMLDivElement, Props>(function HiringRequestDocument({ data, branding }, ref) {
  const companyNameUr = branding.companyNameUr || 'واٹر اینڈ ویلفئیر کمیٹی'
  return (
    <div
      ref={ref}
      dir="rtl"
      className="relative bg-white p-10 w-[700px] text-dp-on-surface"
      style={{ fontFamily: 'var(--font-urdu), serif', textAlign: 'right' }}
    >
      <div className="relative text-center mb-6 pb-4 border-b-2 border-dp-primary">
        {branding.logoUrl && (
          <img
            src={branding.logoUrl} alt="Logo"
            className="absolute right-0 top-0 object-contain"
            style={{ width: branding.logoWidth ?? 56, height: branding.logoWidth ?? 56, marginTop: branding.logoOffsetY ?? 0 }}
          />
        )}
        <p className="text-[24px] font-bold text-dp-primary">{companyNameUr}</p>
        <p className="text-[15px] text-dp-on-surface-variant mt-1">نئی ملازمت کی درخواست</p>
        <p className="text-[13px] text-dp-on-surface-variant mt-1">بتاریخ: {data.date}</p>
      </div>

      <div className="bg-dp-surface-container-low/60 rounded-lg px-5 py-3 mb-6 text-center">
        <p className="text-[13px] text-dp-on-surface-variant">عہدہ برائے بھرتی</p>
        <p className="text-[20px] font-bold text-dp-primary">{data.roleUr}</p>
      </div>

      <Section title="بنیادی تقاضے" body={data.requirements} />
      <Section title="کام کرنے کا طریقہ کار" body={data.procedure} />
      <Section title="درکار تکنیکی مہارتیں" body={data.skills} />

      <div className="bg-dp-primary/5 border border-dp-primary/20 rounded-lg px-5 py-3 mb-6 flex items-center justify-between">
        <span className="text-[15px] font-bold">تنخواہ</span>
        <span className="text-[18px] font-bold text-dp-primary">روپے {fmt(data.salary)}</span>
      </div>

      <div className="border-t border-dashed border-dp-outline-variant pt-4 mt-8 text-[12px] text-dp-on-surface-variant space-y-1">
        <p>کمیٹی کی جانب سے</p>
        <p className="font-bold text-dp-on-surface">{companyNameUr}</p>
        {branding.helplineNumbers && <p style={{ direction: 'ltr', display: 'inline-block' }}>{branding.helplineNumbers}</p>}
        {branding.companyEmail && <p style={{ direction: 'ltr', display: 'inline-block' }}>{branding.companyEmail}</p>}
      </div>
    </div>
  )
})

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-6">
      <p className="text-[15px] font-bold text-dp-primary border-e-4 border-dp-primary pe-3 mb-2">{title}</p>
      <p className="text-[13.5px] leading-[1.9] whitespace-pre-wrap">{body}</p>
    </div>
  )
}
