'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ChevronDown, UserCog, LogOut } from 'lucide-react'

// The identity + logout that used to live pinned to the bottom of the
// sidebar now sits at the top-right of the screen instead — the corner a
// donor already expects it in from every other app they use (Facebook,
// Gmail, ...). Fixed and floating, the same pattern PortalNotificationBell
// already uses, positioned just to its left so the two never collide.
export function PortalProfileMenu() {
  const { user } = usePortalUser()
  const { t } = useLocale()
  const router = useRouter()
  const supabase = createClient()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/portal/login')
    router.refresh()
  }

  if (!user) return null

  return (
    <div ref={boxRef} className="fixed top-16 right-4 md:top-4 md:right-4 z-[96] print:hidden">
      {/* Avatar + chevron only — a fixed, small width regardless of how
          long the name is, so PortalNotificationBell can sit at a fixed
          offset beside it without the two ever colliding. The name still
          shows, once, inside the open dropdown below. */}
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 h-10 pl-1 pr-2 bg-white border border-dp-outline-variant rounded-full shadow-md hover:shadow-lg transition-all cursor-pointer">
        {user.avatar_url ? (
          <Image src={user.avatar_url} alt="" width={32} height={32} className="w-8 h-8 rounded-full object-cover shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-dp-primary-container text-dp-primary flex items-center justify-center font-bold text-[13px] font-sans shrink-0">
            {(user.full_name ?? '?').charAt(0).toUpperCase()}
          </div>
        )}
        <ChevronDown size={14} className={`text-dp-on-surface-variant transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-white border border-dp-outline-variant rounded-lg shadow-lg overflow-hidden text-dp-on-surface">
          <div className="px-4 py-3 border-b border-dp-outline-variant">
            <p className="font-sans text-[13px] font-bold truncate">{user.full_name}</p>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{user.mobile}</p>
          </div>
          <Link href="/portal/profile" onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 font-sans text-[13.5px] font-semibold hover:bg-dp-surface-container-low transition-all">
            <UserCog size={16} className="text-dp-on-surface-variant" /> {t('portal.profile', 'My Profile')}
          </Link>
          <button onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 font-sans text-[13.5px] font-semibold text-dp-error hover:bg-dp-error/5 transition-all cursor-pointer">
            <LogOut size={16} /> {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  )
}
