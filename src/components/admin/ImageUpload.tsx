'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Upload, X, Image as ImageIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface ImageUploadProps {
  bucket: 'images' | 'thumbnails'
  onUpload: (url: string) => void
  currentUrl?: string
  label?: string
}

const MAX_SIZE = 5 * 1024 * 1024
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export function ImageUpload({ bucket, onUpload, currentUrl, label = 'Upload Image' }: ImageUploadProps) {
  const { t } = useLocale()
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<string | null>(currentUrl ?? null)
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

    const objectUrl = URL.createObjectURL(file)
    setPreview(objectUrl)
    setUploading(true)

    const fileName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`
    const { data, error } = await supabase.storage.from(bucket).upload(fileName, file)

    if (error) {
      toast.error(`Upload failed: ${error.message}`)
      setPreview(currentUrl ?? null)
      setUploading(false)
      return
    }

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(data.path)
    onUpload(urlData.publicUrl)
    setPreview(urlData.publicUrl)
    setUploading(false)
    toast.success('Image uploaded')
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
    onUpload('')
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
        {label}
      </label>

      {preview ? (
        <div className="relative rounded-lg overflow-hidden border border-dp-outline-variant bg-dp-surface-container">
          <img src={preview} alt="Preview" className="w-full h-40 object-cover" />
          {uploading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <Loader2 size={24} className="text-white animate-spin" />
            </div>
          )}
          {!uploading && (
            <div className="absolute top-2 right-2 flex gap-2">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="bg-white/90 text-dp-on-surface px-2 py-1 rounded text-[12px] font-sans font-semibold hover:bg-white cursor-pointer"
              >
                Change
              </button>
              <button
                type="button"
                onClick={clear}
                className="bg-white/90 text-dp-error p-1 rounded hover:bg-white cursor-pointer"
              >
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
            dragOver
              ? 'border-dp-secondary bg-dp-secondary/5'
              : 'border-dp-outline-variant hover:border-dp-secondary hover:bg-dp-surface-container-low'
          }`}
        >
          <Upload size={24} className="mx-auto text-dp-on-surface-variant mb-2" />
          <p className="font-sans text-[14px] text-dp-on-surface-variant">
            {t('g.dragDrop')} <span className="text-dp-secondary font-semibold">click to browse</span>
          </p>
          <p className="font-sans text-[12px] text-dp-outline mt-1">
            {t('g.fileTypes')}
          </p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        onChange={onInputChange}
        className="hidden"
      />
    </div>
  )
}
