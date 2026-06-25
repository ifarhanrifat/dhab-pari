'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Upload, Link as LinkIcon, Loader2, X, Film } from 'lucide-react'
import { toast } from 'sonner'

interface VideoUploadProps {
  onUpload: (url: string) => void
  currentUrl?: string
}

const MAX_SIZE = 100 * 1024 * 1024
const ACCEPTED_VIDEO = ['video/mp4', 'video/webm', 'video/ogg']

export function VideoUpload({ onUpload, currentUrl }: VideoUploadProps) {
  const [tab, setTab] = useState<'upload' | 'url'>(currentUrl && isYouTube(currentUrl) ? 'url' : 'upload')
  const [uploading, setUploading] = useState(false)
  const [urlInput, setUrlInput] = useState(currentUrl && isYouTube(currentUrl) ? currentUrl : '')
  const [uploadedUrl, setUploadedUrl] = useState(currentUrl && !isYouTube(currentUrl ?? '') ? currentUrl : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  const handleFile = async (file: File) => {
    if (!ACCEPTED_VIDEO.includes(file.type)) {
      toast.error('Invalid format. Use MP4, WebM, or OGG.')
      return
    }
    if (file.size > MAX_SIZE) {
      toast.error('File too large. Maximum 100MB.')
      return
    }

    setUploading(true)
    const fileName = `${Date.now()}_${file.name.replace(/\s+/g, '_')}`
    const { data, error } = await supabase.storage.from('videos').upload(fileName, file)

    if (error) {
      toast.error(`Upload failed: ${error.message}`)
      setUploading(false)
      return
    }

    const { data: urlData } = supabase.storage.from('videos').getPublicUrl(data.path)
    setUploadedUrl(urlData.publicUrl)
    onUpload(urlData.publicUrl)
    setUploading(false)
    toast.success('Video uploaded')
  }

  const applyUrl = () => {
    if (!urlInput.trim()) return
    onUpload(urlInput.trim())
    toast.success('YouTube URL set')
  }

  return (
    <div>
      <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
        Video Source
      </label>

      {/* Tabs */}
      <div className="flex mb-3 border border-dp-outline-variant rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setTab('upload')}
          className={`flex-1 py-2 font-sans text-[14px] font-semibold text-center cursor-pointer transition-all ${tab === 'upload' ? 'bg-dp-primary text-white' : 'bg-white text-dp-on-surface-variant hover:bg-dp-surface-container'}`}
        >
          <Upload size={14} className="inline mr-1" /> Upload File
        </button>
        <button
          type="button"
          onClick={() => setTab('url')}
          className={`flex-1 py-2 font-sans text-[14px] font-semibold text-center cursor-pointer transition-all ${tab === 'url' ? 'bg-dp-primary text-white' : 'bg-white text-dp-on-surface-variant hover:bg-dp-surface-container'}`}
        >
          <LinkIcon size={14} className="inline mr-1" /> YouTube URL
        </button>
      </div>

      {tab === 'upload' && (
        <>
          {uploadedUrl ? (
            <div className="relative rounded-lg border border-dp-outline-variant p-4 bg-dp-surface-container-low flex items-center gap-3">
              <Film size={20} className="text-dp-secondary shrink-0" />
              <p className="font-sans text-[14px] text-dp-on-surface truncate flex-1">{uploadedUrl.split('/').pop()}</p>
              <button type="button" onClick={() => { setUploadedUrl(''); onUpload('') }} className="text-dp-error cursor-pointer"><X size={16} /></button>
            </div>
          ) : (
            <div
              onClick={() => inputRef.current?.click()}
              className="border-2 border-dashed border-dp-outline-variant rounded-lg p-6 text-center cursor-pointer hover:border-dp-secondary hover:bg-dp-surface-container-low transition-all"
            >
              {uploading ? (
                <Loader2 size={24} className="mx-auto text-dp-secondary animate-spin mb-2" />
              ) : (
                <Upload size={24} className="mx-auto text-dp-on-surface-variant mb-2" />
              )}
              <p className="font-sans text-[14px] text-dp-on-surface-variant">
                {uploading ? 'Uploading...' : 'Drop video or click to browse'}
              </p>
              <p className="font-sans text-[12px] text-dp-outline mt-1">MP4, WebM, OGG · Max 100MB</p>
            </div>
          )}
          <input ref={inputRef} type="file" accept={ACCEPTED_VIDEO.join(',')} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} className="hidden" />
        </>
      )}

      {tab === 'url' && (
        <div className="flex gap-2">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://youtube.com/watch?v=..."
            className="input-field flex-1"
          />
          <button type="button" onClick={applyUrl} className="px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all shrink-0">
            Set
          </button>
        </div>
      )}
    </div>
  )
}

function isYouTube(url: string): boolean {
  return url.includes('youtube.com') || url.includes('youtu.be')
}
