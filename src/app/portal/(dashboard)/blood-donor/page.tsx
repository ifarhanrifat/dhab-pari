'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Droplet, ShieldCheck } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalHelp } from '@/components/portal/PortalHelp'
import { LoadingDots } from '@/components/shared/LoadingDots'

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

interface MyRequest {
  id: string; patient_name: string; blood_group: string; units_needed: number
  city: string; hospital: string; needed_on: string; needed_hour: number | null
  needed_period: string | null; status: string; created_at: string
  cancel_reason: string | null; donors_contacted: number; donors_said_yes: number
}

const MY_STATUS_KEY: Record<string, { key: string; cls: string }> = {
  pending_approval: { key: 'p.bloodStatusPendingApproval', cls: 'bg-amber-100 text-amber-800' },
  open: { key: 'p.bloodStatusOpen', cls: 'bg-rose-100 text-rose-700' },
  paused: { key: 'p.bloodStatusPaused', cls: 'bg-dp-surface-container-high text-dp-on-surface-variant' },
  fulfilled: { key: 'p.bloodStatusFulfilled', cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { key: 'p.bloodStatusCancelled', cls: 'bg-dp-surface-container-high text-dp-on-surface-variant' },
  expired: { key: 'p.bloodStatusExpired', cls: 'bg-dp-surface-container-high text-dp-on-surface-variant' },
}
const PERIOD_KEY: Record<string, string> = {
  subha: 'p.periodMorning', dopahar: 'p.periodAfternoon', shaam: 'p.periodEvening', raat: 'p.periodNight',
}

interface OpenRequest {
  id: string; blood_group: string; units_needed: number; hospital: string; city: string
  needed_on: string; needed_time: string | null; status: string; response: string
}

// A donor may not give again for 12 weeks (16 for women). Showing the date they
// become eligible is kinder than silently hiding them, and stops people
// wondering why they are never called.
function coolOffDays(gender: string) { return gender === 'female' ? 112 : 84 }

function fmtDay(d: string) {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

export default function PortalBloodDonorPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [registered, setRegistered] = useState(false)
  const [bloodGroup, setBloodGroup] = useState('')
  const [sector, setSector] = useState('')
  const [isAvailable, setIsAvailable] = useState(true)
  const [gender, setGender] = useState('')
  const [city, setCity] = useState('')
  const [allowThanks, setAllowThanks] = useState(false)
  const [lastDonation, setLastDonation] = useState<string | null>(null)
  const [availableFrom, setAvailableFrom] = useState<string | null>(null)
  const [openRequests, setOpenRequests] = useState<OpenRequest[]>([])
  const [myRequests, setMyRequests] = useState<MyRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    ;(async () => {
      // Runs whether or not they are a registered donor: anyone with an account
      // can raise a request, and the answer belongs to them either way.
      const { data: mine } = await supabase.rpc('my_blood_requests')
      setMyRequests((mine ?? []) as MyRequest[])

      const { data } = await supabase
        .from('blood_donors')
        .select('id, blood_group, sector, is_available, gender, city, allow_public_thanks, last_donation_date')
        .eq('portal_user_id', user.id).maybeSingle()
      if (data) {
        setRegistered(true)
        setBloodGroup(data.blood_group)
        setSector(data.sector ?? '')
        setIsAvailable(data.is_available)
        setGender(data.gender ?? '')
        setCity(data.city ?? '')
        setAllowThanks(!!data.allow_public_thanks)
        setLastDonation(data.last_donation_date)
        if (data.last_donation_date) {
          const from = new Date(data.last_donation_date)
          from.setDate(from.getDate() + coolOffDays(data.gender ?? ''))
          setAvailableFrom(from.toISOString().slice(0, 10))
        }

        // RLS returns only this donor's own contact rows.
        const { data: rows } = await supabase
          .from('blood_request_contacts')
          .select('response, blood_requests(id, blood_group, units_needed, hospital, city, needed_on, needed_time, status)')
          .is('stood_down_at', null)
        setOpenRequests(
          (rows ?? []).flatMap((c) => {
            const br = Array.isArray(c.blood_requests) ? c.blood_requests[0] : c.blood_requests
            if (!br || !['open', 'paused'].includes(br.status as string)) return []
            return [{ ...(br as Omit<OpenRequest, 'response'>), response: c.response as string }]
          })
        )
      }
      setLoading(false)
    })()
  }, [user])

  const save = async () => {
    if (!user || !bloodGroup) { toast.error(t('p.selectBloodGroup')); return }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('blood_donors').upsert(
      {
        portal_user_id: user.id, blood_group: bloodGroup, sector: sector || null,
        is_available: isAvailable, gender: gender || null, city: city || null,
        allow_public_thanks: allowThanks, updated_at: new Date().toISOString(),
      },
      { onConflict: 'portal_user_id' }
    )
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.saved'))
    setRegistered(true)
  }

  const remove = async () => {
    if (!user) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('blood_donors').delete().eq('portal_user_id', user.id)
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('p.removedFromRegistry'))
    setRegistered(false)
    setBloodGroup('')
    setSector('')
  }

  const respond = async (requestId: string, answer: 'yes' | 'no') => {
    const supabase = createClient()
    const { error } = await supabase.rpc('respond_to_blood_request', { p_request_id: requestId, p_response: answer })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(answer === 'yes' ? t('p.thankYouWillContact') : t('p.notedThankYou'))
    setOpenRequests((prev) => prev.map((r) => r.id === requestId ? { ...r, response: answer } : r))
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Droplet size={22} className="text-dp-error" /> {t('p.bloodRegistration')} <PortalHelp pageKey="bloodDonor" /></h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.bloodRegBlurb')}</p>
      </div>

      {/* Requests this user raised themselves. Separate from the matched-donor
          list below: one is "can you help?", this is "what happened to mine?" */}
      {myRequests.length > 0 && (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 max-w-md">
          <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-2">{t('p.myBloodRequests')}</h2>
          <div className="space-y-3">
            {myRequests.map((r) => {
              const st = MY_STATUS_KEY[r.status] ?? { key: '', cls: 'bg-dp-surface-container text-dp-on-surface-variant' }
              const stLabel = st.key ? t(st.key) : r.status
              return (
                <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className="font-heading text-[16px] font-bold text-dp-on-surface">
                      {r.blood_group} · {r.units_needed} unit{r.units_needed > 1 ? 's' : ''}
                    </span>
                    <span className={`text-[10.5px] font-bold uppercase px-2 py-1 rounded-full font-sans shrink-0 ${st.cls}`}>{stLabel}</span>
                  </div>
                  <p className="font-sans text-[13px] text-dp-on-surface-variant">
                    {t('p.forPatient')} {r.patient_name} · {r.hospital}, {r.city}
                  </p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                    {fmtDay(r.needed_on)}
                    {r.needed_hour && r.needed_period
                      ? t('p.atHourInPeriod').replace('%%hour%%', String(r.needed_hour)).replace('%%period%%', t(PERIOD_KEY[r.needed_period] ?? ''))
                      : ''}
                  </p>

                  {r.status === 'pending_approval' && (
                    <p className="font-sans text-[12.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-2">
                      {t('p.bloodApprovalPendingNote')}
                    </p>
                  )}

                  {/* Counts only — who was asked and who declined is not the
                      requester's business, but "11 contacted, 3 said yes" is
                      what stops them panicking. */}
                  {['open', 'paused', 'fulfilled'].includes(r.status) && (
                    <div className="flex gap-4 mt-2 pt-2 border-t border-dp-outline-variant/60">
                      <div>
                        <p className="font-sans text-[18px] font-bold text-dp-on-surface leading-none">{r.donors_contacted}</p>
                        <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('p.donorsContacted')}</p>
                      </div>
                      <div>
                        <p className="font-sans text-[18px] font-bold text-dp-secondary leading-none">{r.donors_said_yes}</p>
                        <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('p.saidYes')}</p>
                      </div>
                    </div>
                  )}

                  {r.status === 'cancelled' && r.cancel_reason && (
                    <p className="font-sans text-[12.5px] text-dp-error mt-2">{t('p.reasonLabel')}: {r.cancel_reason}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Requests the committee has matched to this donor. Nothing about the
          patient is shown — only what a donor needs to answer yes or no. */}
      {openRequests.length > 0 && (
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-6 max-w-md space-y-3">
          {openRequests.map((r) => (
            <div key={r.id} className="bg-white border-2 border-dp-error rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-heading text-[17px] font-bold text-dp-error">{t('p.bloodNeeded').replace('%%group%%', r.blood_group)}</span>
                <span className="font-sans text-[12px] text-dp-on-surface-variant">{r.units_needed} unit{r.units_needed > 1 ? 's' : ''}</span>
              </div>
              <p className="font-sans text-[13.5px] text-dp-on-surface mb-1">{r.hospital}, {r.city}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">
                {t('p.neededOn')} {fmtDay(r.needed_on)}{r.needed_time ? ` at ${r.needed_time}` : ''}
              </p>

              {r.status === 'paused' ? (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2">
                  {t('p.requestOnHold')}
                </p>
              ) : r.response === 'pending' ? (
                <div className="flex gap-2">
                  <button onClick={() => respond(r.id, 'yes')} className="flex-1 bg-dp-error text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:opacity-90 transition-all">
                    {t('p.yesCanDonate')}
                  </button>
                  <button onClick={() => respond(r.id, 'no')} className="flex-1 border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all">
                    {t('p.notThisTime')}
                  </button>
                </div>
              ) : (
                <p className={`font-sans text-[13px] font-semibold ${r.response === 'yes' ? 'text-dp-secondary' : 'text-dp-on-surface-variant'}`}>
                  {r.response === 'yes' ? t('p.answeredYesNote') : t('p.answeredNoNote')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-md">
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-4 flex items-center gap-2 text-[12.5px] font-sans text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2.5">
          <ShieldCheck size={15} className="text-dp-secondary shrink-0" />
          {t('p.bloodPrivacyNote')}
        </div>

        <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.bloodGroup')}</label>
          <div className="grid grid-cols-4 gap-2">
            {GROUPS.map((g) => (
              <button key={g} type="button" onClick={() => setBloodGroup(g)}
                className={`py-2 rounded-lg font-sans text-[14px] font-bold cursor-pointer transition-all ${bloodGroup === g ? 'bg-dp-error text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-error'}`}>
                {g}
              </button>
            ))}
          </div>
        </div>

        {/* The safe gap between donations is longer for women, so this is not an
            optional nicety — without it the register would call people back too
            soon. */}
        <div dir={isUrdu ? 'rtl' : 'ltr'} className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.gender')}</label>
          <div className="grid grid-cols-2 gap-2">
            {[{ v: 'male', l: 'Male / مرد' }, { v: 'female', l: 'Female / خاتون' }].map((o) => (
              <button key={o.v} type="button" onClick={() => setGender(o.v)}
                className={`py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${gender === o.v ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary'}`}>
                {o.l}
              </button>
            ))}
          </div>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">{t('p.donationGapNote')}</p>
        </div>

        <div dir={isUrdu ? 'rtl' : 'ltr'} className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('p.cityTown')}</label>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder={t('p.egChakwal')} className="input-field" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.sectorOptional')}</label>
            <input value={sector} onChange={(e) => setSector(e.target.value)} className="input-field" />
          </div>
        </div>

        <label dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-center gap-2 cursor-pointer mb-3">
          <input type="checkbox" checked={isAvailable} onChange={(e) => setIsAvailable(e.target.checked)} className="accent-dp-secondary" />
          <span className="font-sans text-[14px]">{t('p.currentlyAvailable')}</span>
        </label>

        <label dir={isUrdu ? 'rtl' : 'ltr'} className="flex items-start gap-2 cursor-pointer mb-6">
          <input type="checkbox" checked={allowThanks} onChange={(e) => setAllowThanks(e.target.checked)} className="accent-dp-secondary mt-0.5" />
          <span className="font-sans text-[13.5px]">
            {t('p.allowPublicThanks')}
            <span className="block text-[11.5px] text-dp-on-surface-variant">{t('p.thanksAnonymousNote')}</span>
          </span>
        </label>

        {availableFrom && (
          <div dir={isUrdu ? 'rtl' : 'ltr'} className={`mb-6 rounded-lg px-3 py-2.5 font-sans text-[12.5px] ${availableFrom > new Date().toISOString().slice(0, 10) ? 'bg-dp-error/10 text-dp-error' : 'bg-dp-secondary/10 text-dp-secondary'}`}>
            {availableFrom > new Date().toISOString().slice(0, 10)
              ? t('p.lastDonatedEligibleOn').replace('%%date%%', fmtDay(lastDonation!)).replace('%%date2%%', fmtDay(availableFrom))
              : t('p.lastDonatedEligibleNow').replace('%%date%%', fmtDay(lastDonation!))}
          </div>
        )}

        <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 mb-2">
          {saving ? t('p.saving') : registered ? t('p.update') : t('p.registerAsBloodDonor')}
        </button>
        {registered && (
          <button onClick={remove} disabled={saving} className="w-full border border-dp-outline-variant text-dp-on-surface-variant py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all disabled:opacity-50">
            {t('p.removeRegistration')}
          </button>
        )}
      </div>
    </div>
  )
}
