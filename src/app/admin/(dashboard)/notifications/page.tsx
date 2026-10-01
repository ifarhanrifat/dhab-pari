'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send, MessageCircle, Megaphone, AlertTriangle, X, Radio, Inbox, Timer, Save, CheckCircle2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { SITE } from '@/lib/constants'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface HelpReqPending {
  sourceType: 'help_request'; id: string; category: string; description: string; location_text: string | null
  contact_name: string; contact_mobile: string; created_at: string
}
interface DeathAnnPending {
  sourceType: 'death_announcement'; id: string; deceased_name: string; deceased_name_ur: string | null
  funeral_datetime: string | null; burial_location: string | null; message: string | null
  family_contact_name: string; family_contact_mobile: string; created_at: string
}
type PendingItem = HelpReqPending | DeathAnnPending

interface ExpirySetting { alert_type: string; label: string; label_ur: string | null; default_hours: number }

interface LogEntry { id: string; type: string; recipient: string | null; message: string | null; status: string; sent_at: string | null; created_at: string }
interface HistoryRow {
  id: string; kind: string; severity: string; title_en: string | null; body_ur: string; body_en: string
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

  // Real ask, 2026-10-01: "why to create separate sections?" — Help
  // Requests and Death Announcements used to have their own bespoke
  // approve-and-broadcast buttons on their own admin pages, duplicating
  // what this "control room" already does for every other appeal. Both
  // now funnel their pending queue through here instead — one place to
  // approve, reject, and set a custom expiry before broadcasting.
  const [pending, setPending] = useState<PendingItem[]>([])
  const [pendingExpiry, setPendingExpiry] = useState<Record<string, string>>({})
  const loadPending = async () => {
    const [{ data: hr }, { data: da }] = await Promise.all([
      supabase.from('help_requests').select('id, category, description, location_text, contact_name, contact_mobile, created_at').eq('moderation_status', 'pending'),
      supabase.from('death_announcements').select('id, deceased_name, deceased_name_ur, funeral_datetime, burial_location, message, family_contact_name, family_contact_mobile, created_at').eq('moderation_status', 'pending'),
    ])
    const combined: PendingItem[] = [
      ...((hr ?? []) as Omit<HelpReqPending, 'sourceType'>[]).map((r) => ({ ...r, sourceType: 'help_request' as const })),
      ...((da ?? []) as Omit<DeathAnnPending, 'sourceType'>[]).map((a) => ({ ...a, sourceType: 'death_announcement' as const })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    setPending(combined)
  }

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
  // Real ask, 2026-10-01: "where are the default expiry setting" — folded
  // in here rather than its own sidebar page, same "one control room"
  // reasoning as the Pending Approval queue above.
  const [expirySettings, setExpirySettings] = useState<ExpirySetting[]>([])
  const [expiryHours, setExpiryHours] = useState<Record<string, string>>({})
  const [showExpirySettings, setShowExpirySettings] = useState(false)
  const [savingExpiry, setSavingExpiry] = useState<string | null>(null)
  const loadExpirySettings = async () => {
    const { data } = await supabase.from('alert_expiry_settings').select('*').order('default_hours')
    setExpirySettings((data ?? []) as ExpirySetting[])
    setExpiryHours(Object.fromEntries((data ?? []).map((s: ExpirySetting) => [s.alert_type, String(s.default_hours)])))
  }
  const saveExpirySetting = async (alertType: string) => {
    const h = parseInt(expiryHours[alertType], 10)
    if (!h || h <= 0) { toast.error(t('aes.invalidHours')); return }
    setSavingExpiry(alertType)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const { error } = await supabase.from('alert_expiry_settings')
      .update({ default_hours: h, updated_at: new Date().toISOString(), updated_by: me?.id })
      .eq('alert_type', alertType)
    setSavingExpiry(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('aes.saved'))
    loadExpirySettings()
  }
  const describeHours = (h: number) => {
    if (h % 24 === 0) { const d = h / 24; return d === 1 ? t('aes.oneDay') : `${d} ${t('aes.days')}` }
    return `${h} ${t('aes.hours')}`
  }

  useEffect(() => { load(); loadAppeals(); loadPending(); loadExpirySettings() }, [])

  const approvePending = async (item: PendingItem) => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const table = item.sourceType === 'help_request' ? 'help_requests' : 'death_announcements'
    const { error: updateErr } = await supabase.from(table).update({
      moderation_status: 'approved', is_active: true, reviewed_by: me?.id, reviewed_at: new Date().toISOString(),
    }).eq('id', item.id)
    if (updateErr) { toast.error(friendlyError(updateErr)); return }

    let bodyUr: string, bodyEn: string, titleUr: string, titleEn: string, contactName: string, contactMobile: string
    if (item.sourceType === 'help_request') {
      const catLabel = t(`hr.cat.${item.category}`)
      bodyUr = `${catLabel}: ${item.description} — رابطہ: ${item.contact_name} (${item.contact_mobile})`
      bodyEn = `${catLabel}: ${item.description} — Contact: ${item.contact_name} (${item.contact_mobile})`
      titleUr = 'مدد درکار ہے'; titleEn = 'Need Help'
      contactName = item.contact_name; contactMobile = item.contact_mobile
    } else {
      const nameLine = item.deceased_name_ur ? `${item.deceased_name} (${item.deceased_name_ur})` : item.deceased_name
      const funeralLine = item.funeral_datetime ? ` — نماز جنازہ: ${new Date(item.funeral_datetime).toLocaleString()}` : ''
      const funeralLineEn = item.funeral_datetime ? ` — Funeral: ${new Date(item.funeral_datetime).toLocaleString()}` : ''
      bodyUr = `انا للہ و انا الیہ راجعون۔ ${nameLine} کا انتقال ہو گیا۔${funeralLine} رابطہ: ${item.family_contact_name} (${item.family_contact_mobile})`
      bodyEn = `Inna lillahi wa inna ilayhi raji'un. ${nameLine} has passed away.${funeralLineEn} Contact: ${item.family_contact_name} (${item.family_contact_mobile})`
      titleUr = 'وفات کی اطلاع'; titleEn = 'Death Announcement'
      contactName = item.family_contact_name; contactMobile = item.family_contact_mobile
    }

    const customExpiry = pendingExpiry[item.id]
    const { error: appealErr } = await supabase.rpc('create_appeal', {
      p_kind: 'other', p_severity: 'emergency', p_alert_type: item.sourceType,
      p_body_ur: bodyUr, p_body_en: bodyEn, p_title_ur: titleUr, p_title_en: titleEn,
      p_contact_name: contactName, p_contact_number: contactMobile,
      p_expires_at: customExpiry ? new Date(customExpiry).toISOString() : null,
    })
    if (appealErr) toast.error(t('mod.approvedNoBroadcast') + ': ' + friendlyError(appealErr))
    else toast.success(t('mod.approvedAndBroadcast'))
    loadPending(); loadAppeals()
  }

  const rejectPending = async (item: PendingItem) => {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const table = item.sourceType === 'help_request' ? 'help_requests' : 'death_announcements'
    const { error } = await supabase.from(table).update({
      moderation_status: 'rejected', reviewed_by: me?.id, reviewed_at: new Date().toISOString(),
    }).eq('id', item.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mod.rejected'))
    loadPending()
  }

  // "This will reach 34 people" before sending is the difference between a
  // considered broadcast and a guess.
  useEffect(() => {
    supabase.rpc('appeal_audience_count', {
      p_audience: aAudience,
      p_countries: aCountries.split(',').map((c) => c.trim()).filter(Boolean),
    }).then(({ data }) => setReach(typeof data === 'number' ? data : null))
  }, [aAudience, aCountries, supabase])

  const postAppeal = async () => {
    // Real ask, 2026-10-01: "remove this compulsory english option from
    // the appeal tab" — Urdu is what's actually required; English is a
    // nice-to-have that create_appeal() now reuses the Urdu text for if
    // left blank (body_en is NOT NULL in the schema).
    if (!aBodyUr.trim()) { toast.error(t('al.needsBothLangs')); return }
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

  const markLogSent = async (id: string) => {
    const { error } = await supabase.from('notifications_log').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('al.markedSentToast'))
    load()
  }
  const deleteLog = async (id: string) => {
    if (!confirm(t('al.confirmDeleteLog'))) return
    const { error } = await supabase.from('notifications_log').delete().eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('g.deleted'))
    load()
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

      {/* Real ask, 2026-10-01: one control room, not scattered approve
          buttons on every feature's own page. Help Requests and Death
          Announcements both land here pending, get approved/rejected
          here (with an optional custom expiry right at approval time),
          and broadcast through the exact same create_appeal() as
          everything else. */}
      {pending.length > 0 && (
        <div className="bg-white border-2 border-amber-400 rounded-lg overflow-hidden mb-8">
          <div className="px-6 py-4 border-b border-dp-outline-variant bg-amber-50 flex items-center gap-2.5">
            <Inbox size={20} className="text-amber-700" />
            <h2 className="font-sans text-[18px] font-semibold text-amber-800">{t('al.pendingApprovalTitle')} ({pending.length})</h2>
          </div>
          <div className="divide-y divide-dp-outline-variant">
            {pending.map((item) => (
              <div key={`${item.sourceType}-${item.id}`} className="p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <span className="text-[10.5px] font-bold uppercase px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant font-sans">
                      {item.sourceType === 'help_request' ? t('em.needHelpTitle') : t('da.pageTitle')}
                    </span>
                    {item.sourceType === 'help_request' ? (
                      <>
                        <p className="font-sans text-[14px] text-dp-on-surface mt-1.5">{t(`hr.cat.${item.category}`)}: {item.description}</p>
                        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{item.contact_name} · {item.contact_mobile}{item.location_text ? ` · ${item.location_text}` : ''}</p>
                      </>
                    ) : (
                      <>
                        <p className="font-sans text-[14px] font-bold text-dp-on-surface mt-1.5">{item.deceased_name}{item.deceased_name_ur ? ` (${item.deceased_name_ur})` : ''}</p>
                        {item.funeral_datetime && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('da.funeralAt')}: {new Date(item.funeral_datetime).toLocaleString()}</p>}
                        {item.message && <p className="font-sans text-[13px] text-dp-on-surface mt-1">{item.message}</p>}
                        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{item.family_contact_name} · {item.family_contact_mobile}</p>
                      </>
                    )}
                  </div>
                  <div className="flex items-end gap-2 shrink-0">
                    <div>
                      <label className="block font-sans text-[11px] text-dp-on-surface-variant mb-1">{t('al.customExpiryOptional')}</label>
                      <input type="datetime-local" value={pendingExpiry[item.id] ?? ''} onChange={(e) => setPendingExpiry({ ...pendingExpiry, [item.id]: e.target.value })} className="input-field text-[12.5px] py-1.5" />
                    </div>
                    <button onClick={() => approvePending(item)} title={t('mod.approveAndBroadcast')} className="p-2 bg-emerald-600 text-white rounded-lg cursor-pointer hover:bg-emerald-700"><Radio size={15} /></button>
                    <button onClick={() => rejectPending(item)} title={t('mod.reject')} className="p-2 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg cursor-pointer hover:bg-dp-surface-container-low"><X size={15} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Real ask, 2026-10-01: "where are the default expiry setting for
          the alerts and appeals?" — was its own sidebar page
          (/admin/alert-settings), moved in here for the same reason the
          Pending Approval queue above is here instead of scattered. */}
      <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-8">
        <button onClick={() => setShowExpirySettings((v) => !v)}
          className="w-full px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-dp-surface-container-low transition-colors">
          <span className="flex items-center gap-2.5"><Timer size={18} className="text-dp-secondary" /><h3 className="font-sans text-[18px] font-semibold text-dp-primary">{t('aes.title')}</h3></span>
          <span className="font-sans text-[13px] text-dp-secondary font-semibold">{showExpirySettings ? t('al.hide') : t('al.show')}</span>
        </button>
        {showExpirySettings && (
          <div className="border-t border-dp-outline-variant p-6">
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('aes.intro')}</p>
            <div className="space-y-3">
              {expirySettings.map((s) => (
                <div key={s.alert_type} className="bg-dp-surface-container-low rounded-lg p-3.5 flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{isUrdu && s.label_ur ? s.label_ur : s.label}</p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('aes.currently')}: {describeHours(s.default_hours)}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input type="number" min={1} value={expiryHours[s.alert_type] ?? ''} onChange={(e) => setExpiryHours({ ...expiryHours, [s.alert_type]: e.target.value })}
                      className="input-field w-20 text-center py-1.5" />
                    <span className="font-sans text-[12px] text-dp-on-surface-variant">{t('aes.hoursUnit')}</span>
                    <button onClick={() => saveExpirySetting(s.alert_type)} disabled={savingExpiry === s.alert_type}
                      className="p-2 bg-dp-secondary text-white rounded-lg cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
                      <Save size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

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
                    {/* Real ask, 2026-10-01: "complete list of already
                        aired... everything" — title_en is what actually
                        tells a Help Request apart from a Death
                        Announcement apart from a routine appeal here,
                        since most of them share kind='other'. */}
                    {h.title_en && <p className="font-sans text-[13px] font-bold text-dp-on-surface">{h.title_en}</p>}
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
              <th className="p-4">{t('w.date')}</th><th className="p-4">{t('a.type')}</th><th className="p-4">{t('al.recipient')}</th><th className="p-4">{t('g.message')}</th><th className="p-4">{t('w.status')}</th><th className="p-4"></th>
            </tr></thead>
            <tbody className="font-sans text-[16px]">
              {loading && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant"><LoadingDots /></td></tr>}
              {!loading && logs.map((log, i) => (
                <tr key={log.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''}`}>
                  <td className="p-4 border-b border-dp-outline-variant text-[14px] text-dp-on-surface-variant">{new Date(log.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="p-4 border-b border-dp-outline-variant"><span className="bg-[#E8FAE9] text-[#075E54] px-2 py-0.5 rounded text-[12px] font-bold font-sans">{log.type}</span></td>
                  <td className="p-4 border-b border-dp-outline-variant">{log.recipient ?? '—'}</td>
                  <td className="p-4 border-b border-dp-outline-variant max-w-[300px] truncate">{log.message}</td>
                  <td className="p-4 border-b border-dp-outline-variant">
                    <span className={`px-2 py-0.5 rounded text-[12px] font-bold font-sans ${log.status === 'sent' ? 'bg-dp-secondary-container text-dp-on-secondary-container' : log.status === 'failed' ? 'bg-dp-error-container text-dp-error' : 'bg-amber-100 text-amber-800'}`}>{log.status}</span>
                  </td>
                  {/* Real report, 2026-10-01: "why this section of appeal
                      is showing pending and nothing can resend or remove
                      this" — this log has always been a placeholder
                      (al.integrationNote: "logged for future
                      integration"), so a row never moved out of 'pending'
                      on its own. Lets staff mark it sent by hand once
                      they've actually sent it themselves, or delete a
                      stale one. */}
                  <td className="p-4 border-b border-dp-outline-variant">
                    <div className="flex items-center gap-1.5 justify-end">
                      {log.status === 'pending' && (
                        <button onClick={() => markLogSent(log.id)} title={t('al.markSent')} className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded cursor-pointer"><CheckCircle2 size={15} /></button>
                      )}
                      <button onClick={() => deleteLog(log.id)} title={t('g.delete')} className="p-1.5 text-dp-error hover:bg-dp-error/10 rounded cursor-pointer"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && logs.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-dp-on-surface-variant">{t('al.noMessages')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
