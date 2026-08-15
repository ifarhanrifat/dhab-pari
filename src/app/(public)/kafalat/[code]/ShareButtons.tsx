'use client'

import { useState } from 'react'
import { Share2, Copy, MessageCircle } from 'lucide-react'
import { toast } from 'sonner'

export function ShareButtons({ url, text }: { url: string; text: string }) {
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
    <div className="w-full">
      <button onClick={share}
        className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3.5 rounded-lg font-sans text-[15px] font-bold hover:bg-dp-primary transition-all cursor-pointer">
        <Share2 size={18} /> شیئر کریں / Share
      </button>

      {showFallback && (
        <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center p-4" onClick={() => setShowFallback(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-2.5">
              <a href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`} target="_blank" rel="noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-[#25D366] text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:opacity-90 transition-all">
                <MessageCircle size={16} /> WhatsApp
              </a>
              <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-[#1877F2] text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:opacity-90 transition-all">
                <span className="font-heading text-[15px] font-black leading-none">f</span> Facebook
              </a>
              <button onClick={copy}
                className="w-full flex items-center justify-center gap-2 border border-dp-outline-variant text-dp-on-surface py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:border-dp-secondary transition-all cursor-pointer">
                <Copy size={15} /> لنک کاپی کریں / Copy link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
