'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Mic, Square, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface VoiceRecorderProps {
  onUpload: (url: string) => void
}

// Records a short voice note in-browser (MediaRecorder — no extra dependency)
// and uploads it to the same "attachments" bucket FileAttachment already uses,
// so a complaint update can carry a voice message the way the feature spec
// asked for, not just a text comment.
export function VoiceRecorder({ onUpload }: VoiceRecorderProps) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const supabase = createClient()

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        setPreviewUrl(URL.createObjectURL(blob))
        stream.getTracks().forEach((t) => t.stop())
      }
      mediaRecorderRef.current = recorder
      recorder.start()
      setRecording(true)
      setSeconds(0)
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
    } catch {
      toast.error('Microphone access denied or unavailable')
    }
  }

  const stopRecording = () => {
    mediaRecorderRef.current?.stop()
    setRecording(false)
    if (timerRef.current) clearInterval(timerRef.current)
  }

  const discard = () => {
    setPreviewUrl(null)
    setSeconds(0)
    chunksRef.current = []
  }

  const upload = async () => {
    if (chunksRef.current.length === 0) return
    setUploading(true)
    const blob = new Blob(chunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' })
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
    const path = `voice_${Date.now()}.${ext}`
    const { data, error } = await supabase.storage.from('attachments').upload(path, blob)
    setUploading(false)
    if (error) { toast.error(`Upload failed: ${error.message}`); return }
    const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(data.path)
    onUpload(urlData.publicUrl)
    setPreviewUrl(null)
    chunksRef.current = []
    toast.success('Voice message attached')
  }

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  if (previewUrl) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 border border-dp-outline-variant rounded-lg bg-dp-surface-container-low/40">
        <audio src={previewUrl} controls className="h-9 flex-1 min-w-0" />
        <button type="button" disabled={uploading} onClick={upload} className="px-2.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50 shrink-0">
          {uploading ? <Loader2 size={13} className="animate-spin" /> : 'Attach'}
        </button>
        <button type="button" onClick={discard} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer shrink-0"><X size={15} /></button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={recording ? stopRecording : startRecording}
      className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed rounded-lg font-sans text-[13.5px] transition-all cursor-pointer ${recording ? 'border-dp-error text-dp-error bg-red-50' : 'border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary hover:bg-dp-surface-container-low'}`}
    >
      {recording ? <Square size={15} /> : <Mic size={15} />}
      {recording ? `Recording... ${fmtTime(seconds)} (tap to stop)` : 'Record voice message'}
    </button>
  )
}
