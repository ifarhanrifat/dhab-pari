'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send, MessageCircle, Megaphone, AlertTriangle, X } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'

interface LogEntry { id: string; type: string; recipient: string | null; message: string | null; status: string; sent_at: string | null; created_at: string }
interface Appeal {
  id: string; kind: string; title_ur: string | null; body_ur: string; body_en: string
  audience: string; audience_countries: string[]; is_public: boolean
  contact_number: string | null; created_at: string; expires_at: string | null
}

const AUDIENCES: [string, string][] = [
  ['everyone', 'Everyone'],
  ['villagers', 'Villagers only'],
  ['consumers', 'Water consumers'],
  ['donors', 'Donors only'],
  ['overseas', 'Overseas only'],
]
const KINDS: [string, string][] = [
  ['medical', 'Medical emergency'],
  ['project', 'Project'],
  ['maintenance', 'Maintenance / running cost'],
  ['blood', 'Blood'],
  ['other', 'Other'],
]

export default function AdminNotificationsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [audience, setAudience] = useState('all')
  const [sending, setSending] = useState(false)
  const supabase = createClient()

  const [appeals, setAppeals] = useState<Appeal[]>([])
  const [aKind, setAKind] = useState('medical')
  const [aTitleUr, setATitleUr] = useState('')
  const [aBodyUr, setABodyUr] = useState('')
  const [aBodyEn, setABodyEn] = useState('')
  const [aAudience, setAAudience] = useState('everyone')
  const [aCountries, setACountries] = useState('')
  const [aPublic, setAPublic] = useState(true)
  const [aNotify, setANotify] = useState(true)
  const [aContact, setAContact] = useState('')
  const [aExpires, setAExpires] = useState('')
  const [reach, setReach] = useState<number | null>(null)
  const [posting, setPosting] = useState(false)

  const load = async () => { const { data } = await supabase.from('notifications_log').select('*').order('created_at', { ascending: false }).limit(20); setLogs(data ?? []); setLoading(false) }
  const loadAppeals = async () => {
    const { data } = await supabase.from('appeals').select('*').eq('status', 'active').order('created_at', { ascending: false })
    setAppeals((data ?? []) as Appeal[])
  }
  useEffect(() => { load(); loadAppeals() }, [])

  // "This will reach 34 people" before sending is the difference between a
  // considered broadcast and a guess.
  useEffect(() => {
    supabase.rpc('appeal_audience_count', {
      p_audience: aAudience,
      p_countries: aCountries.split(',').map((c) => c.trim()).filter(Boolean),
    }).then(({ data }) => setReach(typeof data === 'number' ? data : null))
  }, [aAudience, aCountries, supabase])

  const postAppeal = async () => {
    if (!aBodyUr.trim() || !aBodyEn.trim()) { toast.error('An appeal needs wording in both Urdu and English'); return }
    setPosting(true)
    const { error } = await supabase.rpc('create_appeal', {
      p_kind: aKind,
      p_body_ur: aBodyUr.trim(),
      p_body_en: aBodyEn.trim(),
      p_audience: aAudience,
      p_audience_countries: aCountries.split(',').map((c) => c.trim()).filter(Boolean),
      p_is_public: aPublic,
      p_title_ur: aTitleUr.trim() || null,
      p_title_en: null,
      p_contact_name: null,
      p_contact_number: aContact.trim() || null,
      p_project_id: null,
      p_expires_at: aExpires ? new Date(aExpires).toISOString() : null,
      p_notify: aNotify,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(aNotify ? `Appeal posted and sent to ${reach ?? 0} portal user(s)` : 'Appeal posted')
    setATitleUr(''); setABodyUr(''); setABodyEn(''); setAContact(''); setAExpires('')
    loadAppeals()
  }

  const closeAppeal = async (id: string) => {
    const { error } = await supabase.rpc('close_appeal', { p_appeal_id: id, p_reason: 'closed by staff' })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Appeal closed — the red banner and its ticker are gone')
    loadAppeals()
  }

  const sendAlert = async () => {
    if (!message.trim()) { toast.error('Message required'); return }
    setSending(true)
    const { error } = await supabase.from('notifications_log').insert({ type: 'whatsapp', recipient: audience, message: message.trim(), status: 'pending' })
    if (error) { toast.error(friendlyError(error)); setSending(false); return }
    toast.success('WhatsApp alert queued — integration pending')
    setMessage('')
    setSending(false)
    load()
  }

  return (
    <>
      <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-8">Alerts &amp; Appeals</h1>

      {/* Appeals replace what "Send Portal Emergency Alert" was reaching for.
          That block broadcast one untargeted bell notification that scrolled
          away and could not be taken back; an appeal is aimed, pinned in red at
          the top of every matching portal, and retractable the moment the need
          is met. */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-8">
        <div className="flex items-center gap-3 mb-2">
          <AlertTriangle size={20} className="text-dp-error" />
          <h2 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary">Post an Appeal</h2>
        </div>
        <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">
          Shows in red at the top of every matching portal until you close it, and on the public
          website if you make it public. Use it for a medical emergency, a project, running costs —
          anything the village needs to hear about now.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Kind</label>
            <select value={aKind} onChange={(e) => setAKind(e.target.value)} className="input-field">
              {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Heading in Urdu (optional)</label>
            <input value={aTitleUr} onChange={(e) => setATitleUr(e.target.value)} dir="rtl" className="input-field" />
          </div>
        </div>

        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Appeal in Urdu *</label>
          <textarea value={aBodyUr} onChange={(e) => setABodyUr(e.target.value)} rows={3} dir="rtl"
            placeholder="ڈھاب پڑی کے ایک خاندان کو فوری طبی امداد درکار ہے..." className="input-field resize-none" />
        </div>
        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Appeal in English *</label>
          <textarea value={aBodyEn} onChange={(e) => setABodyEn(e.target.value)} rows={2}
            placeholder="A family in Dhab Pari needs urgent medical help..." className="input-field resize-none" />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">Both are shown — Urdu large, English underneath. Never put a private person&apos;s name in a public appeal.</p>
        </div>

        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Who should see it</label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {AUDIENCES.map(([v, l]) => (
              <button key={v} type="button" onClick={() => setAAudience(v)}
                className={`py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer transition-all ${aAudience === v ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary'}`}>
                {l}
              </button>
            ))}
          </div>
          {aAudience === 'overseas' && (
            <input value={aCountries} onChange={(e) => setACountries(e.target.value)}
              placeholder="UK, UAE, Saudi Arabia — leave blank for every country" className="input-field mt-2" />
          )}
          {reach !== null && (
            <p className="font-sans text-[12.5px] text-dp-secondary font-semibold mt-2">
              Reaches {reach} registered portal user{reach === 1 ? '' : 's'}.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Number to call (optional)</label>
            <input value={aContact} onChange={(e) => setAContact(e.target.value)} placeholder="03xx-xxxxxxx" className="input-field" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Remove automatically on (optional)</label>
            <input type="date" value={aExpires} onChange={(e) => setAExpires(e.target.value)} className="input-field" />
          </div>
        </div>

        <label className="flex items-start gap-2 cursor-pointer mb-2">
          <input type="checkbox" checked={aPublic} onChange={(e) => setAPublic(e.target.checked)} className="accent-dp-secondary mt-0.5" />
          <span className="font-sans text-[13.5px]">Also show on the public website
            <span className="block text-[11.5px] text-dp-on-surface-variant">Adds it to the homepage ticker as well as the red bar. A targeted appeal usually should not be public.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer mb-5">
          <input type="checkbox" checked={aNotify} onChange={(e) => setANotify(e.target.checked)} className="accent-dp-secondary mt-0.5" />
          <span className="font-sans text-[13.5px]">Also send it as a notification
            <span className="block text-[11.5px] text-dp-on-surface-variant">The red bar only reaches someone who opens the portal. This pushes it to them.</span>
          </span>
        </label>

        <button onClick={postAppeal} disabled={posting} className="flex items-center gap-2 px-6 py-3 bg-dp-error text-white rounded-lg font-sans font-semibold hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer">
          <Megaphone size={16} /> {posting ? 'Posting...' : 'Post Appeal'}
        </button>
      </div>

      {/* Live appeals — with the close button, because an appeal left up after
          the need is met teaches people that appeals are stale. */}
      {appeals.length > 0 && (
        <div className="bg-white border-2 border-dp-error rounded-lg overflow-hidden mb-8">
          <div className="px-6 py-4 border-b border-dp-outline-variant bg-dp-error/5">
            <h3 className="font-sans text-[18px] font-semibold text-dp-error">Showing now ({appeals.length})</h3>
          </div>
          <div className="divide-y divide-dp-outline-variant">
            {appeals.map((a) => (
              <div key={a.id} className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-error/10 text-dp-error font-sans">{a.kind}</span>
                    <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-surface-container text-dp-on-surface-variant font-sans">
                      {AUDIENCES.find(([v]) => v === a.audience)?.[1] ?? a.audience}
                      {a.audience_countries?.length > 0 ? `: ${a.audience_countries.join(', ')}` : ''}
                    </span>
                    {a.is_public && <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container font-sans">public</span>}
                  </div>
                  <p dir="rtl" className="font-urdu text-[14px] text-dp-on-surface leading-relaxed">{a.body_ur}</p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{a.body_en}</p>
                </div>
                <button onClick={() => closeAppeal(a.id)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-error cursor-pointer hover:bg-dp-surface-container-low transition-all">
                  <X size={14} /> Close
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
