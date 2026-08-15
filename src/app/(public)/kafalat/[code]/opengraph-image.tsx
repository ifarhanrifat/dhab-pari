import { ImageResponse } from 'next/og'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'

export const alt = `Sponsor a child's education — ${SITE.name}`
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// Same reasoning as /projects/[id]/opengraph-image.tsx: Satori's
// Arabic/Urdu shaping is unreliable, so this generated preview thumbnail
// stays English/numeric by design — the actual page a tap lands on renders
// the real Urdu content normally, this is only the WhatsApp/Facebook
// thumbnail shown before anyone clicks through.
export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const supabase = await createClient()
  const { data: children } = await supabase.rpc('kafalat_children_for_naming')
  const child = ((children ?? []) as {
    code: string; first_name: string; current_class: string | null; is_orphan: boolean
    this_year_requirement: number; already_named: number; photo_url: string | null
  }[]).find((c) => c.code === code)

  const name = child?.first_name ?? 'A Child'
  const required = child?.this_year_requirement ?? 0
  const named = child?.already_named ?? 0
  const pct = required > 0 ? Math.min(100, Math.round((named / required) * 100)) : 0
  const remaining = Math.max(required - named, 0)
  const isFull = required > 0 && named >= required
  const photo = child?.photo_url ?? null

  return new ImageResponse(
    (
      <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', background: '#0d3b2e', padding: 64, color: 'white', position: 'relative' }}>
        {photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" width={size.width} height={size.height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        {photo && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'linear-gradient(to top, rgba(13,59,46,0.96), rgba(13,59,46,0.25) 55%, rgba(13,59,46,0.6))' }} />
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, position: 'relative' }}>
          <div style={{ fontSize: 30, fontWeight: 700 }}>{SITE.name}</div>
          <div style={{ fontSize: 18, opacity: 0.7 }}>Kafalat — Education Sponsorship</div>
        </div>
        <div style={{ display: 'flex', marginTop: 'auto', flexDirection: 'column', position: 'relative' }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            {child?.is_orphan && (
              <div style={{ display: 'flex', background: '#0369a1', padding: '8px 18px', borderRadius: 6, fontSize: 18, fontWeight: 700 }}>ORPHAN</div>
            )}
            {child?.current_class && (
              <div style={{ display: 'flex', background: 'rgba(255,255,255,0.15)', padding: '8px 18px', borderRadius: 999, fontSize: 18, fontWeight: 600 }}>Class {child.current_class}</div>
            )}
            <div style={{ display: 'flex', background: isFull ? '#2e7d32' : 'rgba(255,255,255,0.15)', padding: '8px 18px', borderRadius: 999, fontSize: 18, fontWeight: 700 }}>
              {isFull ? 'FULLY SPONSORED' : `${pct}% SPONSORED`}
            </div>
          </div>
          <div style={{ display: 'flex', fontSize: 60, fontWeight: 800, lineHeight: 1.1 }}>Sponsor {name}</div>
          <div style={{ display: 'flex', marginTop: 10, fontSize: 26, opacity: 0.85 }}>
            {isFull ? 'Education fully funded for this year, Alhamdulillah' : `Rs. ${remaining.toLocaleString()} still needed this year`}
          </div>
          {/* Progress bar */}
          <div style={{ display: 'flex', width: 700, height: 16, borderRadius: 999, background: 'rgba(255,255,255,0.2)', marginTop: 28, overflow: 'hidden' }}>
            <div style={{ display: 'flex', width: `${Math.max(pct, 3)}%`, height: '100%', background: '#7fd99a' }} />
          </div>
          <div style={{ display: 'flex', marginTop: 32, alignItems: 'baseline', gap: 14 }}>
            <div style={{ display: 'flex', fontSize: 20, opacity: 0.75, textTransform: 'uppercase', letterSpacing: 2 }}>Annual Need</div>
            <div style={{ display: 'flex', fontSize: 38, fontWeight: 800, color: '#7fd99a' }}>Rs. {required.toLocaleString()}</div>
          </div>
        </div>
      </div>
    ),
    { ...size }
  )
}
