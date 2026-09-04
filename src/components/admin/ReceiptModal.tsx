'use client'

import { useRef, useState, useEffect } from 'react'
import { X, Printer, Download, Share2, FileText, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { ReceiptDocument, type ReceiptData, type InvoiceTemplate } from './ReceiptDocument'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'
import type { SlipFormat } from './UniversalSlip'
import { LoadingDots } from '@/components/shared/LoadingDots'
import {
  getPreferredFormat, setPreferredFormat, nodeToPdfBlob, nodeToPngBlob,
  downloadBlob, shareReceipt, printBlob, type ReceiptFormat,
  getPreferredSlipTarget, setPreferredSlipTarget,
} from '@/lib/receiptExport'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface ReceiptModalProps {
  data: ReceiptData
  phone?: string | null
  onClose: () => void
  // Pass 'donors_projects' to pick up donor-specific footer/help-numbers/
  // template overrides (Settings → Donor Templates) instead of the shared
  // ones — see fetchBrandingSettings(). Omit for water_supply (unchanged).
  system?: 'water_supply' | 'donors_projects'
}

export function ReceiptModal({ data, phone, onClose, system }: ReceiptModalProps) {
  const { t } = useLocale()
  const nodeRef = useRef<HTMLDivElement>(null)
  const [format, setFormat] = useState<ReceiptFormat>(getPreferredFormat())
  const [busy, setBusy] = useState(false)
  // No template is selected yet — rendering ReceiptDocument with any
  // hardcoded guess here (it used to default to 'classic') would flash that
  // guess for the round trip fetchBrandingSettings takes before showing the
  // real one from Settings. Null means "don't render the document yet",
  // not "assume a template" — see the loading placeholder below.
  const [template, setTemplate] = useState<InvoiceTemplate | null>(null)
  const [branding, setBranding] = useState<Partial<BrandingSettings>>({})
  // Print target is a runtime choice, never stored on the transaction — the
  // same receipt goes to A4 in the office and to a Bluetooth thermal roll in
  // the field. Settings only decides which one starts selected, per audience.
  const [slipFormat, setSlipFormat] = useState<SlipFormat>(() => getPreferredSlipTarget() ?? 'a4')

  useEffect(() => {
    fetchBrandingSettings(system).then((b) => {
      setTemplate(b.invoiceTemplate)
      // This person's own last choice wins; the Settings value is only the
      // starting point for someone who has never picked one on this device.
      setSlipFormat(getPreferredSlipTarget() ?? b.slipFormat)
      setBranding(b)
    })
  }, [system])

  const chooseSlipFormat = (t: SlipFormat) => {
    setSlipFormat(t)
    setPreferredSlipTarget(t)
  }

  const chooseFormat = (f: ReceiptFormat) => {
    setFormat(f)
    setPreferredFormat(f)
  }

  const buildBlob = async () => {
    if (!nodeRef.current) throw new Error('Receipt not ready')
    return format === 'pdf' ? nodeToPdfBlob(nodeRef.current) : nodeToPngBlob(nodeRef.current)
  }

  const filename = () => `receipt-${data.receiptNo}.${format === 'pdf' ? 'pdf' : 'png'}`

  const handlePrint = async () => {
    setBusy(true)
    try {
      // Print the generated PDF in its own blob document, never the live admin page —
      // printing the page itself would leak the internal admin URL into the printout.
      const blob = await nodeToPdfBlob(nodeRef.current!)
      printBlob(blob)
    } catch {
      toast.error('Could not prepare the document for printing')
    } finally {
      setBusy(false)
    }
  }

  const handleDownload = async () => {
    setBusy(true)
    try {
      const blob = await buildBlob()
      downloadBlob(blob, filename())
      toast.success(`Downloaded ${format.toUpperCase()}`)
    } catch {
      toast.error('Could not generate the file')
    } finally {
      setBusy(false)
    }
  }

  const handleShare = async () => {
    setBusy(true)
    try {
      const blob = await buildBlob()
      const mime = format === 'pdf' ? 'application/pdf' : 'image/png'
      // A PDF cannot be pasted into a chat, so the clipboard always gets a
      // PNG. It is rendered unconditionally now: the OS share sheet used to
      // cover most cases, and with that gone the clipboard IS the good path.
      const clipboardBlob = format === 'png' ? blob : await nodeToPngBlob(nodeRef.current!)

      const result = await shareReceipt({
        blob, filename: filename(), mime, phone, clipboardBlob,
        message: `Receipt ${data.receiptNo} — ${data.amount.toLocaleString()}`,
      })
      toast.success(
        result === 'copied'
          ? 'Image copied — press Ctrl+V (⌘V) in the WhatsApp chat to attach it'
          : 'Downloaded — attach it in the chat that just opened'
      )
    } catch {
      toast.error('Could not share the receipt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center p-4 print:bg-white print:p-0" onClick={onClose}>
      <div className="bg-white rounded-lg max-h-[92vh] max-w-full overflow-y-auto print:max-h-none print:overflow-visible print:rounded-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-dp-outline-variant print:hidden">
          <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
            <button onClick={() => chooseFormat('pdf')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${format === 'pdf' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>PDF</button>
            <button onClick={() => chooseFormat('png')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${format === 'png' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>PNG</button>
          </div>
          <div className="flex items-center gap-2">
            {template === 'universal' && (
              <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
                <button onClick={() => chooseSlipFormat('a4')} title="A4 printer / PDF" className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${slipFormat === 'a4' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>
                  <FileText size={14} /> A4
                </button>
                <button onClick={() => chooseSlipFormat('thermal')} title="58/80mm Bluetooth thermal printer" className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${slipFormat === 'thermal' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>
                  <Receipt size={14} /> {t('y.thermal')}
                </button>
              </div>
            )}
            <button onClick={onClose} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
          </div>
        </div>

        {/* The document is a fixed ~560-640px wide because that IS the printed
            and exported size — making it fluid would change every generated
            PDF/PNG. So on a phone we scroll it horizontally instead of
            resizing it, leaving nodeRef's real box untouched for html2canvas. */}
        <div className="flex justify-center items-center p-4 overflow-x-auto" style={{ minHeight: 400 }}>
          {template ? (
            <ReceiptDocument ref={nodeRef} data={{ ...data, ...branding }} template={template} format={slipFormat} />
          ) : (
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>
          )}
        </div>

        {/* Each label stays on one line. These are flex-1 buttons holding an
            icon and a phrase ("Download PDF", "Share via WhatsApp"), so on a
            narrow phone they used to wrap into two ragged rows of text and the
            three buttons stopped lining up. whitespace-nowrap keeps every
            label intact; the row scrolls sideways if the three genuinely
            cannot fit, the same treatment the document above already gets,
            because a readable label you have to scroll to beats a squashed
            one you cannot read at all. shrink-0 is what makes that real —
            without it flex would shrink the buttons rather than overflow. */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-dp-outline-variant print:hidden overflow-x-auto">
          <button disabled={busy || !template} onClick={handlePrint} className="flex-1 shrink-0 whitespace-nowrap flex items-center justify-center gap-2 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
            <Printer size={16} className="shrink-0" /> {t('g.print')}
          </button>
          <button disabled={busy || !template} onClick={handleDownload} className="flex-1 shrink-0 whitespace-nowrap flex items-center justify-center gap-2 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
            <Download size={16} className="shrink-0" /> Download {format.toUpperCase()}
          </button>
          <button disabled={busy || !template} onClick={handleShare} className="flex-1 shrink-0 whitespace-nowrap flex items-center justify-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
            <Share2 size={16} className="shrink-0" /> {t('y.shareWhatsapp')}
          </button>
        </div>
      </div>
    </div>
  )
}
