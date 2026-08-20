'use client'

import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * A translated string, usable from inside a Server Component.
 *
 * The public pages are Server Components with `revalidate`, so their HTML is
 * rendered once and shared by every visitor — the language cannot be baked in,
 * because the next reader may want the other one. A hook is not available
 * there either.
 *
 * This is the seam: the server renders the page and the layout, and drops these
 * in wherever words appear. Each one is a tiny client island that asks the
 * LocaleProvider what to say. The cached HTML stays language-neutral and the
 * words resolve in the browser.
 *
 *   <T k="home.ongoingProjects" />
 *
 * `fallback` is what to show if the key is missing — pass the original English
 * so a forgotten dictionary entry degrades to the old wording rather than to a
 * raw key in front of a villager.
 */
export function T({ k, fallback }: { k: string; fallback?: string }) {
  const { t } = useLocale()
  return <>{t(k, fallback)}</>
}

/**
 * Applies the reader's text direction to a subtree.
 *
 * Same reason as above — direction is per-reader, so it cannot be decided when
 * the page is cached. Wrap a section whose CSS has been converted to logical
 * properties and it mirrors; leave the rest alone until it has been converted.
 */
export function LocaleDir({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  // No longer a passthrough — the page and its template still don't move
  // (RTL_READY itself stays off; see LocaleProvider's own note on why), but
  // within one section a heading sitting on the left with a "view all" link
  // and arrow on the right reads backwards under Urdu. This is the seam
  // that fixes that per-section, without repositioning anything the
  // section isn't itself wrapping. Only wrap a section here once its CSS
  // has been checked for physical direction classes (ml-/mr-/pl-/pr-/
  // text-left, space-x-) that would fight the flip — same check made
  // before the wazifa form got this treatment.
  const { isUrdu } = useLocale()
  return <div dir={isUrdu ? 'rtl' : 'ltr'} className={className}>{children}</div>
}
