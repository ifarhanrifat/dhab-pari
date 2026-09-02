'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send, MessageCircle, Megaphone, AlertTriangle, X } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface LogEntry { id: string; type: string; recipient: string | null; message: string | null; status: string; sent_at: string | null; created_at: string }
interface HistoryRow {
  id: string; kind: string; severity: string; body_ur: string; body_en: string
  audience: string; is_public: boolean; status: string
  starts_at: string; expires_at: string | null; created_at: string
  closed_at: string | null; close_reason: string | null
  created_by: string | null; closed_by: string | null
}

interface Appeal {
  id: string; kind: string; title_ur: string | null; body_ur: string; body_en: string
  audience: string; audience_countries: string[]; is_public: boolean; severity: string
  contact_number: string | null; created_at: string; expires_at: string | null
}

// Second element of each tuple is an i18n key (module scope has no
// useLocale()) — resolved via t() at render time. SEVERITIES is
// deliberately left bilingual (shown as-is regardless of admin locale) —
// the severity word matters on the live public page too.
const AUDIENCE_KEYS: [string, string][] = [
  ['everyone', 'al.audEveryone'],
  ['villagers', 'al.audVillagers'],
  ['consumers', 'al.audConsumers'],
  ['donors', 'al.audDonors'],
  ['overseas', 'al.audOverseas'],
]
const SEVERITIES: [string, string][] = [
  ['emergency', 'Emergency  ہنگامی'],
  ['important', 'Important announcement  اہم اعلان'],
  ['appeal', 'Appeal  اپیل'],
]
const KIND_KEYS: [string, string][] = [
  ['medical', 'al.kindMedical'],
  ['project', 'al.kindProject'],
  ['maintenance', 'al.kindMaintenance'],
  ['blood', 'al.kindBlood'],
  ['other', 'al.kindOther'],
]

export default function AdminNotificationsPage() {
  const { t, isUrdu } = useLocale()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [audience, setAudience] = useState('all')
  const [sending, setSending] = useState(false)
  const supabase = createClient()

  const [appeals, setAppeals] = useState<Appeal[]>([])
  const [aKind, setAKind] = useState('medical')
  const [aSeverity, setASeverity] = useState('emergency')
  const [aTitleUr, setATitleUr] = useState('')
  const [aBodyUr, setABodyUr] = useState('')
  const [aBodyEn, setABodyEn] = useState('')
  const [aAudience, setAAudience] = useState('everyone')
  const [aCountries, setACountries] = useState('')
  const [aPublic, setAPublic] = useState(true)
  const [aNotify, setANotify] = useState(true)
  const [aContact, setAContact] = useState('')
  const [aExpires, setAExpires] = useState('')
  const [aStarts, setAStarts] = useState('')
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [reach, setReach] = useState<number | null>(null)
  const [posting, setPosting] = useState(false)

  const load = async () => { const { data } = await supabase.from('notifications_log').select('*').order('created_at', { ascending: false }).limit(20); setLogs(data ?? []); setLoading(false) }
  const loadAppeals = async () => {
    // Brings any scheduled appeal that has come due into the green ticker, and
    // drops expired ones. pg_cron does this too; calling it here means it still
    // happens if cron is unavailable, and someone scheduling an appeal is
    // looking at this screen anyway.
    await supabase.rpc('sync_appeal_tickers')
    const { data } = await supabase.from('appeals').select('*').eq('status', 'active').order('created_at', { ascending: false })
    setAppeals((data ?? []) as Appeal[])
    const { data: h } = await supabase.rpc('appeals_history', { p_limit: 50 })
    setHistory((h ?? []) as HistoryRow[])
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
    if (!aBodyUr.trim() || !aBodyEn.trim()) { toast.error(t('al.needsBothLangs')); return }
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
      p_severity: aSeverity,
      p_starts_at: aStarts ? new Date(aStarts).toISOString() : null,
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(aStarts && new Date(aStarts) > new Date()
      ? `${t('al.scheduledFor')} ${new Date(aStarts).toLocaleString('en-GB')}`
      : aNotify ? `${t('al.postedAndSentTo')} ${reach ?? 0} ${t('al.portalUsersSuffix')}` : t('al.appealPostedOnly'))
    setATitleUr(''); setABodyUr(''); setABodyEn(''); setAContact(''); setAExpires(''); setAStarts('')
    loadAppeals()
  }

  const reopenAppeal = async (id: string) => {
    const { error } = await supabase.rpc('reopen_appeal', { p_appeal_id: id, p_expires_at: null })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('al.showingAgainToast'))
    loadAppeals()
  }

  const closeAppeal = async (id: string) => {
    const { error } = await supabase.rpc('close_appeal', { p_appeal_id: id, p_reason: 'closed by staff' })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('al.closedBannerGone'))
    loadAppeals()
  }

  const sendAlert = async () => {
    if (!message.trim()) { toast.error(t('al.messageRequired')); return }
    setSending(true)
    const { error } = await supabase.from('notifications_log').insert({ type: 'whatsapp', recipient: audience, message: message.trim(), status: 'pending' })
    if (error) { toast.error(friendlyError(error)); setSending(false); return }
    toast.success(t('al.whatsappQueued'))
    setMessage('')
    setSending(false)
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-8">{t('al.title')}</h1>

      {/* Appeals replace what "Send Portal Emergency Alert" was reaching for.
          That block broadcast one untargeted bell notification that scrolled
          away and could not be taken back; an appeal is aimed, pinned in red at
          the top of every matching portal, and retractable the moment the need
          is met. */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-8">
        <div className="flex items-center gap-3 mb-2">
          <AlertTriangle size={20} className="text-dp-error" />
          <h2 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary">{t('al.postAppeal')}</h2>
        </div>
        <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">
          {t('al.postAppealBlurb')}
        </p>

        {/* Sets the word shown in front of the scrolling text, and the order
            appeals appear in when more than one is live. */}
        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.howAnnounced')}</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {SEVERITIES.map(([v, l]) => (
              <button key={v} type="button" onClick={() => setASeverity(v)}
                className={`py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer transition-all ${aSeverity === v ? 'bg-dp-error text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-error'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.kind')}</label>
            <select value={aKind} onChange={(e) => setAKind(e.target.value)} className="input-field">
              {KIND_KEYS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
            </select>
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.headingUr')}</label>
            <input value={aTitleUr} onChange={(e) => setATitleUr(e.target.value)} dir="rtl" className="input-field" />
          </div>
        </div>

        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.appealUr')}</label>
          <textarea value={aBodyUr} onChange={(e) => setABodyUr(e.target.value)} rows={3} dir="rtl"
            placeholder={`${SITE.nameUrdu} کے ایک خاندان کو فوری طبی امداد درکار ہے...`} className="input-field resize-none" />
        </div>
        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.appealEn')}</label>
          <textarea value={aBodyEn} onChange={(e) => setABodyEn(e.target.value)} rows={2}
            placeholder={`A family in ${SITE.name} needs urgent medical help...`} className="input-field resize-none" />
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('al.bothShownNote')}</p>
        </div>

        <div className="mb-4">
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.whoShouldSee')}</label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {AUDIENCE_KEYS.map(([v, l]) => (
              <button key={v} type="button" onClick={() => setAAudience(v)}
                className={`py-2 rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer transition-all ${aAudience === v ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-secondary'}`}>
                {t(l)}
              </button>
            ))}
          </div>
          {aAudience === 'overseas' && (
            <input value={aCountries} onChange={(e) => setACountries(e.target.value)}
              placeholder={t('al.countriesPlaceholder')} className="input-field mt-2" />
          )}
          {reach !== null && (
            <p className="font-sans text-[12.5px] text-dp-secondary font-semibold mt-2">
              {t('al.reachesPrefix')} {reach} {t('al.registeredPortalUsersSuffix')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.numberOptional')}</label>
            <input value={aContact} onChange={(e) => setAContact(e.target.value)} placeholder="03xx-xxxxxxx" className="input-field" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.startShowing')}</label>
            <input type="datetime-local" value={aStarts} onChange={(e) => setAStarts(e.target.value)} className="input-field" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('al.startBlankNote')}</p>
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('al.stopShowing')}</label>
            <input type="datetime-local" value={aExpires} onChange={(e) => setAExpires(e.target.value)} className="input-field" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('al.blankKeepUp')}</p>
          </div>
        </div>

        <label className="flex items-start gap-2 cursor-pointer mb-2">
          <input type="checkbox" checked={aPublic} onChange={(e) => setAPublic(e.target.checked)} className="accent-dp-secondary mt-0.5" />
          <span className="font-sans text-[13.5px]">{t('g.alsoPublic')}
            <span className="block text-[11.5px] text-dp-on-surface-variant">{t('al.publicNote')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer mb-5">
          <input type="checkbox" checked={aNotify} onChange={(e) => setANotify(e.target.checked)} className="accent-dp-secondary mt-0.5" />
          <span className="font-sans text-[13.5px]">{t('al.alsoNotify')}
            <span className="block text-[11.5px] text-dp-on-surface-variant">{t('al.notifyNote')}</span>
          </span>
        </label>

        <button onClick={postAppeal} disabled={posting} className="flex items-center gap-2 px-6 py-3 bg-dp-error text-white rounded-lg font-sans font-semibold hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer">
          <Megaphone size={16} /> {posting ? t('al.posting') : t('al.postAppealBtn')}
        </button>
      </div>

      {/* Live appeals — with the close button, because an appeal left up after
          the need is met teaches people that appeals are stale. */}
      {appeals.length > 0 && (
        <div className="bg-white border-2 border-dp-error rounded-lg overflow-hidden mb-8">
          <div className="px-6 py-4 border-b border-dp-outline-variant bg-dp-error/5">
            <h3 className="font-sans text-[18px] font-semibold text-dp-error">{t('al.showingNowPrefix')} ({appeals.length})</h3>
          </div>
          <div className="divide-y divide-dp-outline-variant">
            {appeals.map((a) => (
              <div key={a.id} className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-error text-white font-sans">{a.severity}</span>
                    <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-error/10 text-dp-error font-sans">{t(KIND_KEYS.find(([v]) => v === a.kind)?.[1] ?? a.kind, a.kind)}</span>
                    <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-surface-container text-dp-on-surface-variant font-sans">
                      {t(AUDIENCE_KEYS.find(([v]) => v === a.audience)?.[1] ?? a.audience, a.audience)}
                      {a.audience_countries?.length > 0 ? `: ${a.audience_countries.join(', ')}` : ''}
                    </span>
                    {a.is_public && <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-secondary-container text-dp-on-secondary-container font-sans">{t('al.publicBadge')}</span>}
                  </div>
                  <p dir="rtl" className="font-urdu text-[14px] text-dp-on-surface leading-relaxed">{a.body_ur}</p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{a.body_en}</p>
                </div>
                <button onClick={() => closeAppeal(a.id)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-error cursor-pointer hover:bg-dp-surface-container-low transition-all">
                  <X size={14} /> {t('g.close')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History. Closing an appeal has always kept the row with who closed it,
          when and why — nothing ever showed it back, so "is it saved?" had no
          answer anyone could check. Scheduled ones appear here too, before they
          go live. */}
      <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-8">
        <button onClick={() => setShowHistory((v) => !v)}
          className="w-full px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-dp-surface-container-low transition-colors">
          <h3 className="font-sans text-[18px] font-semibold text-dp-primary">{t('al.appealHistoryPrefix')} ({history.length})</h3>
          <span className="font-sans text-[13px] text-dp-secondary font-semibold">{showHistory ? t('al.hide') : t('al.show')}</span>
        </button>

        {showHistory && (
          <div className="divide-y divide-dp-outline-variant border-t border-dp-outline-variant">
            {history.map((h) => {
              const scheduled = h.status === 'active' && new Date(h.starts_at) > new Date()
              return (
                <div key={h.id} className="p-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                      <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full font-sans ${
                        scheduled ? 'bg-amber-100 text-amber-800'
                        : h.status === 'active' ? 'bg-dp-error text-white'
                        : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                        {scheduled ? t('al.scheduledBadge') : h.status === 'active' ? t('al.showingBadge') : t('al.closedBadge')}
                      </span>
                      <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-error/10 text-dp-error font-sans">{h.severity}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-dp-surface-container text-dp-on-surface-variant font-sans">
                        {t(AUDIENCE_KEYS.find(([v]) => v === h.audience)?.[1] ?? h.audience, h.audience)}
                      </span>
                    </div>
                    <p dir="rtl" className="font-urdu text-[13.5px] text-dp-on-surface leading-relaxed">{h.body_ur}</p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">
                      {scheduled
                        ? `${t('al.startsPrefix')} ${new Date(h.starts_at).toLocaleString('en-GB')}`
                        : `${t('al.postedPrefix')} ${new Date(h.created_at).toLocaleString('en-GB')}${h.created_by ? ` ${t('al.byPrefix')} ${h.created_by}` : ''}`}
                      {h.closed_at && ` ${t('al.closedPrefix')} ${new Date(h.closed_at).toLocaleString('en-GB')}${h.closed_by ? ` ${t('al.byPrefix')} ${h.closed_by}` : ''}`}
                      {h.close_reason && ` — ${h.close_reason}`}
                    </p>
                  </div>
                  {h.status !== 'active' && (
                    <button onClick={() => reopenAppeal(h.id)}
                      className="shrink-0 px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[13px] font-semibold text-dp-secondary cursor-pointer hover:bg-dp-surface-container-low transition-all">
                      {t('al.showAgain')}
                    </button>
                  )}
                </div>
              )
            })}
            {history.length === 0 && (
              <p className="p-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{t('al.noAppeals')}</p>
            )}
          </div>
        )}
      </div>

      {/* Compose */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 mb-8">
        <div className="flex items-center gap-3 mb-6">
          <MessageCircle size={20} className="text-[#25D366]" />
          <h2 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary">{t('al.composeWhatsapp')}</h2>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('al.audience')}</label>
            <select value={audience} onChange={(e) => setAudience(e.target.value)} className="input-field">
              <option value="all">{t('al.allConsumers')}</option>
              <option value="unpaid">{t('al.unpaidOnly')}</option>
              <option value="custom">{t('al.customRecipients')}</option>
            </select>
          </div>

          <div>
            <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('g.message')}</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder={t('al.messagePlaceholder')}
              className="input-field resize-none"
            />
          </div>

          <button
            onClick={sendAlert}
            disabled={sending}
            className="flex items-center gap-2 px-6 py-3 bg-[#25D366] text-white rounded-lg font-sans font-semibold hover:bg-[#128C7E] transition-all disabled:opacity-50 cursor-pointer"
          >
            <Send size={16} />
            {sending ? t('al.sending') : t('al.sendWhatsappAlert')}
          </button>

          <p className="text-[12px] font-sans text-dp-on-surface-variant">
            {t('al.integrationNote')}
          </p>
        </div>
      </div>

      {/* History Log */}
      <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-dp-outline-variant">
          <h3 className="font-sans text-[20px] font-semibold leading-[28px]">{t('al.messageHistory')}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead><tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
              <th className="p-4">{t('w.date')}</th><th className="p-4">{t('a.type')}</th><th className="p-4">{t('al.recipient')}</th><th className="p-4">{t('g.message')}</th><th className="p-4">{t('w.status')}</th>
            </tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={5} className="p-8 text-center text-dp-on-surface-variant"><LoadingDots /></td></tr>}
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
              {!loading && logs.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-dp-on-surface-variant">{t('al.noMessages')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
