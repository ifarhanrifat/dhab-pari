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
  getPreferredSlipTarget, setPreferredSlipTarget, lastRenderTiming,
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

  // The roll gets a page cut to the receipt (a roll has no page length); the
  // sheet target gets a real A4 page. Passing this through is the whole fix
  // for "the A4 print is not A4 size" — the export used to size every page to
  // the content, so the A4 button produced a custom 210×~280mm page that a
  // print dialog then rescaled onto the actual sheet.
  const pdfPage = () => (slipFormat === 'thermal' ? 'content' : 'a4')

  // The preview on screen is a live DOM render, not a file — every action
  // (Print/Download/WhatsApp) used to re-rasterize that same DOM from
  // scratch on every click, which is real, perceptible work that looked
  // like "why is it downloading again, it's already right there." Cached
  // per (format, pdfPage) pair — a PDF's page sizing depends on the A4/
  // thermal toggle too, so the key has to include both, not just format.
  const blobCacheRef = useRef<{ key: string; blob: Blob } | null>(null)
  const cacheKey = () => `${format}:${format === 'pdf' ? pdfPage() : ''}`

  // renderMs is 0 on a cache hit -- kept alongside the blob (rather than a
  // separate call) so a slow-share report's toast can say whether the render
  // itself was the cost or not, without a second measurement point drifting
  // out of sync with what buildBlob() actually did. html2canvasMs/
  // postProcessMs split that further after a real report (2026-09-22) where
  // the total render time nearly TRIPLED (7s -> 19.9s) on the same device
  // right after a fix meant to bring it down -- proof the earlier single
  // "render Xms" number wasn't enough to tell whether html2canvas itself is
  // the cost, or something in the PDF/PNG post-processing around it.
  const buildBlob = async (): Promise<{ blob: Blob; renderMs: number; html2canvasMs: number; postProcessMs: number }> => {
    const key = cacheKey()
    if (blobCacheRef.current?.key === key) return { blob: blobCacheRef.current.blob, renderMs: 0, html2canvasMs: 0, postProcessMs: 0 }
    if (!nodeRef.current) throw new Error('Receipt not ready')
    const start = performance.now()
    const blob = format === 'pdf' ? await nodeToPdfBlob(nodeRef.current, pdfPage()) : await nodeToPngBlob(nodeRef.current)
    const renderMs = Math.round(performance.now() - start)
    blobCacheRef.current = { key, blob }
    return { blob, renderMs, html2canvasMs: lastRenderTiming?.html2canvasMs ?? 0, postProcessMs: lastRenderTiming?.postProcessMs ?? 0 }
  }

  const filename = () => `receipt-${data.receiptNo}.${format === 'pdf' ? 'pdf' : 'png'}`

  const handlePrint = async () => {
    setBusy(true)
    try {
      // Print the generated PDF in its own blob document, never the live admin page —
      // printing the page itself would leak the internal admin URL into the printout.
      const blob = format === 'pdf' ? (await buildBlob()).blob : await nodeToPdfBlob(nodeRef.current!, pdfPage())
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
      const { blob } = await buildBlob()
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
      const { blob, renderMs, html2canvasMs, postProcessMs } = await buildBlob()
      const mime = format === 'pdf' ? 'application/pdf' : 'image/png'
      // A PDF cannot be pasted into a chat, so the clipboard always gets a
      // PNG — but only actually rendered if shareReceipt() ends up needing
      // it (native attach succeeding is the common case now, and skips
      // this entirely; a PDF's separate html2canvas pass for the clipboard
      // copy was real, measurable time wasted on every share before this).
      const getClipboardBlob = async () => (format === 'png' ? blob : await nodeToPngBlob(nodeRef.current!))

      const result = await shareReceipt({
        blob, filename: filename(), mime, phone, contactName: data.accountName, getClipboardBlob,
        message: `Receipt ${data.receiptNo} — ${data.amount.toLocaleString()}`,
      })
      // Real timing breakdown after a "takes too long to get to WhatsApp"
      // report -- render (html2canvas, 0 on a cache hit) + base64 encode +
      // the JS<->native bridge transfer, so a slow report is diagnosable
      // from the toast text alone, no connected device needed. Native
      // launching WhatsApp itself isn't measurable from here -- if this
      // total reads low but the wait still feels long, that's the next
      // place to look, not this app's own code.
      const t = result.nativeTimingMs
      // Direct check of what html2canvas was actually handed -- if this
      // reads "url" (not "data:"), the branding.ts logo fix silently fell
      // back to the slow remote-fetch path for this exact share, which is
      // now the single highest-value bit to confirm before chasing
      // anything else about html2canvas's own 7+ second cost.
      const logoKind = data.logoUrl ? (data.logoUrl.startsWith('data:') ? 'data:' : 'url') : 'none'
      const timingNote = t ? ` [render ${renderMs}ms (canvas ${html2canvasMs}ms + post ${postProcessMs}ms), encode ${t.base64Encode}ms, bridge ${t.nativeBridgeCall}ms, ${(t.blobBytes / 1024).toFixed(0)}KB, logo=${logoKind}]` : ''
      toast.success(
        (result.outcome === 'attached-direct'
          ? 'WhatsApp opened straight to their chat, file attached'
          : result.outcome === 'attached'
          ? `WhatsApp opened with the file attached — pick who to send it to${result.jidSkipReason ? ` (${result.jidSkipReason})` : ''}`
          : result.outcome === 'copied'
          ? 'Image copied — press Ctrl+V (⌘V) in the WhatsApp chat to attach it'
          : 'Downloaded — attach it in the chat that just opened') + timingNote,
        // Default duration is too short to read a timing breakdown before it
        // vanishes (real report: "I can only read 1726ms" before it's gone).
        // Long enough to actually read + copy the numbers back, not so long
        // it lingers awkwardly once WhatsApp is already on screen.
        timingNote ? { duration: 15000 } : undefined
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
