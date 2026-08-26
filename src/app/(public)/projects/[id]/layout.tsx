import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'

// Per-project metadata so a shared /projects/[id] link shows the real
// project (not the generic "Village Projects" list title/description) when
// pasted into Facebook/WhatsApp — the description leads with the budget,
// since that's the one piece of info a voter needs before they'll vote.
// The actual preview image comes from the sibling opengraph-image.tsx via
// Next's file convention (auto-wired, no manual reference needed here).
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const supabase = await createClient()
  const { data: project } = await supabase.from('projects').select('title, display_name, description, budget_pkr').eq('id', id).maybeSingle()

  if (!project) return { title: 'Project Not Found' }

  // Migration 364 — this is exactly the kind of surface display_name
  // exists for: a shared link's tab title / WhatsApp preview reaches
  // people who never touched the site itself.
  const title = project.display_name || project.title
  const budgetLine = project.budget_pkr ? `Budget: Rs. ${Number(project.budget_pkr).toLocaleString()}. ` : ''
  const description = `${budgetLine}${project.description ?? `A community project by ${SITE.fullName}.`}`.slice(0, 200)

  return {
    title,
    description,
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary_large_image', title, description },
  }
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
