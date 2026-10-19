'use client'

// Phase 6: the "Account" tab's catch-all — the mockup's 5-tab bar has no
// room for the ~25 flat destinations PortalSidebar used to list (donate,
// water, academy, complaints, my-shop, notification prefs, etc.), so they
// collapse into this one in-page list instead of a 6th tab (confirmed
// via AskUserQuestion — keeps the bottom bar at a clean 5 tabs matching
// the mockup exactly). Same menuItems/gating shape PortalSidebar used,
// just presented as a scrollable list instead of a persistent rail.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { Card2 } from '@/components/design2/Card2'
import {
  HeartHandshake, Droplets, Repeat, MessageSquare, MessageSquareWarning, Droplet, LogOut, UserCog,
  HandHeart, HeartCrack, Vote, Briefcase, GraduationCap, Gift, CalendarDays, Bell, Landmark, BookOpen,
  NotebookPen, Scale, Users, School, CalendarClock, Sparkles, Store, ChevronRight, Search, AlertTriangle, Tag,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface Item { href: string; labelKey: string; icon: LucideIcon; requiresConsumer?: boolean; requiresShopKeeper?: boolean; requiresManagedFunds?: boolean }
interface Group { titleKey: string; items: Item[] }

const groups: Group[] = [
  {
    titleKey: 'portal.groupGiving',
    items: [
      { href: '/portal/donate', labelKey: 'portal.donate', icon: HeartHandshake },
      { href: '/portal/statement', labelKey: 'portal.statement', icon: HeartHandshake },
      { href: '/portal/water', labelKey: 'portal.water', icon: Droplets, requiresConsumer: true },
      { href: '/portal/recurring', labelKey: 'portal.recurring', icon: Repeat },
      { href: '/portal/zakat', labelKey: 'portal.zakat', icon: Scale },
      { href: '/portal/kafalat', labelKey: 'portal.kafalat', icon: GraduationCap },
      { href: '/portal/esal-e-sawab', labelKey: 'portal.esalESawab', icon: Gift },
      { href: '/portal/wazifa', labelKey: 'portal.wazifa', icon: BookOpen },
    ],
  },
  {
    titleKey: 'portal.groupCommunity',
    items: [
      { href: '/portal/propose-project', labelKey: 'portal.proposeProject', icon: Vote },
      { href: '/portal/submit-blog', labelKey: 'portal.submitBlog', icon: NotebookPen },
      { href: '/portal/mentors', labelKey: 'portal.mentors', icon: Users },
      { href: '/portal/institutes', labelKey: 'portal.institutes', icon: School },
      { href: '/portal/training-programs', labelKey: 'portal.trainingPrograms', icon: CalendarClock },
      { href: '/portal/talent-showcase', labelKey: 'portal.talentShowcase', icon: Sparkles },
    ],
  },
  {
    titleKey: 'portal.groupMarketplaceExtra',
    items: [
      { href: '/portal/classifieds', labelKey: 'portal.classifieds', icon: Tag },
      { href: '/portal/my-shop', labelKey: 'portal.myShop', icon: Store, requiresShopKeeper: true },
    ],
  },
  {
    titleKey: 'portal.groupSupport',
    items: [
      { href: '/portal/suggestions', labelKey: 'portal.suggestions', icon: MessageSquare },
      { href: '/portal/complaints', labelKey: 'portal.complaints', icon: MessageSquareWarning },
      { href: '/portal/blood-donor', labelKey: 'portal.bloodDonor', icon: Droplet },
      { href: '/portal/post-job', labelKey: 'portal.postJob', icon: Briefcase },
      { href: '/portal/lost-found', labelKey: 'portal.lostFound', icon: Search },
      { href: '/portal/report-problem', labelKey: 'portal.reportProblem', icon: AlertTriangle },
      { href: '/portal/ask-for-help', labelKey: 'portal.askForHelp', icon: HandHeart },
      { href: '/portal/death-announcement', labelKey: 'portal.deathAnnouncement', icon: HeartCrack },
      { href: '/events', labelKey: 'nav.villageEvents', icon: CalendarDays },
      { href: '/portal/my-salami', labelKey: 'sl.myPledges', icon: Gift },
      { href: '/chanda', labelKey: 'ch.pageTitle', icon: Landmark },
      { href: '/portal/fund-management', labelKey: 'fnd.pageTitle', icon: Landmark, requiresManagedFunds: true },
      { href: '/portal/my-volunteering', labelKey: 'portal.myVolunteering', icon: HeartHandshake },
      { href: '/portal/get-involved', labelKey: 'portal.getInvolved', icon: HandHeart },
    ],
  },
  {
    titleKey: 'portal.groupAccount',
    items: [
      { href: '/portal/notification-preferences', labelKey: 'np.pageTitle', icon: Bell },
      { href: '/portal/profile', labelKey: 'portal.profile', icon: UserCog },
    ],
  },
]

export default function AccountPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const { user } = usePortalUser()
  const [hasShop, setHasShop] = useState(false)
  const [hasManagedFunds, setHasManagedFunds] = useState(false)

  useEffect(() => {
    if (!user) return
    Promise.all([
      supabase.from('shops').select('id').eq('portal_user_id', user.id).limit(1),
      supabase.from('shop_staff').select('id').eq('portal_user_id', user.id).limit(1),
    ]).then(([owned, staff]) => setHasShop((owned.data?.length ?? 0) > 0 || (staff.data?.length ?? 0) > 0))
    Promise.all([
      supabase.from('event_salami_accounts').select('id').eq('manager_portal_user_id', user.id).limit(1),
      supabase.from('chanda_campaigns').select('id').eq('manager_portal_user_id', user.id).limit(1),
    ]).then(([sa, cc]) => setHasManagedFunds((sa.data?.length ?? 0) > 0 || (cc.data?.length ?? 0) > 0))
  }, [supabase, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const isVisible = (item: Item) =>
    (!item.requiresConsumer || user?.consumer_id) && (!item.requiresShopKeeper || hasShop) && (!item.requiresManagedFunds || hasManagedFunds)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/portal/login'
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="pb-6">
      <Card2 className="p-4 mb-4 flex items-center gap-3">
        {user?.avatar_url ? (
          <Image src={user.avatar_url} alt="" width={48} height={48} className="w-12 h-12 rounded-full object-cover shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-dp2-tint-green-100 text-dp2-primary-dark flex items-center justify-center font-bold text-[18px] font-sans shrink-0">
            {(user?.full_name ?? '?').charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-sans font-bold text-[15px] text-dp2-text-ink truncate">{user?.full_name}</p>
          <p className="font-sans text-[12px] text-dp2-text-muted truncate ltr-num">{user?.mobile}</p>
        </div>
      </Card2>

      {groups.map((g) => {
        const visible = g.items.filter(isVisible)
        if (visible.length === 0) return null
        return (
          <div key={g.titleKey} className="mb-4">
            <p className="font-sans text-[11px] font-bold text-dp2-text-muted uppercase tracking-[0.05em] mb-1.5 px-1">{t(g.titleKey)}</p>
            <Card2 className="p-0 overflow-hidden">
              {visible.map((item, i) => (
                <Link key={item.href} href={item.href}
                  className={`flex items-center gap-3 px-3.5 py-3 ${i > 0 ? 'border-t border-dp2-card-border/60' : ''}`}>
                  <item.icon size={17} className="text-dp2-primary-dark shrink-0" />
                  <span className="font-sans text-[13.5px] text-dp2-text-ink flex-1">{t(item.labelKey)}</span>
                  <ChevronRight size={15} className={`text-dp2-text-faint shrink-0 ${isUrdu ? 'rotate-180' : ''}`} />
                </Link>
              ))}
            </Card2>
          </div>
        )
      })}

      <button onClick={handleLogout} className="w-full flex items-center justify-center gap-1.5 py-3 text-[#b91c1c] font-sans text-[13.5px] font-semibold cursor-pointer">
        <LogOut size={15} /> {t('nav.logout')}
      </button>
    </div>
  )
}
