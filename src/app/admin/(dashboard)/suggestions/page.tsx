'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { MessageSquare, X, Send, CheckCircle, Clock, Eye } from 'lucide-react'
import { toast } from 'sonner'

interface Suggestion {
  id: string
  name: string | null
  mobile: string | null
  message: string
  type: string
  status: string
  admin_notes: string | null
  created_at: string
}

const statusColors: Record<string, string> = {
  new: 'bg-blue-100 text-blue-700',
  reviewed: 'bg-amber-100 text-amber-800',
  actioned: 'bg-dp-secondary-container text-dp-on-secondary-container',
}

const typeColors: Record<string, string> = {
  suggestion: 'bg-blue-50 text-blue-700',
  complaint: 'bg-red-50 text-red-700',
  volunteer: 'bg-emerald-50 text-emerald-700',
  general: 'bg-gray-100 text-gray-700',
}

export default function AdminSuggestionsPage() {
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<Suggestion | null>(null)
  const [reply, setReply] = useState('')
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase
      .from('suggestions')
      .select('*')
      .order('created_at', { ascending: false })
    setItems(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const filtered = filter === 'all' ? items : items.filter((s) => s.status === filter)

  const updateStatus = async (id: string, status: string) => {
    await supabase.from('suggestions').update({ status }).eq('id', id)
    toast.success(`Marked as ${status}`)
    load()
    if (selected?.id === id) setSelected({ ...selected, status })
  }

  const sendReply = async () => {
    if (!selected || !reply.trim()) return
    const notes = selected.admin_notes
      ? `${selected.admin_notes}\n\n--- Reply (${new Date().toLocaleDateString()}) ---\n${reply}`
      : `--- Reply (${new Date().toLocaleDateString()}) ---\n${reply}`

    await supabase.from('suggestions').update({
      admin_notes: notes,
      status: 'reviewed',
    }).eq('id', selected.id)

    if (selected.mobile) {
      await supabase.from('notifications_log').insert({
        type: 'whatsapp',
        recipient: selected.mobile,
        message: reply,
        status: 'pending',
      })
    }

    toast.success('Reply saved' + (selected.mobile ? ' & queued for WhatsApp' : ''))
    setReply('')
    setSelected({ ...selected, admin_notes: notes, status: 'reviewed' })
    load()
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="font-heading text-[24px] sm:text-[32px] font-bold leading-[32px] sm:leading-[40px] text-dp-primary">
          Suggestions & Complaints
        </h1>
        <span className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant">
          {items.filter((s) => s.status === 'new').length} new
        </span>
      </div>

      {/* Filter */}
      <div className="flex flex-wrap gap-3 mb-6">
        {['all', 'new', 'reviewed', 'actioned'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em] cursor-pointer transition-all ${
              filter === f
                ? 'bg-dp-primary text-white'
                : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary'
            }`}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className="flex gap-6">
        {/* List */}
        <div className="flex-1 space-y-3">
          {loading && <div className="text-center py-12 text-dp-on-surface-variant">Loading...</div>}
          {!loading && filtered.map((s) => (
            <div
              key={s.id}
              onClick={() => { setSelected(s); setReply('') }}
              className={`bg-white border rounded-lg p-4 cursor-pointer transition-all hover:border-dp-secondary ${
                selected?.id === s.id ? 'border-dp-secondary ring-2 ring-dp-secondary/20' : 'border-dp-outline-variant'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full font-sans ${typeColors[s.type]}`}>
                  {s.type}
                </span>
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full font-sans ${statusColors[s.status]}`}>
                  {s.status}
                </span>
                <span className="text-[12px] font-sans text-dp-on-surface-variant ml-auto">
                  {new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <p className="font-sans text-[14px] text-dp-on-surface line-clamp-2">{s.message}</p>
              <div className="flex items-center gap-3 mt-2 text-[12px] font-sans text-dp-on-surface-variant">
                {s.name && <span>{s.name}</span>}
                {s.mobile && <span>{s.mobile}</span>}
              </div>
            </div>
          ))}
          {!loading && filtered.length === 0 && (
            <div className="text-center py-12 text-dp-on-surface-variant font-sans">No submissions found.</div>
          )}
        </div>

        {/* Detail Panel */}
        {selected && (
          <div className="w-[400px] shrink-0 bg-white border border-dp-outline-variant rounded-lg p-6 sticky top-6 self-start max-h-[80vh] overflow-y-auto hidden lg:block">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <MessageSquare size={18} className="text-dp-primary" />
                <h3 className="font-sans text-[18px] font-bold text-dp-primary">Details</h3>
              </div>
              <button onClick={() => setSelected(null)} className="cursor-pointer text-dp-on-surface-variant">
                <X size={18} />
              </button>
            </div>

            {/* Meta */}
            <div className="space-y-2 mb-4 pb-4 border-b border-dp-outline-variant">
              <div className="flex justify-between text-[14px] font-sans">
                <span className="text-dp-on-surface-variant">From:</span>
                <span className="font-semibold">{selected.name || 'Anonymous'}</span>
              </div>
              {selected.mobile && (
                <div className="flex justify-between text-[14px] font-sans">
                  <span className="text-dp-on-surface-variant">Mobile:</span>
                  <span className="font-semibold">{selected.mobile}</span>
                </div>
              )}
              <div className="flex justify-between text-[14px] font-sans">
                <span className="text-dp-on-surface-variant">Type:</span>
                <span className={`text-[12px] font-bold uppercase px-2 py-0.5 rounded-full ${typeColors[selected.type]}`}>{selected.type}</span>
              </div>
              <div className="flex justify-between text-[14px] font-sans">
                <span className="text-dp-on-surface-variant">Date:</span>
                <span>{new Date(selected.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
              </div>
            </div>

            {/* Message */}
            <div className="mb-4 pb-4 border-b border-dp-outline-variant">
              <h4 className="font-sans text-[14px] font-semibold text-dp-on-surface-variant mb-2">Message</h4>
              <p className="font-sans text-[14px] text-dp-on-surface whitespace-pre-wrap">{selected.message}</p>
            </div>

            {/* Admin Notes / Previous Replies */}
            {selected.admin_notes && (
              <div className="mb-4 pb-4 border-b border-dp-outline-variant">
                <h4 className="font-sans text-[14px] font-semibold text-dp-on-surface-variant mb-2">Admin Notes</h4>
                <div className="bg-dp-surface-container-low p-3 rounded-lg">
                  <p className="font-sans text-[14px] text-dp-on-surface whitespace-pre-wrap">{selected.admin_notes}</p>
                </div>
              </div>
            )}

            {/* Status Actions */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => updateStatus(selected.id, 'reviewed')}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer transition-all ${selected.status === 'reviewed' ? 'bg-amber-100 text-amber-800' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container'}`}
              >
                <Eye size={12} /> Reviewed
              </button>
              <button
                onClick={() => updateStatus(selected.id, 'actioned')}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-sans font-semibold cursor-pointer transition-all ${selected.status === 'actioned' ? 'bg-dp-secondary-container text-dp-on-secondary-container' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container'}`}
              >
                <CheckCircle size={12} /> Actioned
              </button>
            </div>

            {/* Reply */}
            <div>
              <h4 className="font-sans text-[14px] font-semibold text-dp-on-surface-variant mb-2">Reply</h4>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={3}
                placeholder="Write your reply..."
                className="input-field resize-none mb-3"
              />
              <button
                onClick={sendReply}
                disabled={!reply.trim()}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50"
              >
                <Send size={14} />
                Send Reply {selected.mobile ? '(+ WhatsApp)' : ''}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
