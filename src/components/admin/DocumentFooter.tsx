'use client'

interface Props { lang: 'en' | 'ur'; className?: string }

// Companion to DocumentHeader — the letterhead at the top, this at the
// bottom. Real report (2026-09-24): printed reports/statements had "no
// details at the end" — no generated-on date, no signature line, nothing
// distinguishing a genuine system record from a plain data dump. Print-only
// (hidden on the admin's own on-screen preview, same hidden print:block
// pattern DocumentHeader already uses) so it never clutters the screen view.
export function DocumentFooter({ lang, className = '' }: Props) {
  const now = new Date()
  const printedOn = lang === 'ur'
    ? `پرنٹ کی تاریخ: ${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : `Printed on: ${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  const systemNote = lang === 'ur'
    ? 'یہ ایک کمپیوٹر سے تیار کردہ دستاویز ہے اور دستخط کے بغیر بھی درست ہے۔'
    : 'This is a computer-generated document and is valid without a signature.'

  return (
    <div className={`hidden print:block mt-6 pt-4 border-t border-dp-outline-variant ${className}`} style={lang === 'ur' ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-end justify-between gap-4">
        <p className="text-[11px] text-dp-on-surface-variant">{systemNote}</p>
        <div className="text-end shrink-0">
          <div className="w-36 border-t border-dp-on-surface mb-1" />
          <p className="text-[11px] text-dp-on-surface-variant">{lang === 'ur' ? 'مجاز دستخط' : 'Authorized Signature'}</p>
        </div>
      </div>
      <p className="text-[10.5px] text-dp-on-surface-variant mt-2">{printedOn}</p>
    </div>
  )
}
