'use client'

import { usePathname } from 'next/navigation'
import { MessageCircle } from 'lucide-react'
import { SITE } from '@/lib/constants'

// Click-to-chat: opens the visitor's own WhatsApp with our number
// pre-filled — no third-party service, no backend, same wa.me pattern used
// everywhere else in this app. Visible on every public/portal page; hidden
// on /admin since staff already work from inside the dashboard.
export function FloatingWhatsAppButton() {
  const pathname = usePathname()
  if (pathname?.startsWith('/admin')) return null

  return (
    <a
      href={SITE.whatsappLink}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with us on WhatsApp"
      title="Chat with us on WhatsApp"
      className="fixed z-[70] bottom-20 right-4 md:bottom-6 md:right-6 flex items-center justify-center w-14 h-14 rounded-full bg-[#25D366] text-white shadow-lg hover:bg-[#1ebe5a] hover:scale-105 active:scale-95 transition-all print:hidden"
    >
      <MessageCircle size={28} />
    </a>
  )
}
