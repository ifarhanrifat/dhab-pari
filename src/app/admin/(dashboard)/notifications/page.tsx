'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send, MessageCircle } from 'lucide-react'
import { toast } from 'sonner'

interface LogEntry { id: string; type: string; recipient: string | null; message: string | null; status: string; sent_at: string | null; created_at: string }

export default function AdminNotificationsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [audience, setAudience] = useState('all')
  const [sending, setSending] = useState(false)
  const supabase = createClient()

  const load = async () => { const { data } = await supabase.from('notifications_log').select('*').order('created_at', { ascending: false }).limit(20); setLogs(data ?? []); setLoading(false) }
  useEffect(() => { load() }, [])

  const sendAlert = async () => {
    if (!message.trim()) { toast.error('Message required'); return }
    setSending(true)
    const { error } = await supabase.from('notifications_log').insert({ type: 'whatsapp', recipient: audience, message: message.trim(), status: 'pending' })
    if (error) { toast.error(error.message); setSending(false); return }
    toast.success('WhatsApp alert queued — integration pending')
    setMessage('')
    setSending(false)
    load()
  }

  return (
    <>
      <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-8">Notifications</h1>

      {/* Compose */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-8">
        <div className="flex items-center gap-3 mb-6">
          <MessageCircle size={20} className="text-[#25D366]" />
          <h2 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary">Compose WhatsApp Alert</h2>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Audience</label>
            <select value={audience} onChange={(e) => setAudience(e.target.value)} className="input-field">
              <option value="all">All Consumers</option>
              <option value="unpaid">Unpaid Bills Only</option>
              <option value="custom">Custom Recipients</option>
            </select>
          </div>

          <div>
            <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Type your message here... (will be sent via WhatsApp)"
              className="input-field resize-none"
            />
          </div>

          <button
            onClick={sendAlert}
            disabled={sending}
            className="flex items-center gap-2 px-6 py-3 bg-[#25D366] text-white rounded-lg font-sans font-semibold hover:bg-[#128C7E] transition-all disabled:opacity-50 cursor-pointer"
          >
            <Send size={16} />
            {sending ? 'Sending...' : 'Send WhatsApp Alert'}
          </button>

          <p className="text-[12px] font-sans text-dp-on-surface-variant">
            Note: WhatsApp API integration is a placeholder. Messages are logged for future integration.
          </p>
        </div>
      </div>

      {/* History Log */}
      <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-dp-outline-variant">
          <h3 className="font-sans text-[20px] font-semibold leading-[28px]">Message History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
              <th className="p-4">Date</th><th className="p-4">Type</th><th className="p-4">Recipient</th><th className="p-4">Message</th><th className="p-4">Status</th>
            </tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={5} className="p-8 text-center text-dp-on-surface-variant">Loading...</td></tr>}
              {!loading && logs.map((log, i) => (
                <tr key={log.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant">{new Date(log.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="p-4 border-b border-dp-outline-variant"><span className="bg-[#E8FAE9] text-[#075E54] px-2 py-0.5 rounded text-[12px] font-bold font-sans">{log.type}</span></td>
                  <td className="p-4 border-b border-dp-outline-variant">{log.recipient ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant max-w-[300px] truncate">{log.message}</td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`px-2 py-0.5 rounded text-[12px] font-bold font-sans ${log.status === 'sent' ? 'bg-dp-secondary-container text-dp-on-secondary-container' : log.status === 'failed' ? 'bg-dp-error-container text-dp-error' : 'bg-amber-100 text-amber-800'}`}>{log.status}</span>
                  </td>
                </tr>
              ))}
              {!loading && logs.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-dp-on-surface-variant">No messages sent yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
