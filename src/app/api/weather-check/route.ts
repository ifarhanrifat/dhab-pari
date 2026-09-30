import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { SITE } from '@/lib/constants'

// Called twice a day by the pg_cron job in migration 544 (trigger_weather_check(),
// fire-and-forget via pg_net — same pattern as dispatch_push_notification, 348).
// Same threshold as the /weather page's own on-page banner (rain >=70% or
// wind >=40 km/h, next 3 days) — one source of truth for "what counts as
// severe" would be nice, but the banner reads live client-side data and this
// reads a fresh server-side fetch, so the two constants are kept in sync by
// comment rather than shared code.
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.PUSH_TRIGGER_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${SITE.lat}&longitude=${SITE.lng}&daily=precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=3`
  const res = await fetch(url)
  if (!res.ok) return NextResponse.json({ ok: false, note: 'weather fetch failed' }, { status: 502 })
  const data = await res.json()

  const days: { date: string; rainChance: number; windMax: number }[] = data.daily.time.map((d: string, i: number) => ({
    date: d,
    rainChance: data.daily.precipitation_probability_max[i] ?? 0,
    windMax: Math.round(data.daily.wind_speed_10m_max[i] ?? 0),
  }))
  const tripped = days.filter((d) => d.rainChance >= 70 || d.windMax >= 40)
  if (tripped.length === 0) return NextResponse.json({ ok: true, note: 'no severe weather' })

  const worst = tripped.reduce((a, b) => (b.rainChance > a.rainChance || b.windMax > a.windMax ? b : a))
  const partsEn: string[] = []
  const partsUr: string[] = []
  if (worst.rainChance >= 70) { partsEn.push(`heavy rain expected (${worst.rainChance}%)`); partsUr.push(`تیز بارش متوقع ہے (${worst.rainChance}%)`) }
  if (worst.windMax >= 40) { partsEn.push(`strong winds expected (${worst.windMax} km/h)`); partsUr.push(`تیز ہوائیں متوقع ہیں (${worst.windMax} کلومیٹر فی گھنٹہ)`) }
  const bodyEn = `Weather alert for ${SITE.name}: ${partsEn.join(' and ')}. Please take precautions.`
  const bodyUr = `${SITE.nameUrdu ?? SITE.name} کے لیے موسمی انتباہ: ${partsUr.join(' اور ')}۔ براہ کرم احتیاط کریں۔`

  const supabase = createAdminClient()
  const { data: alertId, error } = await supabase.rpc('broadcast_weather_alert', {
    p_body_en: bodyEn, p_body_ur: bodyUr, p_rain_chance: worst.rainChance, p_wind_kph: worst.windMax,
  })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, sent: alertId != null, alertId })
}
