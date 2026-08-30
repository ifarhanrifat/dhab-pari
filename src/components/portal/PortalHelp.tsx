'use client'

import { useEffect, useState } from 'react'
import { HelpCircle, X } from 'lucide-react'
import { PORTAL_HELP_CONTENT, type PortalHelpKey } from '@/lib/portalHelpContent'

const STORAGE_PREFIX = 'dp-portal-help-dismissed-'

// A dismissible "how does this page work" popup, in plain Pakistani Urdu —
// not the admin-editable pool-guide FAQ (portalGuideContent.ts, Kafalat/
// Wazifa/Esal-e-Sawab/Zakat only, always visible, "read before you join"
// detail). This is broader and lighter: what this page is for, who it
// helps, and what each button actually does — on every portal page, shown
// once automatically, closable, and always reachable again afterwards via
// the small (؟) icon next to the page title.
//
// Dismissal is a plain localStorage flag per page — a browser-local "don't
// show me this again", not a synced account preference. Good enough for
// what this is; if cross-device memory ever matters, this is the one place
// to swap for a portal_users column.
export function PortalHelp({ pageKey }: { pageKey: PortalHelpKey }) {
  const [open, setOpen] = useState(false)
  const content = PORTAL_HELP_CONTENT[pageKey]

  useEffect(() => {
    if (!content) return
    const seen = window.localStorage.getItem(STORAGE_PREFIX + pageKey)
    // A brand-new account also gets the app-wide WelcomeTour (mounted in
    // the dashboard layout) on this same first visit — if that hasn't
    // been dismissed yet, don't stack this one on top of it too. It's
    // still reachable any time via the (؟) icon; it just won't auto-pop
    // a second full-screen sheet the moment the first one closes.
    const welcomeTourPending = !window.localStorage.getItem('dp-portal-welcome-tour-seen')
    if (!seen && !welcomeTourPending) setOpen(true)
  }, [pageKey, content])

  const close = () => {
    window.localStorage.setItem(STORAGE_PREFIX + pageKey, '1')
    setOpen(false)
  }

  if (!content) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="مدد"
        title="اس صفحے کے استعمال کی مدد"
        className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-dp-secondary-container text-dp-on-secondary-container hover:bg-dp-secondary hover:text-white transition-colors cursor-pointer shrink-0"
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
            style={{ fontFamily: 'var(--font-urdu), serif' }}
            className="bg-white w-full sm:max-w-[560px] sm:rounded-lg rounded-t-2xl max-h-[85vh] overflow-y-auto shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b border-dp-outline-variant px-5 py-4 flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-dp-secondary-container text-dp-on-secondary-container shrink-0">
                  <HelpCircle size={17} />
                </span>
                <h2 className="font-heading text-[19px] font-bold text-dp-primary leading-snug">{content.title}</h2>
              </div>
              <button onClick={close} aria-label="بند کریں" className="text-dp-on-surface-variant hover:text-dp-error cursor-pointer p-1 shrink-0">
                <X size={20} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4 text-[14.5px] leading-[27px] text-dp-on-surface">
              {content.body}
            </div>
            <div className="px-5 pb-5 pt-1">
              <button
                onClick={close}
                className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-colors"
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
