'use client'

// 860: Invite-a-driver sub-page, reached from the Dashboard tab's quick
// links — unchanged logic from the old single-page fleet.tsx (853), just
// moved to its own route. Also lists the fleet's own vehicles, since
// "which vehicles do I already have" belongs right next to "invite one
// more."

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, UserPlus, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
interface Invite { id: string; invited_phone: string; expires_at: string; redeemed_at: string | null; vehicle_id: string | null }

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function FleetInvitePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [phone, setPhone] = useState('')
  const [inviting, setInviting] = useState(false)
  const [lastCode, setLastCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f) {
      const [{ data: v }, { data: inv }] = await Promise.all([
        supabase.rpc('my_fleet_vehicles'),
        f.is_owner ? supabase.rpc('my_fleet_invites', { p_fleet_id: f.fleet_id }) : Promise.resolve({ data: [] }),
      ])
      setVehicles((v ?? []) as FleetVehicle[])
      setInvites((inv ?? []) as Invite[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const inviteDriver = async () => {
    if (!fleetId || !phone.trim()) { toast.error(t('mv.enterDriverPhoneError')); return }
    setInviting(true)
    const { data, error } = await supabase.rpc('invite_fleet_driver', { p_fleet_id: fleetId, p_phone: phone })
    setInviting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setLastCode(data as string)
    setPhone('')
    load()
  }

  const copyCode = () => {
    if (!lastCode) return
    navigator.clipboard?.writeText(lastCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><UserPlus size={17} /> {t('mv.inviteDriverHeading')}</h1>
      </div>

      {isOwner && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.inviteDriverHint')}</p>
          <div className="flex gap-2">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('mv.driverPhonePlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] ltr-num" />
            <button onClick={inviteDriver} disabled={inviting} className="shrink-0 px-4 py-2 rounded-lg bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
              {inviting ? t('action.loading') : t('mv.sendInviteBtn')}
            </button>
          </div>
          {lastCode && (
            <div className="mt-3 bg-[#F0FDF4] border border-[#bbf7d0] rounded-lg p-3 flex items-center justify-between gap-2">
              <div>
                <p className="font-sans text-[11px] text-[#166534]">{t('mv.shareThisCodeHint')}</p>
                <p className="font-sans text-[22px] font-extrabold text-[#166534] ltr-num tracking-wider">{lastCode}</p>
              </div>
              <button onClick={copyCode} className="shrink-0 p-2 rounded-lg border border-[#bbf7d0] cursor-pointer text-[#166534]" aria-label={t('action.copy')}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
          )}
        </div>
      )}

      {isOwner && invites.length > 0 && (
        <div>
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('mv.pendingInvitesHeading')}</p>
          <div className="flex flex-col gap-1.5">
            {invites.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 bg-white border border-[#e5e2d0] rounded-lg px-3 py-2">
                <span className="font-sans text-[12.5px] font-semibold text-[#1e293b] ltr-num">{i.invited_phone}</span>
                <span className="font-sans text-[11px] font-bold ltr-num" style={{ color: i.vehicle_id ? '#166534' : i.redeemed_at ? '#b45309' : '#94a3b8' }}>
                  {i.vehicle_id ? t('mv.inviteStatusVehicleAdded') : i.redeemed_at ? t('mv.inviteStatusRedeemed') : t('mv.inviteStatusPending') + ' · ' + fmtDate(i.expires_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {vehicles.length > 0 && (
        <div>
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-1.5">{t('mv.fleetVehiclesHeading')}</p>
          <div className="flex flex-col gap-1.5">
            {vehicles.map((v) => (
              <div key={v.id} className="bg-white border border-[#e5e2d0] rounded-lg px-3 py-2">
                <p className="font-sans text-[12.5px] font-semibold text-[#1e293b]">{v.owner_name}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}</p>
                {v.vehicle_number && <p className="font-sans text-[11px] text-[#64748b] ltr-num">{v.vehicle_number}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
