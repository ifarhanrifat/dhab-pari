'use client'

import { Languages } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Two words, one tap. Deliberately not a dropdown: there are exactly two
 * languages and a committee member switching to Urdu should not have to
 * navigate a menu in a language they cannot read to get there.
 *
 * The choice is saved against the person, not the device, so it follows them
 * to the phone they actually use.
 */
export function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale } = useLocale()

  return (
    <div
      className={`inline-flex items-center rounded-lg border border-dp-outline-variant overflow-hidden ${compact ? 'h-8' : 'h-9'}`}
      role="group"
      aria-label="Language"
    >
      {!compact && (
        <span className="px-2 text-dp-on-surface-variant" aria-hidden>
          <Languages size={15} />
        </span>
      )}
      <button
        onClick={() => setLocale('en')}
        aria-pressed={locale === 'en'}
        className={`px-2.5 h-full font-sans text-[12.5px] font-semibold cursor-pointer transition-colors ${
          locale === 'en' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant hover:bg-dp-surface-container-low'
        }`}
      >
        EN
      </button>
      <button
        onClick={() => setLocale('ur')}
        aria-pressed={locale === 'ur'}
        // Always rendered in Nastaliq regardless of the current language, so
        // an Urdu reader can find it while the interface is still English.
        className={`px-2.5 h-full text-[13.5px] font-semibold cursor-pointer transition-colors ${
          locale === 'ur' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant hover:bg-dp-surface-container-low'
        }`}
        style={{ fontFamily: 'var(--font-urdu), serif' }}
      >
        اردو
      </button>
    </div>
  )
}
