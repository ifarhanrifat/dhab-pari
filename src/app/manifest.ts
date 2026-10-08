import type { MetadataRoute } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getPublicSiteContext } from '@/lib/publicSite'
import { getCookieTenantId } from '@/lib/tenant'

// Next.js serves this at /manifest.webmanifest and links it automatically —
// no <link rel="manifest"> needed in the layout. Async so the installed
// home-screen app's own name/description reflect the real tenant (this
// used to hardcode SITE.name, always "Dhab Pari", regardless of which
// committee's subdomain someone installed the app from).
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const site = await getPublicSiteContext(await createClient(), await getCookieTenantId())
  return {
    name: `${site.name} — ${site.shortCommittee}`,
    short_name: site.name,
    description: `Village transparency portal — water bills, donations, projects, and committee updates for ${site.name}.`,
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    // Matches the site header (dp-primary), so the Android status bar and the
    // splash screen blend into the app instead of flashing white.
    theme_color: '#0B3B2E',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Android crops these to its own shape — art sits inside the safe zone.
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Long-press the installed icon for these. Deliberately the three things a
    // villager actually opens the app to do.
    shortcuts: [
      { name: 'Pay Water Bill', url: '/water', description: 'Check and pay your water bill' },
      { name: 'Donate', url: '/donate', description: 'Support village projects' },
      { name: 'My Portal', url: '/portal', description: 'Your account, bills and donations' },
    ],
    categories: ['government', 'finance', 'utilities'],
    lang: 'en',
    dir: 'ltr',
  }
}
