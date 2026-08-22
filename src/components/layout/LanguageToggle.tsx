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
      // Arbitrary-value height (h-[32px], not h-8) deliberately, not the bare
      // Tailwind class — globals.css has a broad html[lang='ur'] .h-8/.h-9/
      // .h-10 rule that forces those specific classes to height:auto so
      // Nastaliq labels elsewhere in the app don't get clipped. This pill
      // was already sized (smaller Urdu font, leading-none, both buttons
      // h-full) to fit without needing that escape hatch, so it should never
      // have been caught by it — matching h-8/h-9 by class name was
      // accidental, not intended for this component specifically.
      className={`inline-flex items-center rounded-lg border border-dp-outline-variant overflow-hidden ${compact ? 'h-[32px]' : 'h-[36px]'}`}
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
        // Nastaliq renders visibly larger than a Latin face at the same px
        // (see globals.css's own note on this) — sized down from "EN"'s
        // 12.5px rather than up, so the pill stays the fixed height it's
        // set to instead of the glyph pushing past it.
        className={`px-2.5 h-full flex items-center text-[11px] font-semibold cursor-pointer transition-colors leading-none ${
          locale === 'ur' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant hover:bg-dp-surface-container-low'
        }`}
        style={{ fontFamily: 'var(--font-urdu), serif' }}
      >
        اردو
      </button>
    </div>
  )
}
