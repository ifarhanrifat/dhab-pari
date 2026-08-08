'use client'

import { useState, useRef } from 'react'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { Paperclip, X, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface FileAttachmentProps {
  onUpload: (url: string) => void
  currentUrl?: string | null
  label?: string
}

const MAX_SIZE = 10 * 1024 * 1024
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

// A receipt photo or scanned document attached to a bill or purchase — unlike
// ImageUpload (gallery/news content), this also accepts PDFs and lives in its
// own "attachments" bucket, kept separate from public site image content.
export function FileAttachment({ onUpload, currentUrl, label = 'Attachment' }: FileAttachmentProps) {
  const [uploading, setUploading] = useState(false)
  const [fileUrl, setFileUrl] = useState<string | null>(currentUrl ?? null)
  const [fileName, setFileName] = useState<string | null>(currentUrl ? currentUrl.split('/').pop() ?? null : null)
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  const isImage = (url: string) => /\.(jpe?g|png|webp|gif)$/i.test(url)

  const handleFile = async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      toast.error('Invalid file type. Use JPG, PNG, WebP, or PDF.')
      return
    }
    if (file.size > MAX_SIZE) {
      toast.error('File too large. Maximum 10MB.')
      return
    }
    setUploading(true)
    const path = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`
    const { data, error } = await supabase.storage.from('attachments').upload(path, file)
    if (error) {
      toast.error(`Upload failed: ${error.message}`)
      setUploading(false)
      return
    }
    const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(data.path)
    onUpload(urlData.publicUrl)
    setFileUrl(urlData.publicUrl)
    setFileName(file.name)
    setUploading(false)
    toast.success('Attachment uploaded')
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  const clear = () => {
    setFileUrl(null)
    setFileName(null)
    onUpload('')
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{label}</label>
      {fileUrl ? (
        <div className="flex items-center gap-2 px-3 py-2.5 border border-dp-outline-variant rounded-lg bg-dp-surface-container-low/40">
          {isImage(fileUrl) ? (
            <Image src={fileUrl} alt="Attachment" width={36} height={36} className="w-9 h-9 rounded object-cover shrink-0" />
          ) : (
            <FileText size={20} className="text-dp-on-surface-variant shrink-0" />
          )}
          <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-0 font-sans text-[13.5px] text-dp-secondary hover:underline truncate">
            {fileName ?? 'View attachment'}
          </a>
          {uploading && <Loader2 size={16} className="animate-spin text-dp-on-surface-variant shrink-0" />}
          <button type="button" onClick={clear} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer shrink-0"><X size={15} /></button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-dp-outline-variant rounded-lg font-sans text-[13.5px] text-dp-on-surface-variant hover:border-dp-secondary hover:bg-dp-surface-container-low transition-all cursor-pointer disabled:opacity-50"
        >
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={15} />}
          {uploading ? 'Uploading...' : 'Attach receipt / photo / PDF'}
        </button>
      )}
      <input ref={inputRef} type="file" accept={ACCEPTED.join(',')} onChange={onInputChange} className="hidden" />
    </div>
  )
}
