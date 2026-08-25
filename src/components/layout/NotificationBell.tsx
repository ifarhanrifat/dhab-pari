'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { playNotificationSound } from '@/lib/notificationSound'
import { useNotificationSoundMuted } from '@/hooks/useNotificationSoundMuted'

interface Notification {
  id: string; title: string; body: string | null; link: string | null
  is_read: boolean; created_at: string
}

function timeAgo(iso: string) {
  const { t } = useLocale()
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

export function NotificationBell() {
  const { t } = useLocale()
  const supabase = createClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [adminUserId, setAdminUserId] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const { muted, setMuted } = useNotificationSoundMuted()
  const mutedRef = useRef(muted)
  useEffect(() => { mutedRef.current = muted }, [muted])

  const load = async (recipientId: string) => {
    const { data } = await supabase.from('notifications').select('id, title, body, link, is_read, created_at')
      .eq('recipient_id', recipientId).order('created_at', { ascending: false }).limit(20)
    setItems(data ?? [])
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('admin_users').select('id').eq('auth_user_id', user.id).single()
      if (data) { setAdminUserId(data.id); load(data.id) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // True real-time delivery via Supabase Realtime (a WebSocket subscription —
  // works identically on mobile browsers as on desktop, as long as the site is
  // open/"online"). The 30s poll below is kept only as a fallback in case the
  // socket drops silently (mobile browsers suspend background tabs/connections
  // more aggressively than desktop).
  useEffect(() => {
    if (!adminUserId) return
    const channel = supabase
      .channel(`notifications:${adminUserId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${adminUserId}` },
        (payload) => {
          const n = payload.new as Notification
          setItems((cur) => [n, ...cur.filter((x) => x.id !== n.id)])
          if (!mutedRef.current) playNotificationSound()
          toast.info(n.title, { description: n.body ?? undefined, action: n.link ? { label: 'View', onClick: () => router.push(n.link!) } : undefined })
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminUserId])

  useEffect(() => {
    if (!adminUserId) return
    const interval = setInterval(() => load(adminUserId), 30000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminUserId])

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const unreadCount = items.filter((n) => !n.is_read).length

  const openNotification = async (n: Notification) => {
    if (!n.is_read) {
      await supabase.from('notifications').update({ is_read: true }).eq('id', n.id)
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)))
    }
    setOpen(false)
    if (n.link) router.push(n.link)
  }

  const markAllRead = async () => {
    if (!adminUserId) return
    await supabase.from('notifications').update({ is_read: true }).eq('recipient_id', adminUserId).eq('is_read', false)
    setItems((cur) => cur.map((x) => ({ ...x, is_read: true })))
  }

  if (!adminUserId) return null

  return (
    // top-16 clears the mobile header bar (AdminHeader, md:hidden, ~60px tall
    // with its own hamburger button in the same top-right corner) so the two
    // don't overlap; on desktop there's no header bar, so it sits at top-4.
    <div ref={boxRef} className="fixed top-16 right-4 md:top-4 md:right-4 z-[95] print:hidden">
      <button
        onClick={() => setOpen(!open)}
        className="relative w-10 h-10 flex items-center justify-center bg-white border border-dp-outline-variant rounded-full shadow-md hover:shadow-lg transition-all cursor-pointer"
        aria-label="Notifications"
      >
        <Bell size={18} className="text-dp-primary" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-dp-error text-white rounded-full text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white border border-dp-outline-variant rounded-lg shadow-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-dp-outline-variant flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="font-sans text-[13px] font-bold text-dp-on-surface">{t('g.notifications')}</span>
              <button onClick={() => setMuted(!muted)} title={muted ? t('g.notifSoundOff') : t('g.notifSoundOn')} className="text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
                {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
            </div>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="font-sans text-[11.5px] font-semibold text-dp-secondary hover:underline cursor-pointer">{t('g.markAllRead')}</button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-8 text-center font-sans text-[13px] text-dp-on-surface-variant">{t('g.noNotifications')}</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openNotification(n)}
                  className={`w-full text-start px-4 py-3 border-b border-dp-outline-variant last:border-b-0 hover:bg-dp-surface-container-low transition-all cursor-pointer ${!n.is_read ? 'bg-dp-secondary/5' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{n.title}</p>
                    {!n.is_read && <span className="w-2 h-2 rounded-full bg-dp-secondary shrink-0 mt-1" />}
                  </div>
                  {n.body && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{n.body}</p>}
                  <p className="font-sans text-[11px] text-dp-on-surface-variant/70 mt-1">{timeAgo(n.created_at)}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
