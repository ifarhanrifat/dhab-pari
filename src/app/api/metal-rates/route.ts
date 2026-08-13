import { NextResponse } from 'next/server'

/**
 * Today's gold and silver rate in rupees per gram.
 *
 * The committee should not have to type these in every time somebody wants to
 * work out their zakat, and a nisab computed from a rate somebody entered
 * eight months ago is worse than no nisab at all.
 *
 * Nothing here is our own valuation. Two public sources are combined:
 *
 *   gold-api.com    spot gold and silver, US dollars per troy ounce
 *   open.er-api.com the dollar-to-rupee rate
 *
 * Both are free, need no key, and are named on the page — the calculator says
 * plainly where its numbers came from and when, because a zakat figure worked
 * out from an unattributed rate is a number nobody should act on.
 *
 * Fetched server-side because a browser calling either directly is blocked by
 * CORS, and cached for an hour: spot metal moves in seconds, but nobody's
 * zakat turns on the third decimal place.
 */

const TROY_OUNCE_GRAMS = 31.1034768
const CACHE_SECONDS = 3600

interface MetalRates {
  goldPkrPerGram: number
  silverPkrPerGram: number
  usdPkr: number
  goldUsdPerOunce: number
  silverUsdPerOunce: number
  fetchedAt: string
  sources: string[]
  stale: boolean
}

export const revalidate = 3600

export async function GET() {
  try {
    const [goldRes, silverRes, fxRes] = await Promise.all([
      fetch('https://api.gold-api.com/price/XAU', { next: { revalidate: CACHE_SECONDS } }),
      fetch('https://api.gold-api.com/price/XAG', { next: { revalidate: CACHE_SECONDS } }),
      fetch('https://open.er-api.com/v6/latest/USD', { next: { revalidate: CACHE_SECONDS } }),
    ])

    if (!goldRes.ok || !silverRes.ok || !fxRes.ok) {
      return NextResponse.json({ error: 'upstream_unavailable' }, { status: 502 })
    }

    const gold = await goldRes.json()
    const silver = await silverRes.json()
    const fx = await fxRes.json()

    const goldUsd = Number(gold?.price)
    const silverUsd = Number(silver?.price)
    const usdPkr = Number(fx?.rates?.PKR)

    // A missing rate must not quietly become zero — a zero rate produces a
    // nisab of zero, which would tell every visitor they owe zakat.
    if (!Number.isFinite(goldUsd) || !Number.isFinite(silverUsd) || !Number.isFinite(usdPkr)
        || goldUsd <= 0 || silverUsd <= 0 || usdPkr <= 0) {
      return NextResponse.json({ error: 'bad_upstream_data' }, { status: 502 })
    }

    const body: MetalRates = {
      goldPkrPerGram: Math.round((goldUsd * usdPkr) / TROY_OUNCE_GRAMS),
      silverPkrPerGram: Math.round(((silverUsd * usdPkr) / TROY_OUNCE_GRAMS) * 100) / 100,
      usdPkr: Math.round(usdPkr * 100) / 100,
      goldUsdPerOunce: goldUsd,
      silverUsdPerOunce: silverUsd,
      fetchedAt: new Date().toISOString(),
      sources: ['gold-api.com', 'open.er-api.com'],
      stale: false,
    }

    return NextResponse.json(body, {
      headers: { 'Cache-Control': `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400` },
    })
  } catch {
    return NextResponse.json({ error: 'fetch_failed' }, { status: 502 })
  }
}
