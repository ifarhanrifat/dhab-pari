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

interface Props {
  onUpload: (path: string) => void
  label?: string
  bucket?: 'donation_receipts' | 'bill_payment_proofs'
}

const MAX_SIZE = 5 * 1024 * 1024
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export function DonationReceiptUpload({ onUpload, label = 'Upload Payment Screenshot', bucket = 'donation_receipts' }: Props) {
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  const handleFile = async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      toast.error('Invalid file type. Use JPG, PNG, WebP, or GIF.')
      return
    }
    if (file.size > MAX_SIZE) {
      toast.error('File too large. Maximum 5MB.')
      return
    }

    setPreview(URL.createObjectURL(file))
    setUploading(true)
    const path = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`
    const { data, error } = await supabase.storage.from(bucket).upload(path, file)
    setUploading(false)

    if (error) {
      toast.error(`Upload failed: ${error.message}`)
      setPreview(null)
      return
    }

    setFileName(file.name)
    onUpload(data.path)
    toast.success('Receipt uploaded')
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
      <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
        {label} *
      </label>

      {preview ? (
        <div className="relative rounded-lg overflow-hidden border border-dp-outline-variant bg-dp-surface-container">
          <img src={preview} alt="Receipt preview" className="w-full h-40 object-cover" />
          {uploading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <Loader2 size={24} className="text-white animate-spin" />
            </div>
          )}
          {!uploading && (
            <div className="absolute top-2 end-2 flex items-center gap-2">
              {fileName && <span className="bg-white/90 px-2 py-1 rounded text-[11px] font-sans truncate max-w-[140px]">{fileName}</span>}
              <button type="button" onClick={clear} className="bg-white/90 text-dp-error p-1 rounded hover:bg-white cursor-pointer">
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
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all ${
            dragOver ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:border-dp-secondary hover:bg-dp-surface-container-low'
          }`}
        >
          <FileImage size={24} className="mx-auto text-dp-on-surface-variant mb-2" />
          <p className="font-sans text-[14px] text-dp-on-surface-variant">
            <Upload size={14} className="inline me-1" />
            Drag & drop or <span className="text-dp-secondary font-semibold">click to browse</span>
          </p>
          <p className="font-sans text-[12px] text-dp-outline mt-1">JPG, PNG, WebP, GIF · Max 5MB</p>
        </div>
      )}

      <input ref={inputRef} type="file" accept={ACCEPTED.join(',')} onChange={onInputChange} className="hidden" />
    </div>
  )
}
