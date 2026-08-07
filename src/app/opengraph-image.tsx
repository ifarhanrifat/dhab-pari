import { ImageResponse } from 'next/og'

export const alt = 'Dhab Pari Water & Welfare Committee'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// Site-wide default share preview — every page inherits this unless it
// defines its own (e.g. /projects/[id] has a per-project one). Previously
// there was no og:image at all, so links pasted into Facebook/WhatsApp
// showed a bare text card.
export default function Image() {
  return new ImageResponse(
    (
      <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0d3b2e', color: 'white' }}>
        <div style={{ display: 'flex', fontSize: 88, fontWeight: 800 }}>Dhab Pari</div>
        <div style={{ display: 'flex', fontSize: 30, opacity: 0.85, marginTop: 12 }}>Water &amp; Welfare Committee</div>
        <div style={{ display: 'flex', fontSize: 20, opacity: 0.6, marginTop: 28, letterSpacing: 3, textTransform: 'uppercase' }}>Village Transparency Portal</div>
      </div>
    ),
    { ...size }
  )
}
