'use client'

// 879: real spec given live — "both drivers will now a floating button
// on there apps, after 8 hours if the driver want to shuffle they can
// shuffle." Mounted in my-vehicle/layout.tsx's Chrome so it's visible
// across the whole driver app, not just one sub-page.
//
// Known limitation, flagged rather than silently dropped: my-vehicle's
// whole layout only renders its Chrome for an account that owns a
// vehicle (my-vehicle/layout.tsx's own gate) — a co-driver who isn't
// registered as a driver themselves (no vehicle of their own anywhere)
// can't reach this screen to see the button at all. Covers the realistic
// case — a long-route co-driver is almost always a registered driver
// too — not the edge case of a co-driver with zero vehicle presence.

import { useEffect, useState } from 'react'
import { ArrowLeftRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface ShiftStatus {
  has_co_driver: boolean; is_assigned_driver?: boolean; run_active?: boolean
  route_run_id?: string; am_i_active_driver?: boolean
  active_driver_name?: string; other_driver_name?: string
  elapsed_hours?: number; min_shift_hours?: number; can_shuffle?: boolean
}

const POLL_MS = 60000

export function DriverShuffleFloatingButton() {
  const { t } = useLocale()
  const { user } = usePortalUser()
  const supabase = createClient()
  const [status, setStatus] = useState<ShiftStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [shuffling, setShuffling] = useState(false)

  const check = async () => {
    if (!user) return
    let routeId: string | null = null
    const { data: myVehicle } = await supabase.from('vehicles').select('id').eq('portal_user_id', user.id).maybeSingle()
    if (myVehicle) {
      const { data: route } = await supabase.from('vehicle_routes').select('id').eq('vehicle_id', (myVehicle as { id: string }).id).eq('is_active', true).maybeSingle()
      routeId = (route as { id: string } | null)?.id ?? null
    }
    if (!routeId) {
      const { data: coRoute } = await supabase.from('vehicle_routes').select('id').eq('co_driver_portal_user_id', user.id).eq('is_active', true).maybeSingle()
      routeId = (coRoute as { id: string } | null)?.id ?? null
    }
    if (!routeId) { setStatus(null); return }
    const { data } = await supabase.rpc('my_duty_shift_status', { p_route_id: routeId })
    setStatus(data as ShiftStatus | null)
  }

  useEffect(() => {
    if (!user) return
    check()
    const id = setInterval(check, POLL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const doShuffle = async () => {
    if (!status?.route_run_id) return
    setShuffling(true)
    const { error } = await supabase.rpc('shuffle_driver', { p_route_run_id: status.route_run_id })
    setShuffling(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.shiftHandedOffToast'))
    setConfirming(false)
    check()
  }

  if (!status?.run_active) return null

  return (
    <>
      <button onClick={() => setConfirming(true)}
        className="fixed z-[65] bottom-36 right-4 flex items-center gap-2 px-3.5 py-2.5 rounded-full shadow-lg cursor-pointer font-sans text-[12px] font-bold text-white"
        style={{ background: status.can_shuffle ? '#166534' : '#64748b' }}>
        <ArrowLeftRight size={15} />
        {status.am_i_active_driver ? t('mv.youAreDrivingLabel') : t('mv.otherDrivingLabel')} · {status.elapsed_hours}{t('mv.hoursShortSuffix')}
      </button>

      {confirming && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setConfirming(false)}>
          <div className="bg-white rounded-2xl max-w-[340px] w-full p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <p className="font-sans text-[14px] font-bold text-[#1e293b]">{t('mv.shuffleConfirmHeading')}</p>
              <button onClick={() => setConfirming(false)} className="text-[#64748b] cursor-pointer"><X size={17} /></button>
            </div>
            {status.am_i_active_driver ? (
              status.can_shuffle ? (
                <>
                  <p className="font-sans text-[12.5px] text-[#64748b] mb-3">{t('mv.shuffleConfirmBody').replace('{name}', status.other_driver_name ?? '')}</p>
                  <button onClick={doShuffle} disabled={shuffling} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13px] font-bold cursor-pointer disabled:opacity-50">
                    {shuffling ? t('action.loading') : t('mv.shuffleConfirmBtn')}
                  </button>
                </>
              ) : (
                <p className="font-sans text-[12.5px] text-[#b91c1c]">{t('mv.shuffleNotYetHint').replace('{min}', String(status.min_shift_hours)).replace('{elapsed}', String(status.elapsed_hours))}</p>
              )
            ) : (
              <p className="font-sans text-[12.5px] text-[#64748b]">{t('mv.shuffleOnlyActiveDriverHint').replace('{name}', status.active_driver_name ?? '')}</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
