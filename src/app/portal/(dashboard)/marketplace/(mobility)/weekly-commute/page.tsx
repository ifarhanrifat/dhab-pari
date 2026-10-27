'use client'

// Real ask, 2026-10-27: a rider who works away from the village all
// week (out Monday, home Friday/Saturday) can save that recurring
// schedule once instead of re-running "Go Home" every week. Saving it
// here also feeds the driver-facing demand card (CityReturnDemandCard)
// — a driver deciding where to post or run a route sees "N riders
// waiting in [city], X% chance" without ever seeing who any of them
// are (rider_weekly_schedules, 743, is select-locked to its own owner;
// city_return_demand() only ever returns an aggregate).
//
// "Home" is never asked for — cities.is_home_city (429) already marks
// the one city every return leg in this app resolves to, so this page
// only ever asks which city the rider works in + which two days.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Briefcase, Trash2, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface City { id: string; name: string; name_ur: string | null }
interface MySchedule {
  id: string; work_city_id: string; city_name: string; city_name_ur: string | null
  depart_day_of_week: number; return_day_of_week: number
}

const DAYS = [0, 1, 2, 3, 4, 5, 6]

export default function WeeklyCommutePage() {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [cities, setCities] = useState<City[]>([])
  const [mySchedule, setMySchedule] = useState<MySchedule | null>(null)
  const [editing, setEditing] = useState(false)
  const [workCityId, setWorkCityId] = useState('')
  const [departDay, setDepartDay] = useState(1)
  const [returnDay, setReturnDay] = useState(5)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const [{ data: cityRows }, { data: sched }] = await Promise.all([
      supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order'),
      supabase.rpc('my_weekly_schedule'),
    ])
    setCities(cityRows ?? [])
    setMySchedule((sched as MySchedule) ?? null)
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = () => {
    setWorkCityId(mySchedule?.work_city_id ?? '')
    setDepartDay(mySchedule?.depart_day_of_week ?? 1)
    setReturnDay(mySchedule?.return_day_of_week ?? 5)
    setEditing(true)
  }

  const save = async () => {
    if (!workCityId) { toast.error(t('wc.pickCityError')); return }
    setSaving(true)
    const { error } = await supabase.rpc('save_my_weekly_schedule', {
      p_work_city_id: workCityId, p_depart_day_of_week: departDay, p_return_day_of_week: returnDay,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('wc.savedToast'))
    setEditing(false)
    load()
  }

  const cancelSchedule = async () => {
    if (!confirm(t('wc.confirmCancel'))) return
    const { error } = await supabase.rpc('cancel_my_weekly_schedule')
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('wc.cancelledToast'))
    load()
  }

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="flex flex-col gap-3">
      <button onClick={() => router.push('/portal/marketplace/travel')} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-[#166534] cursor-pointer self-start">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mb.whereToHeading')}
      </button>
      <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Briefcase size={19} /> {t('wc.pageTitle')}</h1>
      <p className="font-sans text-[13px] text-[#64748b]">{t('wc.pageSubtitle')}</p>

      {!editing && mySchedule ? (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 font-sans text-[13px] text-[#166534] font-bold"><CheckCircle2 size={16} /> {t('wc.currentScheduleHeading')}</div>
          <p className="font-sans text-[14px] text-[#1e293b]">
            📍 {isUrdu && mySchedule.city_name_ur ? mySchedule.city_name_ur : mySchedule.city_name}
          </p>
          <p className="font-sans text-[13px] text-[#64748b]">
            {t('wc.departsOnLabel')} <span className="font-semibold text-[#1e293b]">{t(`mv.dayShort.${mySchedule.depart_day_of_week}`)}</span>
            {' · '}{t('wc.returnsOnLabel')} <span className="font-semibold text-[#1e293b]">{t(`mv.dayShort.${mySchedule.return_day_of_week}`)}</span>
          </p>
          <div className="flex gap-2">
            <button onClick={startEdit} className="flex-1 py-2.5 rounded-xl border border-[#e5e2d0] text-[#166534] font-sans text-[13px] font-bold cursor-pointer">{t('action.edit')}</button>
            <button onClick={cancelSchedule} className="flex-1 py-2.5 rounded-xl border border-red-200 text-[#b91c1c] font-sans text-[13px] font-bold cursor-pointer flex items-center justify-center gap-1.5"><Trash2 size={14} /> {t('wc.cancelScheduleBtn')}</button>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 flex flex-col gap-3.5">
          {!mySchedule && <p className="font-sans text-[13px] text-[#64748b]">{t('wc.noScheduleYetHint')}</p>}

          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1.5 uppercase tracking-[0.05em]">{t('wc.workCityLabel')}</label>
            <div className="flex gap-1.5 flex-wrap">
              {cities.map((c) => (
                <button key={c.id} type="button" onClick={() => setWorkCityId(c.id)}
                  className="px-3 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border"
                  style={{ background: workCityId === c.id ? '#166534' : '#fff', color: workCityId === c.id ? '#fff' : '#334155', borderColor: workCityId === c.id ? '#166534' : '#e5e2d0' }}>
                  📍 {isUrdu && c.name_ur ? c.name_ur : c.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1.5 uppercase tracking-[0.05em]">{t('wc.departDayLabel')}</label>
            <div className="flex gap-1.5 flex-wrap">
              {DAYS.map((d) => (
                <button key={d} type="button" onClick={() => setDepartDay(d)}
                  className={`px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer ${departDay === d ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                  {t(`mv.dayShort.${d}`)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1.5 uppercase tracking-[0.05em]">{t('wc.returnDayLabel')}</label>
            <div className="flex gap-1.5 flex-wrap">
              {DAYS.map((d) => (
                <button key={d} type="button" onClick={() => setReturnDay(d)}
                  className={`px-2.5 py-1.5 rounded-lg font-sans text-[12px] font-semibold cursor-pointer ${returnDay === d ? 'bg-[#166534] text-white' : 'bg-[#F9F9F6] text-[#64748b] border border-[#e5e2d0]'}`}>
                  {t(`mv.dayShort.${d}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 mt-1">
            {editing && <button onClick={() => setEditing(false)} className="flex-1 py-2.5 rounded-xl border border-[#e5e2d0] text-[#64748b] font-sans text-[13px] font-bold cursor-pointer">{t('action.cancel')}</button>}
            <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13px] font-bold cursor-pointer disabled:opacity-50">
              {saving ? t('action.saving') : t('wc.saveBtn')}
            </button>
          </div>
        </div>
      )}

      <p className="font-sans text-[11.5px] text-[#94a3b8] leading-relaxed">{t('wc.privacyNote')}</p>
    </div>
  )
}
