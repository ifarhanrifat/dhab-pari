import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getPublicSiteContext } from '@/lib/publicSite'
import { getCookieTenantId } from '@/lib/tenant'

export async function generateMetadata(): Promise<Metadata> {
  const site = await getPublicSiteContext(await createClient(), await getCookieTenantId())
  return {
    title: 'Water Bill Lookup',
    description: `Check your water bill status and payment history for ${site.name} village.`,
  }
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
