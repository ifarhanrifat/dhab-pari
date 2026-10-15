'use client'

// A dedicated notifications screen — the prototype's own Rider-16 list
// names this as its own screen (اطلاعات), not just a header dropdown.
// Same portal_notifications table and mark-read/delete actions the
// existing PortalNotificationBell dropdown already uses (123) — this is
// the full-list view of the same data.
//
// Phase 4 fix: this screen was never migrated into the (mobility) route
// group and still used the old shop-ink-theme CSS + MarketplaceBottomNav
// — a real visual-regression bug, not a missing feature: landing here
// dropped a rider out of the new design entirely. Moved + restyled only;
// no logic changed.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Notification { id: string; title: string; body: string | null; link: string | null; is_read: boolean; created_at: string }

function timeAgo(iso: string, t: (k: string, f?: string) => string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return t('g.justNow', 'just now')
  if (secs < 3600) return `${Math.floor(secs / 60)}${t('g.minutesShort', 'm')}`
  if (secs < 86400) return `${Math.floor(secs / 3600)}${t('g.hoursShort', 'h')}`
  return `${Math.floor(secs / 86400)}${t('g.daysShort', 'd')}`
}

export default function MarketplaceNotificationsPage() {
  const { t } = useLocale()
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

  if (userLoading || items === null) return <div className="text-center py-12"><LoadingDots /></div>

  const unreadCount = items.filter((n) => !n.is_read).length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-extrabold text-[20px] text-[#005A36] flex items-center gap-2"><Bell size={19} /> {t('g.notifications')}</h1>
        {unreadCount > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#166534] text-white">{t('mp.newCountBadge').replace('{n}', String(unreadCount))}</span>
            <button onClick={markAllRead} className="text-[12px] font-semibold text-[#166534] hover:underline cursor-pointer">{t('g.markAllRead')}</button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-center py-10 text-[#94a3b8] text-[14px]">{t('g.noNotifications')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((n) => (
            <div key={n.id} onClick={() => open(n)} className="flex items-start gap-3 bg-white border border-[#e5e2d0] rounded-2xl overflow-hidden cursor-pointer hover:border-[#166534] transition-colors" style={{ borderInlineStartWidth: n.is_read ? 1 : 4, borderInlineStartColor: n.is_read ? undefined : '#D4AF37' }}>
              <div className="flex-1 min-w-0 py-3 ps-3.5 pe-2">
                <p className={`text-[13.5px] ${n.is_read ? 'font-medium text-[#64748b]' : 'font-bold text-[#1e293b]'}`}>{n.title}</p>
                {n.body && <p className="text-[12px] text-[#64748b] mt-0.5">{n.body}</p>}
              </div>
              <div className="flex items-center gap-2 pe-3.5 py-3 shrink-0">
                <span className="text-[11px] text-[#94a3b8]">{timeAgo(n.created_at, t)}</span>
                <button onClick={(e) => remove(e, n.id)} className="text-[#94a3b8] hover:text-red-600 cursor-pointer"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
