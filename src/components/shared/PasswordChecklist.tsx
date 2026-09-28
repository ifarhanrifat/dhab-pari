'use client'

import { Check, X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PASSWORD_REQUIREMENTS } from '@/lib/passwordPolicy'

// Live "is this actually going to be accepted" feedback — real ask,
// 2026-09-28: nobody could tell whether a password met the real
// (12-char, mixed-case, digit, special-character) policy until they
// submitted the form and got a raw rejection. Every requirement re-checks
// on each keystroke instead of only showing a static list, so someone
// can see exactly which box is still unmet in real time.
export function PasswordChecklist({ password }: { password: string }) {
  const { isUrdu } = useLocale()
  return (
    <ul className="mt-2 space-y-1" dir={isUrdu ? 'rtl' : 'ltr'}>
      {PASSWORD_REQUIREMENTS.map((r) => {
        const ok = r.test(password)
        return (
          <li key={r.key} className={`flex items-center gap-1.5 text-[11.5px] font-sans transition-colors ${ok ? 'text-emerald-600' : 'text-dp-on-surface-variant'}`}>
            {ok ? <Check size={13} className="shrink-0" /> : <X size={13} className="shrink-0 opacity-40" />}
            {isUrdu ? r.labelUr : r.labelEn}
          </li>
        )
      })}
    </ul>
  )
}
