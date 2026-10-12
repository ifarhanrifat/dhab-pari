'use client'

import { useEffect, useState } from 'react'
import { HelpCircle, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { PORTAL_HELP_CONTENT, type PortalHelpKey } from '@/lib/portalHelpContent'

// A dismissible "how does this page work" popup, in plain Pakistani Urdu —
// not the admin-editable pool-guide FAQ (portalGuideContent.ts, Kafalat/
// Wazifa/Esal-e-Sawab/Zakat only, always visible, "read before you join"
// detail). This is broader and lighter: what this page is for, who it
// helps, and what each button actually does — on every portal page, shown
// once automatically, closable, and always reachable again afterwards via
// the small (؟) icon next to the page title.
//
// Real bug found live on device, 2026-10-13: dismissal used to be a plain
// localStorage flag per page — browser-local, so a new device or cleared
// site data read as "never seen" and re-opened this (and WelcomeTour)
// every time, which is what "shows every time I log in" actually was.
// Moved to the account itself (portal_users.dismissed_help_pages,
// migration 643) — dismissed once, from any device, stays dismissed.
export function PortalHelp({ pageKey }: { pageKey: PortalHelpKey }) {
  const [open, setOpen] = useState(false)
  const [portalUserId, setPortalUserId] = useState<string | null>(null)
  const content = PORTAL_HELP_CONTENT[pageKey]

  useEffect(() => {
    if (!content) return
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id, welcome_tour_seen, dismissed_help_pages').eq('auth_user_id', user.id).single()
      if (!data) return
      setPortalUserId(data.id)
      const seen = (data.dismissed_help_pages ?? []).includes(pageKey)
      // A brand-new account also gets the app-wide WelcomeTour (mounted in
      // the dashboard layout) on this same first visit — if that hasn't
      // been dismissed yet, don't stack this one on top of it too. It's
      // still reachable any time via the (؟) icon; it just won't auto-pop
      // a second full-screen sheet the moment the first one closes.
      if (!seen && data.welcome_tour_seen) setOpen(true)
    })
  }, [pageKey, content])

  const close = () => {
    setOpen(false)
    if (portalUserId) {
      createClient().rpc('portal_dismiss_help_page', { p_page_key: pageKey }).then()
    }
  }

  if (!content) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="مدد"
        title="اس صفحے کے استعمال کی مدد"
        className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-dp2-surface text-dp2-primary-dark hover:bg-dp2-primary-dark hover:text-white transition-colors cursor-pointer shrink-0"
      >
        <HelpCircle size={16} />
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={close}
        >
          <div
            dir="rtl"
            style={{ fontFamily: 'var(--font-urdu-ui)' }}
            className="bg-white w-full sm:max-w-[560px] sm:rounded-2xl rounded-t-2xl max-h-[85vh] overflow-y-auto shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b border-dp2-card-border px-5 py-4 flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-dp2-surface text-dp2-primary-dark shrink-0">
                  <HelpCircle size={17} />
                </span>
                <h2 className="font-heading text-[20px] font-bold text-dp2-primary leading-snug">{content.title}</h2>
              </div>
              <button onClick={close} aria-label="بند کریں" className="text-slate-500 hover:text-red-600 cursor-pointer p-1 shrink-0">
                <X size={20} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4 text-[15px] leading-[28px] text-slate-800">
              {content.body}
            </div>
            <div className="px-5 pb-5 pt-1">
              <button
                onClick={close}
                className="w-full bg-dp2-primary-dark text-white py-2.5 rounded-xl font-sans text-[15px] font-semibold cursor-pointer hover:brightness-110 transition-colors"
              >
                سمجھ گیا/گئی، بند کریں
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
