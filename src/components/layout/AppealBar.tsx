'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, Phone, MessageCircle } from 'lucide-react'

interface Appeal {
  id: string
  kind: string
  title_en: string | null
  title_ur: string | null
  body_en: string
  body_ur: string
  contact_number: string | null
}

// Deliberately NOT part of the announcement ticker. A blood appeal posted into
// that bar was correct in the database and invisible in practice: it became the
// eighth message in a single scrolling line, in the same colour as "free
// medical camp every Tuesday". An appeal gets its own bar, its own colour, and
// stands still long enough to be read.
export function AppealBar({ source }: { source: 'public' | 'portal' }) {
  const [appeals, setAppeals] = useState<Appeal[]>([])
  const [index, setIndex] = useState(0)

  const rpc = source === 'portal' ? 'my_appeals' : 'public_appeals'

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase.rpc(rpc)
    setAppeals((data ?? []) as Appeal[])
  }, [rpc])

  // Every two minutes. Someone already sitting on the page when an appeal goes
  // up is exactly the person it needs to reach, and the old bar only ever
  // fetched once on mount — which is why a posted appeal appeared to do
  // nothing until a reload.
  useEffect(() => {
    load()
    const id = setInterval(load, 120000)
    return () => clearInterval(id)
  }, [load])

  // With more than one live appeal, alternate rather than stack: two red bars
  // is a wall, and a wall gets scrolled past.
  useEffect(() => {
    if (appeals.length < 2) return
    const id = setInterval(() => setIndex((i) => (i + 1) % appeals.length), 8000)
    return () => clearInterval(id)
  }, [appeals.length])

  if (appeals.length === 0) return null
  const a = appeals[index % appeals.length]
  const tel = (a.contact_number ?? '').replace(/[^0-9]/g, '').replace(/^0/, '92')

  return (
    <div className="bg-dp-error/10 border-y-2 border-dp-error print:hidden">
      <div className="max-w-[1200px] mx-auto px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <AlertTriangle size={17} className="text-dp-error shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p dir="rtl" className="font-urdu text-[14px] font-bold text-dp-error leading-relaxed">
              {a.body_ur}
            </p>
            <p className="font-sans text-[12.5px] font-semibold text-dp-error/90 leading-snug mt-0.5">
              {a.body_en}
            </p>
          </div>
        </div>

        {a.contact_number && (
          <div className="flex gap-2 shrink-0">
            <a href={`tel:${tel}`} aria-label="Call"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dp-error text-white font-sans text-[12.5px] font-bold hover:opacity-90 transition-opacity">
              <Phone size={13} /> {a.contact_number}
            </a>
            <a href={`https://wa.me/${tel}`} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp"
              className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-lg bg-[#25D366] text-white hover:opacity-90 transition-opacity">
              <MessageCircle size={14} />
            </a>
          </div>
        )}
      </div>

      {appeals.length > 1 && (
        <div className="flex justify-center gap-1 pb-1.5">
          {appeals.map((x, i) => (
            <span key={x.id}
              className={`h-1 rounded-full transition-all ${i === index % appeals.length ? 'w-4 bg-dp-error' : 'w-1 bg-dp-error/30'}`} />
          ))}
        </div>
      )}
    </div>
  )
}
