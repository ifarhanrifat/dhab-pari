'use client'

import { forwardRef } from 'react'
import type { BrandingSettings } from '@/lib/branding'

const MONTH_UR = [
  'جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون',
  'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر',
]
const DIGIT_UR = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']
const toUrduDigits = (n: string | number) => String(n).replace(/[0-9]/g, (d) => DIGIT_UR[+d])

// meeting_date is a plain date (YYYY-MM-DD) — parse manually rather than
// via `new Date()` to avoid any UTC-offset day-shift.
export function formatUrduDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return `${toUrduDigits(d)} ${MONTH_UR[m - 1]} ${toUrduDigits(y)}`
}
// meeting_time is a plain time (HH:MM[:SS]) from a Postgres `time` column.
export function formatUrduTime(time: string): string {
  const [hStr, mStr] = time.split(':')
  let h = Number(hStr)
  const suffix = h >= 12 ? 'شام' : 'صبح'
  h = h % 12 || 12
  return `${toUrduDigits(h)}:${mStr} ${suffix}`
}

export interface MeetingNoticeData {
  meetingDateLabel: string // already Urdu-formatted, via formatUrduDate
  meetingTimeLabel: string | null // already Urdu-formatted, via formatUrduTime
  location: string | null
  title: string | null
}

interface Props { data: MeetingNoticeData; branding: Partial<BrandingSettings> }

// The dictated notice: mandatory attendance, bring >=2 new proposals, and
// members without WhatsApp will be informed personally by the Secretary —
// fixed copy, not a template, since this is the exact wording given.
export const MeetingNoticeDocument = forwardRef<HTMLDivElement, Props>(function MeetingNoticeDocument({ data, branding }, ref) {
  const companyNameUr = branding.companyNameUr || branding.companyNameEn || 'واٹر اینڈ ویلفئیر کمیٹی'

  return (
    <div ref={ref} className="relative bg-white p-8 w-[560px] text-dp-on-surface" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>
      <div className="relative text-center mb-6 pb-4 border-b-2 border-dp-primary">
        {branding.logoUrl && (
          <img src={branding.logoUrl} alt="Logo" className="absolute right-0 top-0 object-contain" style={{ width: branding.logoWidth ?? 48, height: branding.logoWidth ?? 48 }} />
        )}
        <p className="text-[22px] font-bold">{companyNameUr}</p>
        <p className="text-[16px] font-bold text-dp-primary mt-2">اجلاس کا اعلان</p>
      </div>

      {data.title && <p className="text-[16px] font-bold text-center mb-4">{data.title}</p>}

      <div className="flex justify-center gap-8 mb-6 text-center">
        <div>
          <p className="text-[12.5px] text-dp-on-surface-variant">تاریخ</p>
          <p className="text-[18px] font-bold">{data.meetingDateLabel}</p>
        </div>
        {data.meetingTimeLabel && (
          <div>
            <p className="text-[12.5px] text-dp-on-surface-variant">وقت</p>
            <p className="text-[18px] font-bold">{data.meetingTimeLabel}</p>
          </div>
        )}
        {data.location && (
          <div>
            <p className="text-[12.5px] text-dp-on-surface-variant">مقام</p>
            <p className="text-[18px] font-bold">{data.location}</p>
          </div>
        )}
      </div>

      <div className="bg-dp-secondary-container/40 border border-dp-secondary rounded-lg p-4 mb-4 text-center">
        <p className="text-[15px] font-bold text-dp-primary">تمام ممبران کی شرکت ضروری ہے</p>
      </div>

      <div className="border border-dp-outline-variant rounded-lg p-4 space-y-3">
        <p className="text-[14px] leading-[26px]">
          تمام ممبران سے التماس ہے کہ کم از کم 2 نئی تجاویز اپنے ساتھ ضرور لے کر آئیں۔
        </p>
        <p className="text-[14px] leading-[26px]">
          اور یہ کہ جن ممبران کے پاس واٹس ایپ نہیں ہے انہیں سرفراز احمد سیکرٹری خود اطلاع دیں گے۔
        </p>
        <p className="text-[14px] font-bold text-left" dir="rtl">والسلام</p>
      </div>
    </div>
  )
})
