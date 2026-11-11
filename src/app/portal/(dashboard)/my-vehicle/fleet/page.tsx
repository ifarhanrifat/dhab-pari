'use client'

// 853: self-service fleet management — real ask, confirmed via two
// clarifying questions: fleet creation is fully self-service (no admin
// step at all), and every unit under a fleet still gets its own driver
// login (same per-vehicle model buses already use) rather than one
// shared login. This page is where an owner creates their fleet and
// invites a driver (by phone, via a short code — see this migration's
// header for why a code, not a phone match) for a new bus or machine;
// the invited driver redeems the code on /portal/my-vehicle/register,
// then registers exactly as any solo driver always has — same
// documents, same admin review, same committee-set fare/commission —
// and their resulting vehicle is automatically tagged into this fleet.

import { useEffect, useState } from 'react'
import { Users2, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface FleetVehicle { id: string; owner_name: string; vehicle_type: string; vehicle_number: string | null }
interface Invite { id: string; invited_phone: string; created_at: string; expires_at: string; redeemed_at: string | null; vehicle_id: string | null }

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function MyFleetPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [fleetName, setFleetName] = useState('')
  const [newFleetName, setNewFleetName] = useState('')
  const [creating, setCreating] = useState(false)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [invitePhone, setInvitePhone] = useState('')
  const [inviting, setInviting] = useState(false)
  const [lastCode, setLastCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    const { data: fleets } = await supabase.rpc('my_fleets')
    const mine = (fleets as { id: string; name: string }[] | null)?.[0] ?? null
    setFleetId(mine?.id ?? null)
    setFleetName(mine?.name ?? '')
    if (mine) {
      const [{ data: v }, { data: inv }] = await Promise.all([
        supabase.rpc('my_fleet_vehicles'),
        supabase.rpc('my_fleet_invites', { p_fleet_id: mine.id }),
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

  const createFleet = async () => {
    if (!newFleetName.trim()) { toast.error(t('mv.fleetNameRequiredError')); return }
    setCreating(true)
    const { error } = await supabase.rpc('create_my_fleet', { p_name: newFleetName })
    setCreating(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.fleetCreatedToast'))
    setNewFleetName('')
    load()
  }

  const inviteDriver = async () => {
    if (!fleetId || !invitePhone.trim()) { toast.error(t('mv.enterDriverPhoneError')); return }
    setInviting(true)
    const { data, error } = await supabase.rpc('invite_fleet_driver', { p_fleet_id: fleetId, p_phone: invitePhone })
    setInviting(false)
    if (error) { toast.error(friendlyError(error)); return }
    setLastCode(data as string)
    setInvitePhone('')
    load()
  }

  const copyCode = () => {
    if (!lastCode) return
    navigator.clipboard?.writeText(lastCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Users2 size={19} /> {t('mv.myFleetHeading')}</h1>

      {!fleetId ? (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <p className="font-sans text-[13px] text-[#64748b] mb-3">{t('mv.noFleetYetHint')}</p>
          <label className="block font-sans text-[11.5px] font-bold text-[#64748b] mb-1">{t('mv.fleetNameLabel')}</label>
          <input value={newFleetName} onChange={(e) => setNewFleetName(e.target.value)} placeholder={t('mv.fleetNamePlaceholder')}
            className="w-full px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px] mb-2.5" />
          <button onClick={createFleet} disabled={creating} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {creating ? t('action.loading') : t('mv.createFleetBtn')}
          </button>
        </div>
      ) : (
        <>
          <p className="font-sans text-[14px] font-bold text-[#1e293b]">{fleetName}</p>

          <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2">{t('mv.inviteDriverHeading')}</p>
            <p className="font-sans text-[11.5px] text-[#64748b] mb-2.5">{t('mv.inviteDriverHint')}</p>
            <div className="flex gap-2">
              <input value={invitePhone} onChange={(e) => setInvitePhone(e.target.value)} placeholder={t('mv.driverPhonePlaceholder')}
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

          {invites.length > 0 && (
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
        </>
      )}
    </div>
  )
}
