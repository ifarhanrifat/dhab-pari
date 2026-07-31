'use client'

import { useRef, useState, useEffect } from 'react'
import { X, Printer, Download, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { ReceiptDocument, type ReceiptData, type InvoiceTemplate } from './ReceiptDocument'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'
import {
  getPreferredFormat, setPreferredFormat, nodeToPdfBlob, nodeToPngBlob,
  downloadBlob, shareReceipt, printBlob, type ReceiptFormat,
} from '@/lib/receiptExport'

interface ReceiptModalProps {
  data: ReceiptData
  phone?: string | null
  onClose: () => void
}

export function ReceiptModal({ data, phone, onClose }: ReceiptModalProps) {
  const nodeRef = useRef<HTMLDivElement>(null)
  const [format, setFormat] = useState<ReceiptFormat>(getPreferredFormat())
  const [busy, setBusy] = useState(false)
  const [template, setTemplate] = useState<InvoiceTemplate>('classic')
  const [branding, setBranding] = useState<Partial<BrandingSettings>>({})

  useEffect(() => {
    fetchBrandingSettings().then((b) => {
      setTemplate(b.invoiceTemplate)
      setBranding(b)
    })
  }, [])

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
      const result = await shareReceipt({
        blob, filename: filename(), mime, phone,
        message: `Receipt ${data.receiptNo} — Rs. ${data.amount.toLocaleString()}`,
      })
      toast.success(result === 'shared' ? 'Shared' : 'Downloaded — share it from your files app')
    } catch {
      toast.error('Could not share the receipt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[120] flex items-center justify-center p-4 print:bg-white print:p-0" onClick={onClose}>
      <div className="bg-white rounded-lg max-h-[92vh] overflow-y-auto print:max-h-none print:overflow-visible print:rounded-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-dp-outline-variant print:hidden">
          <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
            <button onClick={() => chooseFormat('pdf')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${format === 'pdf' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>PDF</button>
            <button onClick={() => chooseFormat('png')} className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${format === 'png' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}>PNG</button>
          </div>
          <button onClick={onClose} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
        </div>

        <div className="flex justify-center p-4">
          <ReceiptDocument ref={nodeRef} data={{ ...data, ...branding }} template={template} />
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-dp-outline-variant print:hidden">
          <button disabled={busy} onClick={handlePrint} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
            <Printer size={16} /> Print
          </button>
          <button disabled={busy} onClick={handleDownload} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50">
            <Download size={16} /> Download {format.toUpperCase()}
          </button>
          <button disabled={busy} onClick={handleShare} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
            <Share2 size={16} /> Share via WhatsApp
          </button>
        </div>
      </div>
    </div>
  )
}
