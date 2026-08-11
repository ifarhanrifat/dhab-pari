'use client'

import { useState, useRef } from 'react'
import NextImage from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { Upload, X, Loader2, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'

interface MultiImageUploadProps {
  bucket: 'images' | 'thumbnails' | 'attachments'
  onUpload: (urls: string[]) => void
  currentUrls?: string[]
  label?: string
  max?: number
}

const MAX_SIZE = 5 * 1024 * 1024
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export function MultiImageUpload({ bucket, onUpload, currentUrls = [], label = 'Upload Images', max = 10 }: MultiImageUploadProps) {
  const [urls, setUrls] = useState<string[]>(currentUrls)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  const handleFiles = async (files: FileList) => {
    const validFiles = Array.from(files).filter((f) => {
      if (!ACCEPTED.includes(f.type)) { toast.error(`${f.name}: invalid type`); return false }
      if (f.size > MAX_SIZE) { toast.error(`${f.name}: exceeds 5MB`); return false }
      return true
    })

    if (urls.length + validFiles.length > max) {
      toast.error(`Maximum ${max} images allowed`)
      return
    }

    setUploading(true)
    const newUrls: string[] = []

    for (const file of validFiles) {
      const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${file.name.replace(/\s+/g, '_')}`
      const { data, error } = await supabase.storage.from(bucket).upload(fileName, file)
      if (error) {
        toast.error(`Failed: ${file.name}`)
        continue
      }
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(data.path)
      newUrls.push(urlData.publicUrl)
    }

    const updated = [...urls, ...newUrls]
    setUrls(updated)
    onUpload(updated)
    setUploading(false)
    if (newUrls.length > 0) toast.success(`${newUrls.length} image(s) uploaded`)
  }

  const removeUrl = (index: number) => {
    const updated = urls.filter((_, i) => i !== index)
    setUrls(updated)
    onUpload(updated)
  }

  return (
    <div>
      <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
        {label} ({urls.length}/{max})
      </label>

      {/* Existing images grid */}
      {urls.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          {urls.map((url, i) => (
            <div key={i} className="relative rounded-lg overflow-hidden border border-dp-outline-variant group aspect-square">
              <NextImage src={url} alt="" fill sizes="200px" className="object-cover" />
              <button
                type="button"
                onClick={() => removeUrl(i)}
                className="absolute top-1 end-1 bg-black/50 text-white p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload zone */}
      {urls.length < max && (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files) }}
          className="border-2 border-dashed border-dp-outline-variant rounded-lg p-6 text-center cursor-pointer hover:border-dp-secondary hover:bg-dp-surface-container-low transition-all"
        >
          {uploading ? (
            <Loader2 size={24} className="mx-auto text-dp-secondary animate-spin mb-2" />
          ) : (
            <Upload size={24} className="mx-auto text-dp-on-surface-variant mb-2" />
          )}
          <p className="font-sans text-[14px] text-dp-on-surface-variant">
            {uploading ? 'Uploading...' : 'Drop images or click to browse (multiple)'}
          </p>
          <p className="font-sans text-[12px] text-dp-outline mt-1">JPG, PNG, WebP, GIF · Max 5MB each</p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        multiple
        onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files) }}
        className="hidden"
      />
    </div>
  )
}
