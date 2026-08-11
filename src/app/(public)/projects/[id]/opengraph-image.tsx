import { ImageResponse } from 'next/og'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'
import { T } from '@/components/i18n/T'

export const alt = `${SITE.name} Project`
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const STATUS_LABEL: Record<string, string> = {
  upcoming: 'Open for Voting', announced: 'Awaiting Confirmation', ongoing: 'Ongoing',
  reviewing: 'Committee Reviewing', completed: 'Completed', rejected: 'Not Approved',
}

// Generated fresh per share (not a static upload) so it's always accurate —
// title, category, status, and budget baked right into the preview image,
// so the compulsory pre-vote info shows up even before someone clicks
// through. English/numeric only by design: Satori (the renderer behind
// next/og) has unreliable Arabic/Urdu shaping, so project titles etc. are
// assumed Latin-script here — the real on-page content is unaffected.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: project } = await supabase.from('projects')
    .select('title, category, budget_pkr, status, proposal_image_url, after_image_url, before_image_url').eq('id', id).maybeSingle()

  const title = project?.title ?? 'Village Project'
  const category = (project?.category ?? 'project').toUpperCase()
  const budget = project?.budget_pkr ? `Rs. ${Number(project.budget_pkr).toLocaleString()}` : null
  const statusLabel = STATUS_LABEL[project?.status ?? ''] ?? ''
  // Prefer a real submitted/documented photo over the generated card —
  // proposer's photo first, then staff-documented after/before progress shots.
  const photo = project?.proposal_image_url ?? project?.after_image_url ?? project?.before_image_url ?? null

  return new ImageResponse(
    (
      <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', background: '#0d3b2e', padding: 64, color: 'white', position: 'relative' }}>
        {photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" width={size.width} height={size.height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        {photo && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'linear-gradient(to top, rgba(13,59,46,0.95), rgba(13,59,46,0.15) 55%, rgba(13,59,46,0.55))' }} />
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, position: 'relative' }}>
          <div style={{ fontSize: 30, fontWeight: 700 }}>{SITE.name}</div>
          <div style={{ fontSize: 18, opacity: 0.7 }}>{SITE.committee}</div>
        </div>
        <div style={{ display: 'flex', marginTop: 'auto', flexDirection: 'column', position: 'relative' }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
            <div style={{ display: 'flex', background: '#2e7d32', padding: '8px 18px', borderRadius: 6, fontSize: 18, fontWeight: 700 }}>{category}</div>
            {statusLabel && <div style={{ display: 'flex', background: 'rgba(255,255,255,0.15)', padding: '8px 18px', borderRadius: 999, fontSize: 18, fontWeight: 600 }}>{statusLabel}</div>}
          </div>
          <div style={{ display: 'flex', fontSize: 56, fontWeight: 800, lineHeight: 1.15, maxWidth: 1000 }}>{title}</div>
          {budget && (
            <div style={{ display: 'flex', marginTop: 32, alignItems: 'baseline', gap: 14 }}>
              <div style={{ display: 'flex', fontSize: 22, opacity: 0.75, textTransform: 'uppercase', letterSpacing: 2 }}>Requested Budget</div>
              <div style={{ display: 'flex', fontSize: 42, fontWeight: 800, color: '#7fd99a' }}>{budget}</div>
            </div>
          )}
        </div>
      </div>
    ),
    { ...size }
  )
}
