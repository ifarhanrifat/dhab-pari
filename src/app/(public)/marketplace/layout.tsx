import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getPublicSiteContext } from '@/lib/publicSite'
import { getCookieTenantId } from '@/lib/tenant'

export async function generateMetadata(): Promise<Metadata> {
  const site = await getPublicSiteContext(await createClient(), await getCookieTenantId())
  return {
    title: 'Marketplace',
    description: `Order from local shops and book seats on local rides — the ${site.name} community marketplace.`,
  }
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
