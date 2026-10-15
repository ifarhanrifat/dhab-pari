'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { toast } from 'sonner'
import { AlertTriangle, Megaphone, Send, Ban, Clock } from 'lucide-react'

interface Tenant {
  id: string
  name: string
  name_ur: string | null
}

interface Broadcast {
  id: string
  severity: 'emergency' | 'ilaan'
  title_ur: string
  title_en: string | null
  body_ur: string
  body_en: string | null
  target_tenant_ids: string[] | null
  starts_at: string
  expires_at: string | null
  is_active: boolean
  created_at: string
}

export default function EmergencyAdminHomePage() {
  const supabase = createClient()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([])
  const [loadingList, setLoadingList] = useState(true)

  const [severity, setSeverity] = useState<'emergency' | 'ilaan'>('ilaan')
  const [titleUr, setTitleUr] = useState('')
  const [titleEn, setTitleEn] = useState('')
  const [bodyUr, setBodyUr] = useState('')
  const [bodyEn, setBodyEn] = useState('')
  const [targetAll, setTargetAll] = useState(true)
  const [pickedTenants, setPickedTenants] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)

  const load = async () => {
    const [{ data: t }, { data: b }] = await Promise.all([
      supabase.from('tenants').select('id, name, name_ur').order('name'),
      supabase
        .from('emergency_broadcasts')
        .select('id, severity, title_ur, title_en, body_ur, body_en, target_tenant_ids, starts_at, expires_at, is_active, created_at')
        .order('created_at', { ascending: false })
        .limit(50),
    ])
    setTenants(t ?? [])
    setBroadcasts((b ?? []) as Broadcast[])
    setLoadingList(false)
  }

  useEffect(() => { load() }, [])

  const toggleTenant = (id: string) => {
    setPickedTenants((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const send = async () => {
    if (!titleUr.trim() || !bodyUr.trim()) {
      toast.error('Urdu title and message are required.')
      return
    }
    if (!targetAll && pickedTenants.size === 0) {
      toast.error('Pick at least one village, or switch to "All villages".')
      return
    }
    setSending(true)
    try {
      const { error } = await supabase.rpc('broadcast_emergency_alert', {
        p_severity: severity,
        p_title_ur: titleUr.trim(),
        p_body_ur: bodyUr.trim(),
        p_title_en: titleEn.trim() || null,
        p_body_en: bodyEn.trim() || null,
        p_target_tenant_ids: targetAll ? null : Array.from(pickedTenants),
      })
      if (error) throw error
      toast.success('Broadcast sent.')
      setTitleUr(''); setTitleEn(''); setBodyUr(''); setBodyEn('')
      setTargetAll(true); setPickedTenants(new Set())
      await load()
    } catch (e) {
      toast.error(friendlyError(e))
    }
    setSending(false)
  }

  const deactivate = async (id: string) => {
    try {
      const { error } = await supabase.from('emergency_broadcasts').update({ is_active: false }).eq('id', id)
      if (error) throw error
      toast.success('Broadcast withdrawn.')
      await load()
    } catch (e) {
      toast.error(friendlyError(e))
    }
  }

  const targetLabel = (b: Broadcast) => {
    if (!b.target_tenant_ids || b.target_tenant_ids.length === 0) return 'All villages'
    const names = b.target_tenant_ids.map((id) => tenants.find((t) => t.id === id)?.name ?? id)
    return names.join(', ')
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-[22px] font-bold text-dp-on-surface">Post a broadcast</h1>
        <p className="text-dp-on-surface-variant text-[13.5px] font-sans mt-0.5">
          Reaches every portal user in the targeted villages immediately, as a push notification and a banner on their portal.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-dp-outline-variant p-5 space-y-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSeverity('emergency')}
            className={`flex-1 py-2.5 rounded-lg text-[14px] font-sans font-bold transition-colors ${
              severity === 'emergency' ? 'bg-dp-error text-white' : 'bg-dp-surface-variant text-dp-on-surface-variant'
            }`}
          >
            🚨 Emergency
          </button>
          <button
            type="button"
            onClick={() => setSeverity('ilaan')}
            className={`flex-1 py-2.5 rounded-lg text-[14px] font-sans font-bold transition-colors ${
              severity === 'ilaan' ? 'bg-amber-400 text-black' : 'bg-dp-surface-variant text-dp-on-surface-variant'
            }`}
          >
            📢 Ilaan
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[12.5px] font-bold text-dp-on-surface-variant mb-1.5 font-sans">Title (Urdu) *</label>
            <input
              value={titleUr}
              onChange={(e) => setTitleUr(e.target.value)}
              dir="rtl"
              className="w-full px-3.5 py-2.5 border-2 border-dp-outline-variant rounded-lg font-sans text-[15px]"
              placeholder="عنوان"
            />
          </div>
          <div>
            <label className="block text-[12.5px] font-bold text-dp-on-surface-variant mb-1.5 font-sans">Title (English)</label>
            <input
              value={titleEn}
              onChange={(e) => setTitleEn(e.target.value)}
              className="w-full px-3.5 py-2.5 border-2 border-dp-outline-variant rounded-lg font-sans text-[15px]"
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[12.5px] font-bold text-dp-on-surface-variant mb-1.5 font-sans">Message (Urdu) *</label>
            <textarea
              value={bodyUr}
              onChange={(e) => setBodyUr(e.target.value)}
              dir="rtl"
              rows={3}
              className="w-full px-3.5 py-2.5 border-2 border-dp-outline-variant rounded-lg font-sans text-[15px] resize-none"
              placeholder="پیغام"
            />
          </div>
          <div>
            <label className="block text-[12.5px] font-bold text-dp-on-surface-variant mb-1.5 font-sans">Message (English)</label>
            <textarea
              value={bodyEn}
              onChange={(e) => setBodyEn(e.target.value)}
              rows={3}
              className="w-full px-3.5 py-2.5 border-2 border-dp-outline-variant rounded-lg font-sans text-[15px] resize-none"
              placeholder="Optional"
            />
          </div>
        </div>

        <div>
          <label className="block text-[12.5px] font-bold text-dp-on-surface-variant mb-2 font-sans">Target villages</label>
          <div className="flex items-center gap-2 mb-2">
            <button
              type="button"
              onClick={() => setTargetAll(true)}
              className={`px-3 py-1.5 rounded-full text-[13px] font-sans font-semibold transition-colors ${
                targetAll ? 'bg-dp-primary text-white' : 'bg-dp-surface-variant text-dp-on-surface-variant'
              }`}
            >
              All villages
            </button>
            <button
              type="button"
              onClick={() => setTargetAll(false)}
              className={`px-3 py-1.5 rounded-full text-[13px] font-sans font-semibold transition-colors ${
                !targetAll ? 'bg-dp-primary text-white' : 'bg-dp-surface-variant text-dp-on-surface-variant'
              }`}
            >
              Pick villages
            </button>
          </div>
          {!targetAll && (
            <div className="flex flex-wrap gap-2 mt-2">
              {tenants.map((t) => (
                <label
                  key={t.id}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-sans cursor-pointer border-2 transition-colors ${
                    pickedTenants.has(t.id) ? 'border-dp-primary bg-dp-primary-container/10 text-dp-primary font-bold' : 'border-dp-outline-variant text-dp-on-surface-variant'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={pickedTenants.has(t.id)}
                    onChange={() => toggleTenant(t.id)}
                    className="sr-only"
                  />
                  {t.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={send}
          disabled={sending}
          className="w-full flex items-center justify-center gap-2 py-3 bg-dp-primary text-white rounded-lg font-sans font-bold text-[15px] hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
        >
          <Send size={17} /> {sending ? 'Sending...' : 'Send broadcast'}
        </button>
      </div>

      <div>
        <h2 className="font-heading text-[17px] font-bold text-dp-on-surface mb-3">Recent broadcasts</h2>
        {loadingList ? (
          <p className="text-dp-on-surface-variant text-[13.5px] font-sans">Loading...</p>
        ) : broadcasts.length === 0 ? (
          <p className="text-dp-on-surface-variant text-[13.5px] font-sans">No broadcasts sent yet.</p>
        ) : (
          <div className="space-y-2">
            {broadcasts.map((b) => {
              const expired = b.expires_at && new Date(b.expires_at) < new Date()
              return (
                <div key={b.id} className="bg-white rounded-lg border border-dp-outline-variant p-4 flex items-start gap-3">
                  {b.severity === 'emergency' ? (
                    <AlertTriangle size={18} className="text-dp-error shrink-0 mt-0.5" />
                  ) : (
                    <Megaphone size={18} className="text-amber-500 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-sans font-bold text-[14.5px] text-dp-on-surface" dir="rtl">{b.title_ur}</p>
                    <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5" dir="rtl">{b.body_ur}</p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className="text-[11.5px] font-sans text-dp-on-surface-variant bg-dp-surface-variant px-2 py-0.5 rounded-full">
                        {targetLabel(b)}
                      </span>
                      {b.expires_at && (
                        <span className="text-[11.5px] font-sans text-dp-on-surface-variant flex items-center gap-1">
                          <Clock size={11} /> expires {new Date(b.expires_at).toLocaleString()}
                        </span>
                      )}
                      {!b.is_active && <span className="text-[11.5px] font-sans text-dp-error font-bold">Withdrawn</span>}
                      {b.is_active && expired && <span className="text-[11.5px] font-sans text-dp-on-surface-variant font-bold">Expired</span>}
                    </div>
                  </div>
                  {b.is_active && !expired && (
                    <button
                      onClick={() => deactivate(b.id)}
                      className="shrink-0 flex items-center gap-1 text-[12.5px] font-sans font-semibold text-dp-error hover:underline cursor-pointer"
                    >
                      <Ban size={13} /> Withdraw
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
