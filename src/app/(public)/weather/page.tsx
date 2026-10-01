'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, Wind, Droplets, Sunrise, Sunset, AlertTriangle, MapPin, LocateFixed } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { SITE } from '@/lib/constants'
import { LoadingDots } from '@/components/shared/LoadingDots'

// Leaflet touches `window` at import time — same ssr:false pattern every
// other Leaflet map in this app already uses.

// Phase 3 of the "Village OS" feature set, 2026-09-30: a full forecast
// page (not just the homepage's single-number widget) — current
// conditions, next 24 hours, 7-day outlook, and an embedded weather map.
// Uses the VISITOR'S OWN location when they allow it (a real ask,
// distinct from the homepage widget, which deliberately always shows the
// village's weather to everyone with no permission prompt) — falls back
// to the village's fixed coordinates if location access is denied or
// unavailable, so the page still works either way.
interface Hour { time: string; temp: number; code: number; rainChance: number }
interface Day { date: string; code: number; max: number; min: number; rainChance: number; uv: number; sunrise: string; sunset: string; windMax: number }
interface WeatherData {
  temp: number; feelsLike: number; code: number; humidity: number; windKph: number
  hourly: Hour[]; daily: Day[]
}

function iconFor(code: number, size: number, className = '') {
  const cls = `${className}`.trim()
  if (code === 0) return <Sun size={size} className={cls || 'text-amber-500'} />
  if (code <= 3) return <Cloud size={size} className={cls || 'text-slate-400'} />
  if (code === 45 || code === 48) return <CloudFog size={size} className={cls || 'text-slate-400'} />
  if (code >= 51 && code <= 67) return <CloudRain size={size} className={cls || 'text-sky-500'} />
  if (code >= 71 && code <= 77) return <CloudSnow size={size} className={cls || 'text-sky-300'} />
  if (code >= 80 && code <= 82) return <CloudRain size={size} className={cls || 'text-sky-500'} />
  if (code >= 95) return <CloudLightning size={size} className={cls || 'text-purple-500'} />
  return <Cloud size={size} className={cls || 'text-slate-400'} />
}
const LABEL_KEY = (code: number): string => {
  if (code === 0) return 'wx.clear'
  if (code <= 3) return 'wx.cloudy'
  if (code === 45 || code === 48) return 'wx.fog'
  if (code >= 51 && code <= 67) return 'wx.rain'
  if (code >= 71 && code <= 77) return 'wx.snow'
  if (code >= 80 && code <= 82) return 'wx.showers'
  if (code >= 95) return 'wx.storm'
  return 'wx.cloudy'
}

export default function WeatherPage() {
  const { t, isUrdu } = useLocale()
  // Real report, 2026-09-30: silently requesting geolocation the instant
  // the page loads (no click, no user gesture) is exactly the pattern
  // browsers are most likely to auto-block or never actually prompt for
  // — and it gives the visitor no visible moment of "this site wants your
  // location, allow or deny". Defaults to the village's own coordinates
  // immediately; "Use My Location" below is a real, explicit, user-
  // initiated permission request instead.
  const [coords, setCoords] = useState<{ lat: number; lng: number; isVillage: boolean }>({ lat: SITE.lat, lng: SITE.lng, isVillage: true })
  const [locating, setLocating] = useState(false)
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [failed, setFailed] = useState(false)

  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error(t('wx.locationUnsupported')); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, isVillage: false }); setLocating(false) },
      () => { toast.error(t('wx.locationDenied')); setLocating(false) },
      { timeout: 10000 }
    )
  }

  useEffect(() => {
    setWeather(null)
    setFailed(false)
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}` +
      `&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m` +
      `&hourly=temperature_2m,weather_code,precipitation_probability` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset,wind_speed_10m_max` +
      `&timezone=auto&forecast_days=7`
    fetch(url).then((r) => r.json()).then((data) => {
      const nowIdx = data.hourly.time.findIndex((t: string) => new Date(t) >= new Date())
      const hourly: Hour[] = data.hourly.time.slice(nowIdx, nowIdx + 24).map((time: string, i: number) => ({
        time, temp: Math.round(data.hourly.temperature_2m[nowIdx + i]), code: data.hourly.weather_code[nowIdx + i],
        rainChance: data.hourly.precipitation_probability[nowIdx + i] ?? 0,
      }))
      const daily: Day[] = data.daily.time.map((date: string, i: number) => ({
        date, code: data.daily.weather_code[i], max: Math.round(data.daily.temperature_2m_max[i]), min: Math.round(data.daily.temperature_2m_min[i]),
        rainChance: data.daily.precipitation_probability_max[i] ?? 0, uv: Math.round(data.daily.uv_index_max[i]),
        sunrise: data.daily.sunrise[i], sunset: data.daily.sunset[i], windMax: Math.round(data.daily.wind_speed_10m_max[i]),
      }))
      setWeather({
        temp: Math.round(data.current.temperature_2m), feelsLike: Math.round(data.current.apparent_temperature),
        code: data.current.weather_code, humidity: Math.round(data.current.relative_humidity_2m),
        windKph: Math.round(data.current.wind_speed_10m), hourly, daily,
      })
    }).catch(() => setFailed(true))
  }, [coords])

  const alerts = weather?.daily.slice(0, 3).filter((d) => d.rainChance >= 70 || d.windMax >= 40) ?? []

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Sun size={26} className="text-amber-500" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('wx.pageTitle')}</h1>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-8">
        <p className="font-sans text-[13px] text-dp-on-surface-variant flex items-center gap-1.5">
          <MapPin size={13} /> {coords.isVillage ? t('wx.villageDefault') : t('wx.yourLocation')}
        </p>
        <button onClick={useMyLocation} disabled={locating}
          className="flex items-center gap-1.5 px-3.5 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-60">
          <LocateFixed size={14} /> {locating ? t('wx.locating') : t('wx.useMyLocation')}
        </button>
      </div>

      {failed && <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[15px]">{t('wx.loadFailed')}</p>}
      {!failed && !weather && <div className="text-center py-16"><LoadingDots /></div>}

      {weather && (
        <>
          {alerts.length > 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-8 flex gap-3">
              <AlertTriangle size={20} className="text-amber-700 shrink-0 mt-0.5" />
              <div className="font-sans text-[13px] text-amber-900 leading-relaxed">
                {alerts.map((d, i) => (
                  <p key={i}>
                    {new Date(d.date).toLocaleDateString(isUrdu ? 'ur-PK-u-nu-latn' : 'en-PK', { weekday: 'long' })}:{' '}
                    {d.rainChance >= 70 && `${t('wx.alertHeavyRain')} (${d.rainChance}%)`}
                    {d.rainChance >= 70 && d.windMax >= 40 && ' · '}
                    {d.windMax >= 40 && t('wx.alertStrongWind')}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Current conditions */}
          <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-8 flex items-center gap-5">
            {iconFor(weather.code, 56)}
            <div>
              <p className="font-heading text-[40px] font-bold text-dp-on-surface leading-none ltr-num">{weather.temp}°C</p>
              <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t(LABEL_KEY(weather.code))} · <span className="ltr-num">{t('wx.feelsLike')} {weather.feelsLike}°C</span></p>
            </div>
            <div className="ms-auto flex flex-col gap-1.5 text-end">
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-center gap-1.5 justify-end"><Droplets size={13} /> <span className="ltr-num">{weather.humidity}%</span> {t('wx.humidity')}</span>
              <span className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-center gap-1.5 justify-end"><Wind size={13} /> <span className="ltr-num">{weather.windKph} km/h</span></span>
            </div>
          </div>

          {/* Hourly */}
          <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">{t('wx.hourly')}</h2>
          <div className="flex gap-3 overflow-x-auto pb-2 mb-8 hide-scrollbar">
            {weather.hourly.map((h, i) => (
              <div key={i} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex flex-col items-center gap-1.5 shrink-0 w-[68px]">
                <span className="font-sans text-[11px] text-dp-on-surface-variant ltr-num">
                  {new Date(h.time).toLocaleTimeString(isUrdu ? 'ur-PK-u-nu-latn' : 'en-PK', { hour: 'numeric' })}
                </span>
                {iconFor(h.code, 20)}
                <span className="font-sans text-[13px] font-bold text-dp-on-surface ltr-num">{h.temp}°</span>
                {h.rainChance >= 30 && <span className="font-sans text-[10px] text-sky-600 ltr-num">{h.rainChance}%</span>}
              </div>
            ))}
          </div>

          {/* 7-day */}
          <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">{t('wx.sevenDay')}</h2>
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-8">
            {weather.daily.map((d, i) => (
              <div key={i} className={`flex items-center gap-3 px-4 py-3 ${i !== 0 ? 'border-t border-dp-outline-variant' : ''}`}>
                <span className="font-sans text-[13px] font-semibold text-dp-on-surface w-20 shrink-0">
                  {i === 0 ? t('wx.today') : new Date(d.date).toLocaleDateString(isUrdu ? 'ur-PK-u-nu-latn' : 'en-PK', { weekday: 'short' })}
                </span>
                {iconFor(d.code, 20)}
                {d.rainChance >= 30 && <span className="font-sans text-[11px] text-sky-600 ltr-num w-9 shrink-0">{d.rainChance}%</span>}
                <span className="font-sans text-[13px] text-dp-on-surface-variant ms-auto ltr-num">{d.min}° – {d.max}°</span>
              </div>
            ))}
          </div>

          {/* Sun + UV, from today's entry */}
          {weather.daily[0] && (
            <div className="grid grid-cols-3 gap-3 mb-8">
              <div className="bg-white border border-dp-outline-variant rounded-lg p-3 text-center">
                <Sunrise size={18} className="text-amber-500 mx-auto mb-1" />
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('wx.sunrise')}</p>
                <p className="font-sans text-[13px] font-bold text-dp-on-surface ltr-num">{new Date(weather.daily[0].sunrise).toLocaleTimeString(isUrdu ? 'ur-PK-u-nu-latn' : 'en-PK', { hour: 'numeric', minute: '2-digit' })}</p>
              </div>
              <div className="bg-white border border-dp-outline-variant rounded-lg p-3 text-center">
                <Sunset size={18} className="text-orange-500 mx-auto mb-1" />
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('wx.sunset')}</p>
                <p className="font-sans text-[13px] font-bold text-dp-on-surface ltr-num">{new Date(weather.daily[0].sunset).toLocaleTimeString(isUrdu ? 'ur-PK-u-nu-latn' : 'en-PK', { hour: 'numeric', minute: '2-digit' })}</p>
              </div>
              <div className="bg-white border border-dp-outline-variant rounded-lg p-3 text-center">
                <Sun size={18} className="text-amber-500 mx-auto mb-1" />
                <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('wx.uvIndex')}</p>
                <p className="font-sans text-[13px] font-bold text-dp-on-surface ltr-num">{weather.daily[0].uv}</p>
              </div>
            </div>
          )}

          {/* Weather map — real ask, 2026-10-01: "keep the same weather
              map actual that you deployed first time ... I want that map
              back" — restoring the original Windy embed (real wind/rain/
              pressure layers, not just our own radar-only Leaflet map).
              The one real issue it had — a detail sidebar that opened on
              marker click and couldn't be closed — is fixed this time by
              explicitly passing detail=false (the original URL left this
              param blank, which did not suppress it); confirmed via
              other real embed.windy.com URLs that set it explicitly. */}
          <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">{t('wx.map')}</h2>
          <div className="rounded-lg overflow-hidden border border-dp-outline-variant" style={{ height: 450 }}>
            <iframe
              title="weather-map"
              className="w-full h-full"
              src={`https://embed.windy.com/embed2.html?lat=${coords.lat}&lon=${coords.lng}&detailLat=${coords.lat}&detailLon=${coords.lng}&width=650&height=450&zoom=8&level=surface&overlay=rain&product=ecmwf&menu=&message=true&marker=true&calendar=now&pressure=&type=map&location=coordinates&detail=false&metricWind=default&metricTemp=default&radarRange=-1`}
              frameBorder="0"
            />
          </div>
        </>
      )}
    </div>
  )
}
