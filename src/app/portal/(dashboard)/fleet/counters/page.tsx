'use client'

// 860: Counters sub-page, reached from the Dashboard tab's quick links.
// Same create-a-city-counter form as the old single-page fleet.tsx
// (855), unchanged logic, just moved to its own route.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Counter { id: string; city: string; name: string | null }

export default function FleetCountersPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [counters, setCounters] = useState<Counter[]>([])
  const [newCity, setNewCity] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const load = async () => {
    const { data: mine } = await supabase.rpc('my_managed_fleet')
    const f = mine as { fleet_id: string; is_owner: boolean } | null
    setFleetId(f?.fleet_id ?? null)
    setIsOwner(f?.is_owner ?? false)
    if (f) {
      const { data } = await supabase.rpc('my_fleet_counters', { p_fleet_id: f.fleet_id })
      setCounters((data ?? []) as Counter[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!user) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const createCounter = async () => {
    if (!fleetId || !newCity.trim()) { toast.error(t('mv.enterCounterCityError')); return }
    setCreating(true)
    const { error } = await supabase.rpc('create_fleet_counter', { p_fleet_id: fleetId, p_city: newCity, p_name: newName || null })
    setCreating(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.counterCreatedToast'))
    setNewCity(''); setNewName('')
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Link href="/portal/fleet" className="p-1 -ms-1 text-[#64748b]"><ChevronLeft size={18} className={isUrdu ? 'rotate-180' : ''} /></Link>
        <h1 className="font-bold text-[18px] text-dp-primary flex items-center gap-2"><Building2 size={17} /> {t('mv.bookingCountersHeading')}</h1>
      </div>

      {isOwner && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <div className="flex gap-2 mb-2.5">
            <input value={newCity} onChange={(e) => setNewCity(e.target.value)} placeholder={t('mv.counterCityPlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('mv.counterNameOptionalPlaceholder')}
              className="flex-1 px-3 py-2 border border-[#e5e2d0] rounded-lg font-sans text-[13px]" />
          </div>
          <button onClick={createCounter} disabled={creating} className="w-full px-4 py-2.5 rounded-xl bg-[#166534] text-white font-sans text-[13.5px] font-bold cursor-pointer disabled:opacity-50">
            {creating ? t('action.loading') : t('mv.addCounterBtn')}
          </button>
        </div>
      )}

      {counters.length === 0 ? (
        <p className="font-sans text-[12px] text-[#94a3b8] text-center py-6">{t('mv.noCountersYetHint')}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {counters.map((c) => (
            <div key={c.id} className="bg-white border border-[#e5e2d0] rounded-lg px-3 py-2.5">
              <span className="font-sans text-[13px] font-semibold text-[#1e293b]">{c.city}{c.name ? ` · ${c.name}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
