'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Moon } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { useSite } from '@/components/layout/SiteProvider'
import { formatHijri, formatPunjabi } from '@/lib/desiCalendar'

// Phase 1 correction, 2026-10-12 -- real gap found live on device: the
// template's weather+date row is two small compact boxes SIDE BY SIDE
// INSIDE the ayat hero card itself (one line of weather, one line of
// date), not the full-size WeatherWidget/DateCard cards from the old
// design wrapped in a separate section below it -- the two don't read
// as the same component at all. Rebuilt from scratch to match: real
// weather (same open-meteo call WeatherWidget already uses, keyed off
// site.lat/lng) and the real, already-correct Hijri/Punjabi calendar
// helpers (src/lib/desiCalendar.ts), not the template's own simpler
// date math.
interface WeatherNow { temp: number; code: number }

const COND_KEY: (code: number) => string = (code) => {
  if (code === 0) return 'wx.clear'
  if (code <= 3) return 'wx.cloudy'
  if (code === 45 || code === 48) return 'wx.fog'
  if (code >= 51 && code <= 67) return 'wx.rain'
  if (code >= 71 && code <= 77) return 'wx.snow'
  if (code >= 80 && code <= 82) return 'wx.showers'
  if (code >= 95) return 'wx.storm'
  return 'wx.cloudy'
}

export function HeroWeatherDate() {
  const { t, isUrdu } = useLocale()
  const site = useSite()
  const [weather, setWeather] = useState<WeatherNow | null>(null)
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => { setNow(new Date()) }, [])

  useEffect(() => {
    if (site.lat == null || site.lng == null) return
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${site.lat}&longitude=${site.lng}&current=temperature_2m,weather_code&timezone=auto`
    fetch(url).then((r) => r.json()).then((data) => {
      setWeather({ temp: Math.round(data.current.temperature_2m), code: data.current.weather_code })
    }).catch(() => {})
  }, [site.lat, site.lng])

  const hijri = now ? formatHijri(now, isUrdu) : ''
  const punjabi = now ? formatPunjabi(now, isUrdu) : ''
  const greg = now ? now.toLocaleDateString(isUrdu ? 'ur-PK-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' }) : ''

  if (site.lat == null || site.lng == null || !now) return null

  return (
    <div dir="ltr" className="relative grid grid-cols-2 gap-2">
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-center gap-1.5 min-w-0 bg-white/10 border border-white/15 rounded-xl px-2 py-1 text-start">
        <span className="shrink-0 text-base leading-none">☀️</span>
        <div className="min-w-0 flex flex-col">
          {weather ? (
            <>
              <span className="text-[10px] leading-[1.75] whitespace-nowrap overflow-hidden text-ellipsis">
                <span dir="ltr" className="font-bold">{weather.temp}°C</span> {isUrdu ? site.nameUrdu : site.name}
              </span>
              <span className="text-[10px] leading-[1.75] text-green-100 whitespace-nowrap overflow-hidden text-ellipsis">{t(COND_KEY(weather.code))}</span>
            </>
          ) : (
            <span className="text-[10px] leading-[1.75] text-green-100">…</span>
          )}
        </div>
      </div>
      {/* Real gap found live on device: the old DateCard's moon icon
          opened the moon-finder camera tool (same icon in the header too)
          -- lost when this compact hero row replaced DateCard outright.
          Restored as a tap target on the whole date box, same as before. */}
      <Link href="/moon-finder" dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-center gap-1.5 min-w-0 bg-white/10 border border-white/15 rounded-xl px-2 py-1 text-start">
        <Moon size={16} className="shrink-0 text-dp2-gold" />
        <div className="min-w-0 flex flex-col">
          <span className="text-[10px] leading-[1.75] font-bold whitespace-nowrap overflow-hidden text-ellipsis">{greg}</span>
          <span className="text-[10px] leading-[1.75] text-green-100 whitespace-nowrap overflow-hidden text-ellipsis">{hijri}</span>
          <span className="text-[10px] leading-[1.75] text-dp2-gold whitespace-nowrap overflow-hidden text-ellipsis">{punjabi}</span>
        </div>
      </Link>
    </div>
  )
}
