'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Trash2, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { playNotificationSound } from '@/lib/notificationSound'
import { useNotificationSoundMuted } from '@/hooks/useNotificationSoundMuted'
import { NotificationOffBanner } from '@/components/shared/NotificationOffBanner'

interface PortalNotification {
  id: string; title: string; body: string | null; link: string | null
  is_read: boolean; created_at: string
}

function timeAgo(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

// Adapted from src/components/layout/NotificationBell.tsx for portal_users —
// same realtime + 30s-poll-fallback pattern, targeting portal_notifications
// instead. Unlike the staff bell, items are deletable (portal_notifications
// has a delete-own RLS policy the staff `notifications` table deliberately
// lacks), fixed/floating like the admin bell rather than inline in a nav bar
// since the portal has its own header bar to sit in.
export function PortalNotificationBell({ embedded = false }: { embedded?: boolean }) {
  const { t } = useLocale()
  const supabase = createClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PortalNotification[]>([])
  const [portalUserId, setPortalUserId] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const { muted, setMuted } = useNotificationSoundMuted()

  const load = async (recipientId: string) => {
    const { data } = await supabase.from('portal_notifications').select('id, title, body, link, is_read, created_at')
      .eq('portal_user_id', recipientId).order('created_at', { ascending: false }).limit(20)
    setItems(data ?? [])
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).single()
      if (data) { setPortalUserId(data.id); load(data.id) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A ref, not a dependency — re-subscribing the whole realtime channel
  // every time someone toggles mute would be a needless teardown/rebuild
  // for a value the handler only needs to read at the moment a message
  // arrives.
  const mutedRef = useRef(muted)
  useEffect(() => { mutedRef.current = muted }, [muted])

  useEffect(() => {
    if (!portalUserId) return
    const channel = supabase
      .channel(`portal_notifications:${portalUserId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_notifications', filter: `portal_user_id=eq.${portalUserId}` },
        (payload) => {
          const n = payload.new as PortalNotification
          setItems((cur) => [n, ...cur.filter((x) => x.id !== n.id)])
          if (!mutedRef.current) playNotificationSound()
          toast.info(n.title, { description: n.body ?? undefined, action: n.link ? { label: 'View', onClick: () => router.push(n.link!) } : undefined })
        })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portalUserId])

  useEffect(() => {
    if (!portalUserId) return
    const interval = setInterval(() => load(portalUserId), 30000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portalUserId])

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const unreadCount = items.filter((n) => !n.is_read).length

  const openNotification = async (n: PortalNotification) => {
    if (!n.is_read) {
      await supabase.from('portal_notifications').update({ is_read: true }).eq('id', n.id)
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)))
    }
    setOpen(false)
    if (n.link) router.push(n.link)
  }

  const deleteNotification = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await supabase.from('portal_notifications').delete().eq('id', id)
    setItems((cur) => cur.filter((x) => x.id !== id))
  }

  const markAllRead = async () => {
    if (!portalUserId) return
    await supabase.from('portal_notifications').update({ is_read: true }).eq('portal_user_id', portalUserId).eq('is_read', false)
    setItems((cur) => cur.map((x) => ({ ...x, is_read: true })))
  }

  if (!portalUserId) return null

  // embedded=true: sits inline inside PortalHeader's own bar on mobile
  // (real ask, live on device: "why did not you change the portal top
  // bar like the website was having, profile and alert etc" — a floating
  // white circle overlapping the page read as disconnected from the
  // header it was meant to belong to). embedded=false (default): the
  // original fixed floating button, still used standalone on desktop
  // where there's no header bar for it to sit inside.
  const buttonCls = embedded
    ? 'relative w-9 h-9 flex items-center justify-center rounded-full text-white hover:bg-white/10 transition-all cursor-pointer'
    : 'relative w-10 h-10 flex items-center justify-center bg-white border border-dp2-card-border rounded-full shadow-md hover:shadow-lg transition-all cursor-pointer'
  const iconColorCls = embedded ? 'text-white' : 'text-dp2-primary'

  return (
    <>
    <NotificationOffBanner owner={{ portalUserId }} settingsHref="/portal/notification-preferences" />
    {/* Fixed, floating on desktop — mirrors src/components/layout/
    NotificationBell.tsx (the admin equivalent), where there's no header
    bar above it to sit inside. Inline/relative when embedded in
    PortalHeader instead. */}
    <div ref={boxRef} className={embedded ? 'relative print:hidden' : 'fixed top-4 right-4 z-[95] print:hidden'}>
      <button onClick={() => setOpen(!open)} className={buttonCls} aria-label="Notifications">
        <Bell size={18} className={iconColorCls} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-600 text-white rounded-full text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 mt-2 w-80 max-w-[90vw] bg-white border border-dp2-card-border rounded-2xl shadow-lg overflow-hidden text-slate-800 z-[95]">
          <div className="px-4 py-2.5 border-b border-dp2-card-border flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="font-sans text-[14px] font-bold">{t('g.notifications')}</span>
              <button onClick={() => setMuted(!muted)} title={muted ? t('g.notifSoundOff') : t('g.notifSoundOn')} className="text-slate-500 hover:text-dp2-primary-dark cursor-pointer">
                {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
            </div>
            {unreadCount > 0 && <button onClick={markAllRead} className="font-sans text-[12.5px] font-semibold text-dp2-primary-dark hover:underline cursor-pointer">{t('g.markAllRead')}</button>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-8 text-center font-sans text-[14px] text-slate-500">{t('g.noNotifications')}</p>
            ) : (
              items.map((n) => (
                <div key={n.id} onClick={() => openNotification(n)}
                  className={`w-full text-start px-4 py-3 border-b border-dp2-card-border last:border-b-0 hover:bg-dp2-surface transition-all cursor-pointer flex items-start gap-2 ${!n.is_read ? 'bg-dp2-primary-dark/5' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-sans text-[14px] font-semibold">{n.title}</p>
                      {!n.is_read && <span className="w-2 h-2 rounded-full bg-dp2-primary-dark shrink-0 mt-1" />}
                    </div>
                    {n.body && <p className="font-sans text-[13px] text-slate-500 mt-0.5">{n.body}</p>}
                    <p className="font-sans text-[12px] text-slate-400 mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                  <button onClick={(e) => deleteNotification(e, n.id)} className="p-1 text-slate-500 hover:text-red-600 cursor-pointer shrink-0" title="Delete">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
    </>
  )
}
