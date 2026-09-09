'use client'

// Committee review of shadi (wedding) booking advances (478) — the one
// financial touchpoint in the whole shadi flow. Same announce/confirm
// shape as vehicle & shop wallet top-ups: the booker already announced
// a payment with proof; staff here either post the voucher or reject
// with a reason so the booker can try again.

import { useEffect, useState } from 'react'
import NextImage from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { CheckCircle, XCircle, Users2, CalendarDays, MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Request { id: string; status: string; full_day_rate_pkr: number; vehicles: { owner_name: string } | null }
interface Event {
  id: string; event_date: string; venue_address: string; distance_km: number; status: string
  advance_pct: number | null; advance_amount_pkr: number | null; advance_method: string | null; advance_proof_url: string | null
  advance_announced_at: string | null; created_at: string
  portal_users: { full_name: string; mobile: string | null } | null
  shadi_vehicle_requests: Request[]
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export default function AdminShadiBookingsPage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const [pending, setPending] = useState<Event[]>([])
  const [history, setHistory] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const cols = 'id, event_date, venue_address, distance_km, status, advance_pct, advance_amount_pkr, advance_method, advance_proof_url, advance_announced_at, created_at, portal_users(full_name, mobile), shadi_vehicle_requests(id, status, full_day_rate_pkr, vehicles(owner_name))'
    const [{ data: p }, { data: h }] = await Promise.all([
      supabase.from('shadi_events').select(cols).eq('status', 'advance_announced').order('advance_announced_at', { ascending: true }),
      supabase.from('shadi_events').select(cols).in('status', ['confirmed', 'cancelled']).order('created_at', { ascending: false }).limit(30),
    ])
    const pendingList = (p ?? []) as unknown as Event[]
    setPending(pendingList)
    setHistory((h ?? []) as unknown as Event[])
    setLoading(false)

    const urls: Record<string, string> = {}
    await Promise.all(pendingList.map(async (e) => {
      if (!e.advance_proof_url) return
      const { data: signed } = await supabase.storage.from('donation_receipts').createSignedUrl(e.advance_proof_url, 300)
      if (signed) urls[e.id] = signed.signedUrl
    }))
    setSignedUrls(urls)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const confirm_ = async (id: string) => {
    setBusyId(id)
    const { error } = await supabase.rpc('confirm_shadi_advance', { p_event_id: id })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sb.confirmedToast'))
    load()
  }

  const reject = async (id: string) => {
    const reason = prompt(t('sb.rejectReasonPrompt')) ?? ''
    setBusyId(id)
    const { error } = await supabase.rpc('reject_shadi_advance', { p_event_id: id, p_reason: reason || null })
    setBusyId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sb.rejectedToast'))
    load()
  }

  if (access.loading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('sb.noAccessMessage')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><Users2 size={26} /> {t('sb.pageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('sb.pageSubtitle')}</p>
      </div>

      <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant mb-3">{t('sb.awaitingConfirmationHeading')}</p>
      {pending.length === 0 ? (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center mb-8">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('sb.noPendingAdvances')}</p>
        </div>
      ) : (
        <div className="space-y-4 mb-8">
          {pending.map((e) => {
            const accepted = e.shadi_vehicle_requests.filter((r) => r.status === 'accepted')
            return (
              <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg p-5 flex flex-col md:flex-row gap-5">
                {signedUrls[e.id] && (
                  <a href={signedUrls[e.id]} target="_blank" rel="noopener noreferrer" className="relative shrink-0 w-full md:w-40 h-40 block">
                    <NextImage src={signedUrls[e.id]} alt="Payment slip" fill sizes="160px" className="object-cover rounded-lg border border-dp-outline-variant" />
                  </a>
                )}
                <div className="flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-sans text-[15px] font-bold text-dp-on-surface">{e.portal_users?.full_name ?? '—'} {e.portal_users?.mobile ? <span className="text-dp-on-surface-variant font-normal">· {e.portal_users.mobile}</span> : null}</p>
                      <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1.5"><CalendarDays size={12} /> {new Date(e.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · {e.advance_method}</p>
                      <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5 flex items-center gap-1.5"><MapPin size={12} /> {e.venue_address}</p>
                    </div>
                    <p className="font-heading text-[20px] font-bold text-dp-secondary shrink-0 ltr-num">{fmt(e.advance_amount_pkr ?? 0)}</p>
                  </div>
                  <div className="mt-2 pt-2 border-t border-dp-outline-variant">
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-1">{t('sb.acceptedVehiclesLabel')} ({e.advance_pct}%)</p>
                    {accepted.map((r) => (
                      <p key={r.id} className="font-sans text-[12.5px] text-dp-on-surface flex items-center justify-between ltr-num">
                        <span>{r.vehicles?.owner_name}</span><span>{fmt(r.full_day_rate_pkr)}</span>
                      </p>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => confirm_(e.id)} disabled={busyId === e.id} className="flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                      <CheckCircle size={14} /> {t('sb.confirmBtn')}
                    </button>
                    <button onClick={() => reject(e.id)} disabled={busyId === e.id} className="flex items-center gap-1.5 px-4 py-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-surface-container transition-all disabled:opacity-50">
                      <XCircle size={14} /> {t('sb.rejectBtn')}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="font-sans text-[12px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant mb-3">{t('sb.historyHeading')}</p>
      {history.length === 0 ? (
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('sb.noHistoryYet')}</p>
      ) : (
        <div className="space-y-2">
          {history.map((e) => (
            <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex items-center justify-between gap-3">
              <div>
                <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{e.portal_users?.full_name ?? '—'} — {new Date(e.event_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{e.venue_address}</p>
              </div>
              <div className="text-end shrink-0">
                <p className="font-sans text-[10.5px] font-bold" style={{ color: e.status === 'confirmed' ? '#0f7a4d' : '#6b6560' }}>{e.status === 'confirmed' ? t('sb.confirmedLabel') : t('sb.cancelledLabel')}</p>
                {e.status === 'confirmed' && <p className="font-heading text-[14px] font-bold text-dp-secondary ltr-num">{fmt(e.advance_amount_pkr ?? 0)}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
