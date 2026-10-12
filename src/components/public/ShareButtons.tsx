'use client'

import { useState } from 'react'
import { Share2, Copy, MessageCircle } from 'lucide-react'
import { toast } from 'sonner'

export function ShareButtons({ url, text, compact = false }: { url: string; text: string; compact?: boolean }) {
  const [showFallback, setShowFallback] = useState(false)

  const share = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: text, url }); return } catch { return }
    }
    setShowFallback(true)
  }

  const copy = async () => {
    await navigator.clipboard.writeText(url)
    toast.success('لنک کاپی ہو گیا / Link copied')
  }

  return (
    <div className={compact ? 'inline-block' : 'w-full'}>
      {compact ? (
        <button onClick={share} title="Share"
          className="flex items-center gap-1.5 text-[13.5px] font-sans font-semibold text-slate-500 hover:text-dp2-primary-dark transition-colors cursor-pointer">
          <Share2 size={14} /> شیئر / Share
        </button>
      ) : (
        <button onClick={share}
          className="w-full flex items-center justify-center gap-2 bg-dp2-primary-dark text-white py-3.5 rounded-xl font-sans text-[16px] font-bold hover:brightness-110 transition-all cursor-pointer">
          <Share2 size={18} /> شیئر کریں / Share
        </button>
      )}

      {showFallback && (
        <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center p-4" onClick={() => setShowFallback(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-2.5">
              <a href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`} target="_blank" rel="noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-[#25D366] text-white py-2.5 rounded-xl font-sans text-[14.5px] font-semibold hover:opacity-90 transition-all">
                <MessageCircle size={16} /> WhatsApp
              </a>
              <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-[#1877F2] text-white py-2.5 rounded-xl font-sans text-[14.5px] font-semibold hover:opacity-90 transition-all">
                <span className="font-heading text-[16px] font-black leading-none">f</span> Facebook
              </a>
              <button onClick={copy}
                className="w-full flex items-center justify-center gap-2 border border-dp2-card-border text-slate-800 py-2.5 rounded-xl font-sans text-[14.5px] font-semibold hover:border-dp2-primary-dark transition-all cursor-pointer">
                <Copy size={15} /> لنک کاپی کریں / Copy link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
