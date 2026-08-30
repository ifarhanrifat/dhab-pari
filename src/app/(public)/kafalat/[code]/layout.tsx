import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'

// Per-child metadata so a shared /kafalat/[code] link shows the actual
// child's name and progress when pasted into WhatsApp/Facebook, not the
// generic site title. The preview image itself comes from the sibling
// opengraph-image.tsx via Next's file convention.
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params
  const supabase = await createClient()
  const { data: children } = await supabase.rpc('kafalat_children_for_naming')
  const child = ((children ?? []) as { code: string; first_name: string; this_year_requirement: number; already_named: number }[])
    .find((c) => c.code === code)

  if (!child) return { title: 'Child Not Found' }

  const remaining = Math.max(child.this_year_requirement - child.already_named, 0)
  const description = remaining > 0
    ? `${child.first_name} still needs ${remaining.toLocaleString()} for this school year. Join their sponsorship on ${SITE.fullName}.`
    : `${child.first_name}'s education is fully sponsored, Alhamdulillah — see how ${SITE.fullName}'s Kafalat programme works.`

  return {
    title: `Sponsor ${child.first_name}'s Education`,
    description,
    openGraph: { title: `Sponsor ${child.first_name}'s Education`, description, type: 'website' },
    twitter: { card: 'summary_large_image', title: `Sponsor ${child.first_name}'s Education`, description },
  }
}

export default function KafalatChildLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
