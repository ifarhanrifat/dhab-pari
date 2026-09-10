'use client'

// A dedicated notifications screen — the prototype's own Rider-16 list
// names this as its own screen (اطلاعات), not just a header dropdown.
// Same portal_notifications table and mark-read/delete actions the
// existing PortalNotificationBell dropdown already uses (123) — this is
// the full-list view of the same data, reached from the bottom nav's
// own bell rather than duplicating any backend.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarketplaceBottomNav } from '@/components/portal/MarketplaceBottomNav'

interface Notification { id: string; title: string; body: string | null; link: string | null; is_read: boolean; created_at: string }

function timeAgo(iso: string, t: (k: string, f?: string) => string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return t('g.justNow', 'just now')
  if (secs < 3600) return `${Math.floor(secs / 60)}${t('g.minutesShort', 'm')}`
  if (secs < 86400) return `${Math.floor(secs / 3600)}${t('g.hoursShort', 'h')}`
  return `${Math.floor(secs / 86400)}${t('g.daysShort', 'd')}`
}

export default function MarketplaceNotificationsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [items, setItems] = useState<Notification[] | null>(null)

  const load = () => {
    if (!user) return
    supabase.from('portal_notifications').select('id, title, body, link, is_read, created_at')
      .eq('portal_user_id', user.id).order('created_at', { ascending: false }).limit(100)
      .then(({ data }) => setItems(data ?? []))
  }
  useEffect(load, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (n: Notification) => {
    if (!n.is_read) {
      await supabase.from('portal_notifications').update({ is_read: true }).eq('id', n.id)
      setItems((cur) => cur?.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)) ?? null)
    }
    if (n.link) router.push(n.link)
  }
  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await supabase.from('portal_notifications').delete().eq('id', id)
    setItems((cur) => cur?.filter((x) => x.id !== id) ?? null)
  }
  const markAllRead = async () => {
    if (!user) return
    await supabase.from('portal_notifications').update({ is_read: true }).eq('portal_user_id', user.id).eq('is_read', false)
    setItems((cur) => cur?.map((x) => ({ ...x, is_read: true })) ?? null)
  }

  if (userLoading || items === null) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  const unreadCount = items.filter((n) => !n.is_read).length

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <div className="flex items-center justify-between gap-3 mb-5">
        <h1 className="font-heading text-[24px] font-bold text-dp-primary flex items-center gap-2"><Bell size={20} /> {t('g.notifications')}</h1>
        {unreadCount > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-sans text-[11px] font-bold px-2.5 py-1 rounded-full bg-dp-secondary text-white">{t('mp.newCountBadge').replace('{n}', String(unreadCount))}</span>
            <button onClick={markAllRead} className="font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer">{t('g.markAllRead')}</button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px]">{t('g.noNotifications')}</p>
      ) : (
        <div className="space-y-2">
          {items.map((n) => (
            <div key={n.id} onClick={() => open(n)} className="flex items-start gap-3 bg-white border border-dp-outline-variant rounded-lg overflow-hidden cursor-pointer hover:border-dp-secondary transition-colors" style={{ borderInlineStartWidth: n.is_read ? 1 : 4, borderInlineStartColor: n.is_read ? undefined : '#ec3013' }}>
              <div className="flex-1 min-w-0 py-3 ps-3.5 pe-2">
                <p className={`font-sans text-[13.5px] ${n.is_read ? 'font-medium text-dp-on-surface-variant' : 'font-bold text-dp-on-surface'}`}>{n.title}</p>
                {n.body && <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{n.body}</p>}
              </div>
              <div className="flex items-center gap-2 pe-3.5 py-3 shrink-0">
                <span className="font-sans text-[11px] text-dp-on-surface-variant">{timeAgo(n.created_at, t)}</span>
                <button onClick={(e) => remove(e, n.id)} className="text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <MarketplaceBottomNav />
    </div>
  )
}
