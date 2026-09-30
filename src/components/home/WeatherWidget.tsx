'use client'

import { useEffect, useState } from 'react'
import { Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, Wind } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SITE } from '@/lib/constants'

// Phase 1 of the "Village OS" feature set, 2026-09-30. Open-Meteo — free,
// no API key, no account, CORS-enabled for direct browser calls — for a
// village homepage this doesn't need anything heavier. Fixed village
// coordinates (SITE.lat/lng), not the visitor's own location: anyone
// loading the public homepage should see this village's weather with no
// permission prompt.
interface WeatherNow { temp: number; code: number; windKph: number; maxToday: number; minToday: number; rainChance: number }

function iconFor(code: number, size: number) {
  if (code === 0) return <Sun size={size} className="text-amber-500" />
  if (code <= 3) return <Cloud size={size} className="text-slate-400" />
  if (code === 45 || code === 48) return <CloudFog size={size} className="text-slate-400" />
  if (code >= 51 && code <= 67) return <CloudRain size={size} className="text-sky-500" />
  if (code >= 71 && code <= 77) return <CloudSnow size={size} className="text-sky-300" />
  if (code >= 80 && code <= 82) return <CloudRain size={size} className="text-sky-500" />
  if (code >= 95) return <CloudLightning size={size} className="text-purple-500" />
  return <Cloud size={size} className="text-slate-400" />
}

const LABEL_KEY: (code: number) => string = (code) => {
  if (code === 0) return 'wx.clear'
  if (code <= 3) return 'wx.cloudy'
  if (code === 45 || code === 48) return 'wx.fog'
  if (code >= 51 && code <= 67) return 'wx.rain'
  if (code >= 71 && code <= 77) return 'wx.snow'
  if (code >= 80 && code <= 82) return 'wx.showers'
  if (code >= 95) return 'wx.storm'
  return 'wx.cloudy'
}

export function WeatherWidget() {
  const { t } = useLocale()
  const [weather, setWeather] = useState<WeatherNow | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${SITE.lat}&longitude=${SITE.lng}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`
    fetch(url).then((r) => r.json()).then((data) => {
      setWeather({
        temp: Math.round(data.current.temperature_2m),
        code: data.current.weather_code,
        windKph: Math.round(data.current.wind_speed_10m),
        maxToday: Math.round(data.daily.temperature_2m_max[0]),
        minToday: Math.round(data.daily.temperature_2m_min[0]),
        rainChance: data.daily.precipitation_probability_max[0] ?? 0,
      })
    }).catch(() => setFailed(true))
  }, [])

  if (failed || !weather) return null

  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center gap-3">
      {iconFor(weather.code, 32)}
      <div className="min-w-0">
        <p className="font-heading text-[20px] font-bold text-dp-on-surface leading-none ltr-num">{weather.temp}°C</p>
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">{t(LABEL_KEY(weather.code))} · <span className="ltr-num">{weather.minToday}°–{weather.maxToday}°</span></p>
        {weather.rainChance >= 40 && (
          <p className="font-sans text-[11px] text-sky-600 mt-0.5 flex items-center gap-1"><CloudRain size={11} /> <span className="ltr-num">{weather.rainChance}%</span> {t('wx.rainChance')}</p>
        )}
        {weather.windKph >= 30 && (
          <p className="font-sans text-[11px] text-amber-600 mt-0.5 flex items-center gap-1"><Wind size={11} /> {t('wx.strongWind')}</p>
        )}
      </div>
    </div>
  )
}
