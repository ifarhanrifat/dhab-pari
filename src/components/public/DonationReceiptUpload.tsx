'use client'

// Public, unauthenticated upload for a donation's payment screenshot. Unlike
// ImageUpload (src/components/admin/ImageUpload.tsx), the target bucket
// (donation_receipts) is NOT public-read — a payment screenshot can show
// account numbers/other names — so this stores the object *path*, not a
// public URL, and staff view it later through a signed URL (see the
// admin donors page). Kept separate from ImageUpload rather than widening
// its bucket union, since the private-bucket/path-vs-URL behavior differs
// enough to not share one component cleanly.

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Upload, X, Loader2, FileImage } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Props {
  onUpload: (path: string) => void
  label?: string
  bucket?: 'donation_receipts' | 'bill_payment_proofs' | 'wazifa_agreement_documents' | 'vehicle_registration_documents' | 'city_purchase_attachments'
}

const MAX_SIZE = 5 * 1024 * 1024
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export function DonationReceiptUpload({ onUpload, label, bucket = 'donation_receipts' }: Props) {
  const { t, isUrdu } = useLocale()
  const resolvedLabel = label ?? t('g.uploadPaymentScreenshot')
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  const handleFile = async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      toast.error(t('g.invalidFileType'))
      return
    }
    if (file.size > MAX_SIZE) {
      toast.error(t('g.fileTooLarge'))
      return
    }

    setPreview(URL.createObjectURL(file))
    setUploading(true)
    const path = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`
    const { data, error } = await supabase.storage.from(bucket).upload(path, file)
    setUploading(false)

    if (error) {
      toast.error(`${t('g.uploadFailed')}: ${error.message}`)
      setPreview(null)
      return
    }

    setFileName(file.name)
    onUpload(data.path)
    toast.success(t('g.receiptUploaded'))
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const clear = () => {
    setPreview(null)
    setFileName(null)
    onUpload('')
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <label dir={isUrdu ? 'rtl' : 'ltr'} className="block font-sans text-[15px] font-semibold tracking-[0.05em] text-slate-500 mb-2">
        {resolvedLabel} *
      </label>

      {preview ? (
        <div className="relative rounded-xl overflow-hidden border border-dp2-card-border bg-dp2-surface">
          <img src={preview} alt="Receipt preview" className="w-full h-40 object-cover" />
          {uploading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <Loader2 size={24} className="text-white animate-spin" />
            </div>
          )}
          {!uploading && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {fileName && <span className="bg-white/90 px-2 py-1 rounded-full text-[12px] font-sans truncate max-w-[140px]">{fileName}</span>}
              <button type="button" onClick={clear} className="bg-white/90 text-red-600 p-1 rounded-full hover:bg-white cursor-pointer">
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
            dragOver ? 'border-dp2-primary-dark bg-dp2-primary-dark/5' : 'border-dp2-card-border hover:border-dp2-primary-dark hover:bg-dp2-surface'
          }`}
        >
          <FileImage size={24} className="mx-auto text-slate-500 mb-2" />
          <p dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[15px] text-slate-500">
            <Upload size={14} className="inline me-1" />
            {t('g.dragDrop')} <span className="text-dp2-primary-dark font-semibold">{t('g.clickToBrowse')}</span>
          </p>
          <p dir={isUrdu ? 'rtl' : 'ltr'} className="font-sans text-[13px] text-slate-400 mt-1">{t('g.fileTypes')}</p>
        </div>
      )}

      <input ref={inputRef} type="file" accept={ACCEPTED.join(',')} onChange={onInputChange} className="hidden" />
    </div>
  )
}
