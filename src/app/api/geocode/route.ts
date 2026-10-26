import { NextRequest, NextResponse } from 'next/server'

// Thin server-side proxy in front of Photon (photon.komoot.io, the same
// free OSM geocoder LocationPickerSheet already used directly) — added
// for exactly one reason: Urdu results.
//
// Real ask, 2026-10-26: "try to display the addresses in Urdu and not
// English." Photon rejects `lang=ur` as a query param outright
// ("Language is not supported. Supported are: default, de, en, fr" —
// confirmed live), but its "default" mode already returns a Pakistani
// place's real local-script name — not a translation, the actual name
// OSM has it tagged with — *if* the request's Accept-Language header
// says so. Confirmed live, same coordinate, two ways to ask: an
// Accept-Language: ur header returns "پنجاب"/"پاکستان"; an
// Accept-Language: en-US header (or none, on a device whose Chrome/
// Android locale is English) returns "Punjab"/"Pakistan" for the exact
// same place. And `fetch()` from the browser can't be made to send a
// different Accept-Language than the device's own — it's a header the
// browser controls, not the page — so client-side JS has no way to ask
// Photon for Urdu on an English-locale phone no matter what it passes.
// A server-side fetch has no such restriction, so this route exists
// purely to set that one header on Photon's behalf.
//
// Search ranking is the other half of why this isn't just "always ask
// for Urdu": confirmed live, a `q=Chakwal` search ranks an Indian
// village first under Accept-Language: ur (or no header at all) but
// correctly ranks Pakistan's Chakwal first under `lang=en` — Photon's
// own `lang` query param changes its whole relevance score, not just
// which name field comes back. So `mode=search` always asks Photon
// with `lang=en` (good ranking, Latin-script names); the caller then
// re-resolves each result's real label via `mode=reverse` with
// `lang=ur`, same two-step split LocationPickerSheet.tsx already does.

const PK_BBOX = '60.5,23.0,77.5,37.5'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('mode')
  const lang = searchParams.get('lang') === 'ur' ? 'ur' : 'en'

  if (mode === 'search') {
    const q = searchParams.get('q')?.trim()
    if (!q) return NextResponse.json({ features: [] })
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&bbox=${PK_BBOX}`)
    if (!res.ok) return NextResponse.json({ features: [] }, { status: 502 })
    return NextResponse.json(await res.json())
  }

  if (mode === 'reverse') {
    const lat = searchParams.get('lat')
    const lon = searchParams.get('lon')
    if (!lat || !lon) return NextResponse.json({ features: [] })
    const url = lang === 'en'
      ? `https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}&lang=en`
      : `https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}`
    const res = await fetch(url, lang === 'ur' ? { headers: { 'Accept-Language': 'ur' } } : undefined)
    if (!res.ok) return NextResponse.json({ features: [] }, { status: 502 })
    return NextResponse.json(await res.json())
  }

  return NextResponse.json({ error: 'mode must be search or reverse' }, { status: 400 })
}
