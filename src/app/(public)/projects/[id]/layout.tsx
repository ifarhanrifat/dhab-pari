import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'

// Per-project metadata so a shared /projects/[id] link shows the real
// project (not the generic "Village Projects" list title/description) when
// pasted into Facebook/WhatsApp — the description leads with the budget,
// since that's the one piece of info a voter needs before they'll vote.
// The actual preview image comes from the sibling opengraph-image.tsx via
// Next's file convention (auto-wired, no manual reference needed here).
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const supabase = await createClient()
  const { data: project } = await supabase.from('projects').select('title, description, budget_pkr').eq('id', id).maybeSingle()

  if (!project) return { title: 'Project Not Found' }

  const budgetLine = project.budget_pkr ? `Budget: Rs. ${Number(project.budget_pkr).toLocaleString()}. ` : ''
  const description = `${budgetLine}${project.description ?? 'A community project by Dhab Pari Water & Welfare Committee.'}`.slice(0, 200)

  return {
    title: project.title,
    description,
    openGraph: { title: project.title, description, type: 'website' },
    twitter: { card: 'summary_large_image', title: project.title, description },
  }
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
