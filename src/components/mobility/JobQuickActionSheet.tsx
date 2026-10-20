'use client'

// Real ask, 2026-10-20: "the vehical system should work like real app
// style like a popup window like the request appear in the screen with
// same like other modern apps." The driver's Jobs tab was the one clear
// gap — every row navigated to a whole separate page just to accept or
// decline a single request, exactly the "incoming ride request" moment
// every real driver app (Uber/Careem/inDrive) shows as a popup over
// whatever screen you're already on. This is that popup: Accept/Decline
// call the exact same RPCs each vertical's own page already uses — no
// new backend, no change to those pages. Anything beyond accept/decline
// (starting a trip needs the PIN modal already built on that vertical's
// page, chat needs the full thread) still goes through "View full
// details" — a deliberate step deeper, not the only option any more.

import { useState } from 'react'
import Link from 'next/link'
import { Check, X as XIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

export type QuickActionKind = 'hourly' | 'rental' | 'equipment' | 'shadi' | 'route'
export interface QuickActionRow {
  id: string
  type: QuickActionKind
  title: string
  subtitle: string
  amount: number | null
  href: string
  needsAction: boolean
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

async function respond(kind: QuickActionKind, id: string, accept: boolean) {
  const supabase = createClient()
  switch (kind) {
    case 'hourly': return supabase.rpc('respond_hourly_booking', { p_booking_id: id, p_accept: accept })
    case 'rental': return supabase.rpc('respond_rental_booking', { p_booking_id: id, p_accept: accept })
    case 'equipment': return supabase.rpc('respond_equipment_booking', { p_booking_id: id, p_accept: accept })
    case 'shadi': return supabase.rpc('respond_shadi_request', { p_request_id: id, p_accept: accept })
    case 'route': return accept
      ? supabase.rpc('confirm_ride_booking', { p_booking_id: id })
      : supabase.rpc('reject_ride_booking', { p_booking_id: id })
  }
}

interface Props { row: QuickActionRow; onClose: () => void; onDone: () => void }

export function JobQuickActionSheet({ row, onClose, onDone }: Props) {
  const { t } = useLocale()
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)

  const act = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'decline')
    const { error } = await respond(row.type, row.id, accept)
    setBusy(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(accept ? t('vp.jobAcceptedToast') : t('vp.jobDeclinedToast'))
    onDone()
    onClose()
  }

  return (
    <MobilityBottomSheet title={row.title} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="bg-[#F9F9F6] rounded-xl p-3">
          <p className="font-sans text-[13.5px] font-semibold text-[#1e293b]">{row.subtitle}</p>
          {row.amount != null && <p className="font-sans text-[16px] font-extrabold text-[#166534] ltr-num mt-1">₨{fmt(row.amount)}</p>}
        </div>

        {row.needsAction ? (
          <div className="flex items-center gap-2">
            <button onClick={() => act(false)} disabled={busy !== null}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-[#e5e2d0] text-[#b91c1c] font-sans text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">
              {busy === 'decline' ? <Loader2 size={15} className="animate-spin" /> : <XIcon size={15} />} {t('vp.declineBtn')}
            </button>
            <button onClick={() => act(true)} disabled={busy !== null}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-semibold cursor-pointer disabled:opacity-50">
              {busy === 'accept' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('vp.acceptBtn')}
            </button>
          </div>
        ) : (
          <p className="text-center font-sans text-[12.5px] text-[#64748b]">{t('vp.openFullDetailsHint')}</p>
        )}

        <Link href={row.href} onClick={onClose} className="text-center font-sans text-[12.5px] font-semibold text-[#64748b] underline">
          {t('vp.viewFullDetailsBtn')}
        </Link>
      </div>
    </MobilityBottomSheet>
  )
}
