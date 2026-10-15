'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Siren, LogOut } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingDots } from '@/components/shared/LoadingDots'

export default function EmergencyAdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const supabase = createClient()
  // undefined = still checking, null = confirmed not an emergency admin,
  // object = confirmed. Three states so the guard never flashes the
  // dashboard before the check resolves.
  const [admin, setAdmin] = useState<{ full_name: string; email: string } | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) {
        if (!cancelled) setAdmin(null)
        return
      }
      const { data } = await supabase
        .from('emergency_admins')
        .select('full_name, email')
        .eq('auth_user_id', user.id)
        .eq('is_active', true)
        .maybeSingle()
      if (!cancelled) setAdmin(data ?? null)
    })
    return () => { cancelled = true }
  }, [supabase])

  useEffect(() => {
    if (admin === null) router.replace('/emergency-admin/login')
  }, [admin, router])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/emergency-admin/login')
    router.refresh()
  }

  if (admin === undefined || admin === null) {
    return (
      <div className="min-h-screen bg-[#2b1414] flex items-center justify-center">
        <LoadingDots />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F5F8F6]">
      <header className="bg-[#2b1414] px-4 md:px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Siren size={20} className="text-white" />
          <div>
            <span className="font-heading text-white font-bold text-[16px] block leading-tight">Emergency &amp; Ilaan</span>
            <span className="text-white/50 text-[11px] font-sans">{admin.email}</span>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 px-3 py-2 bg-white/10 text-white rounded-lg text-[13.5px] font-sans font-semibold hover:bg-white/20 transition-colors cursor-pointer"
        >
          <LogOut size={15} /> Logout
        </button>
      </header>
      <main className="p-4 md:p-8 max-w-[900px] mx-auto">{children}</main>
    </div>
  )
}
