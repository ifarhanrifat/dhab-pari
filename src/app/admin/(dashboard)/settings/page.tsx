'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Save, PlusCircle, Trash2, Pencil, X, Check, Bell, MessageCircle, ShieldCheck, MessageSquareWarning, AlertTriangle, Copy, MessageSquareText, Building2, Wallet, FileText, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import type { ManagementContact } from '@/lib/branding'
import { TEMPLATE_KEYS } from '@/lib/messageTemplates'

interface Setting { id: string; key: string; value: string | null; description: string | null }
interface Sector { id: string; name: string; display_order: number }
interface NotificationPref { event_type: string; label: string; whatsapp_enabled: boolean; popup_enabled: boolean }
interface MessageTemplate { key: string; label: string; body: string }
interface EligibleApprover { id: string; full_name: string }
interface ApproverStat { admin_user_id: string; full_name: string; pending_count: number; approved_count: number; rejected_count: number; overridden_count: number }

const approvalSystems: { key: 'water_supply' | 'donors_projects'; label: string }[] = [
  { key: 'water_supply', label: 'Water Supply' },
  { key: 'donors_projects', label: 'Donors & Projects' },
]

const approvalTypes: { key: 'expense' | 'withdrawal' | 'purchase'; label: string }[] = [
  { key: 'expense', label: 'Expenses (incl. salary)' },
  { key: 'withdrawal', label: 'Cash Withdrawals' },
  { key: 'purchase', label: 'Purchases' },
]

const invoiceTemplates: { id: string; label: string; blurb: string }[] = [
  { id: 'classic', label: 'Classic', blurb: 'Traditional bordered receipt with Urdu heading' },
  { id: 'modern', label: 'Modern', blurb: 'Bold colored header, card-style layout' },
  { id: 'minimal', label: 'Minimal', blurb: 'Clean and sparse, large amount focus' },
  { id: 'detailed', label: 'Detailed', blurb: 'Itemized table breakdown of charges' },
  { id: 'compact', label: 'Compact', blurb: 'Narrow thermal-receipt style' },
  { id: 'ledger', label: 'Ledger', blurb: 'Teal accent, clean ledger-style header and totals' },
  { id: 'cardSections', label: 'Card Sections', blurb: 'Plum accent, stacked rounded card blocks' },
  { id: 'boldBand', label: 'Bold Band', blurb: 'Burgundy full-width header band' },
  { id: 'twoColumn', label: 'Two Column', blurb: 'Indigo sidebar with meta, table on the right' },
  { id: 'statement', label: 'Statement', blurb: 'Slate-blue, striped statement-style table' },
]

type SettingsCategory = 'general' | 'payments' | 'documents' | 'connections' | 'approvals' | 'danger'

const CATEGORIES: { id: SettingsCategory; label: string; icon: typeof Building2 }[] = [
  { id: 'general', label: 'General', icon: Building2 },
  { id: 'payments', label: 'Payment Methods', icon: Wallet },
  { id: 'documents', label: 'Documents & Templates', icon: FileText },
  { id: 'connections', label: 'Connections & Billing', icon: MapPin },
  { id: 'approvals', label: 'Approvals & Notifications', icon: ShieldCheck },
  { id: 'danger', label: 'Danger Zone', icon: AlertTriangle },
]

const settingGroups: { label: string; keys: string[]; category: SettingsCategory }[] = [
  { label: 'Accounts Display Language', keys: ['display_language'], category: 'general' },
  { label: 'WhatsApp', keys: ['whatsapp_number', 'whatsapp_link'], category: 'payments' },
  { label: 'JazzCash', keys: ['jazzcash_number', 'jazzcash_name'], category: 'payments' },
  { label: 'Easypaisa', keys: ['easypaisa_number', 'easypaisa_name'], category: 'payments' },
  { label: 'Bank Details', keys: ['bank_name', 'bank_account', 'bank_branch'], category: 'payments' },
  { label: 'Office', keys: ['office_hours'], category: 'general' },
  {
    label: 'Invoice Footer', keys: [
      'helpline_numbers', 'invoice_instructions', 'footer_complaint_number',
      'footer_facebook_link', 'footer_whatsapp_group_link', 'footer_projects_link', 'footer_donation_link',
    ],
    category: 'documents',
  },
  { label: 'About', keys: ['about_text', 'vision', 'mission'], category: 'general' },
  { label: 'Reminders', keys: ['defaulter_restore_fee'], category: 'connections' },
  { label: 'New Connection Charges', keys: ['connection_plumber_charge', 'connection_digging_charge', 'connection_security_deposit'], category: 'connections' },
]

const emptyContact: ManagementContact = { name: '', designation: '', whatsapp: '' }

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [sectors, setSectors] = useState<Sector[]>([])
  const [newSectorName, setNewSectorName] = useState('')
  const [editingSector, setEditingSector] = useState<string | null>(null)
  const [editingSectorName, setEditingSectorName] = useState('')
  const [confirmDeleteSector, setConfirmDeleteSector] = useState<string | null>(null)
  const [notifPrefs, setNotifPrefs] = useState<NotificationPref[]>([])
  const [eligibleApprovers, setEligibleApprovers] = useState<Record<string, EligibleApprover[]>>({})
  const [activeApproverIds, setActiveApproverIds] = useState<Record<string, Set<string>>>({})
  const [approverStats, setApproverStats] = useState<Record<string, ApproverStat[]>>({})
  const [typeSettings, setTypeSettings] = useState<Record<string, Record<string, boolean>>>({})
  const [eligibleHandlers, setEligibleHandlers] = useState<Record<string, EligibleApprover[]>>({})
  const [activeHandlerIds, setActiveHandlerIds] = useState<Record<string, Set<string>>>({})
  const [managementContacts, setManagementContacts] = useState<ManagementContact[]>([])
  const [newContact, setNewContact] = useState<ManagementContact>(emptyContact)
  const [editingContactIdx, setEditingContactIdx] = useState<number | null>(null)
  const [editingContact, setEditingContact] = useState<ManagementContact>(emptyContact)
  const [resetSystem, setResetSystem] = useState<'water_supply' | 'donors_projects' | null>(null)
  const [resetConfirmText, setResetConfirmText] = useState('')
  const [resetting, setResetting] = useState(false)
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [savingTemplate, setSavingTemplate] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general')
  const supabase = createClient()

  const resetLabel = (sys: 'water_supply' | 'donors_projects') => (sys === 'water_supply' ? 'WATER SUPPLY' : 'DONORS PROJECTS')

  const handleReset = async (system: 'water_supply' | 'donors_projects') => {
    setResetting(true)
    const { error } = await supabase.rpc('reset_accounting_system', { p_system: system })
    setResetting(false)
    if (error) { toast.error(error.message); return }
    toast.success(`${system === 'water_supply' ? 'Water Supply' : 'Donors & Projects'} accounting reset`)
    setResetSystem(null)
    setResetConfirmText('')
  }

  const loadSectors = async () => {
    const { data } = await supabase.from('sectors').select('*').order('display_order').order('name')
    setSectors(data ?? [])
  }

  const loadNotifPrefs = async () => {
    const { data } = await supabase.from('notification_preferences').select('*').order('event_type')
    setNotifPrefs(data ?? [])
  }

  const loadTemplates = async () => {
    const { data } = await supabase.from('message_templates').select('*').order('key')
    setTemplates(data ?? [])
  }

  const saveTemplate = async (key: string) => {
    const t = templates.find((x) => x.key === key)
    if (!t) return
    setSavingTemplate(key)
    const { error } = await supabase.from('message_templates').update({ body: t.body, updated_at: new Date().toISOString() }).eq('key', key)
    setSavingTemplate(null)
    if (error) { toast.error(error.message); return }
    toast.success('Template saved')
  }

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token)
    toast.success(`Copied ${token}`)
  }

  const loadApprovers = async () => {
    const eligible: Record<string, EligibleApprover[]> = {}
    const active: Record<string, Set<string>> = {}
    const stats: Record<string, ApproverStat[]> = {}
    for (const s of approvalSystems) {
      const [{ data: roster }, { data: current }, { data: approverStatsRes }] = await Promise.all([
        supabase.rpc('get_approvers_roster', { p_system: s.key }),
        supabase.from('approval_approvers').select('admin_user_id').eq('system', s.key).eq('is_active', true),
        supabase.rpc('get_approver_stats', { p_system: s.key }),
      ])
      eligible[s.key] = roster ?? []
      active[s.key] = new Set((current ?? []).map((c) => c.admin_user_id))
      stats[s.key] = approverStatsRes ?? []
    }
    setEligibleApprovers(eligible)
    setActiveApproverIds(active)
    setApproverStats(stats)
  }

  const loadTypeSettings = async () => {
    const { data } = await supabase.from('approval_type_settings').select('*')
    const grouped: Record<string, Record<string, boolean>> = {}
    for (const row of data ?? []) {
      (grouped[row.system] ??= {})[row.transaction_type] = row.requires_approval
    }
    setTypeSettings(grouped)
  }

  const toggleApprover = async (system: string, adminUserId: string, isActive: boolean) => {
    const next = new Set(activeApproverIds[system] ?? [])
    if (isActive) next.delete(adminUserId); else next.add(adminUserId)
    setActiveApproverIds({ ...activeApproverIds, [system]: next })

    if (isActive) {
      const { error } = await supabase.from('approval_approvers').update({ is_active: false }).eq('system', system).eq('admin_user_id', adminUserId)
      if (error) { toast.error(error.message); loadApprovers(); return }
    } else {
      const { error } = await supabase.from('approval_approvers').upsert(
        { system, admin_user_id: adminUserId, is_active: true },
        { onConflict: 'system,admin_user_id' }
      )
      if (error) { toast.error(error.message); loadApprovers(); return }
    }
    toast.success(isActive ? 'Approver removed' : 'Approver added')
    loadApprovers()
  }

  const toggleTypeRequirement = async (system: string, type: string, current: boolean) => {
    setTypeSettings({ ...typeSettings, [system]: { ...typeSettings[system], [type]: !current } })
    const { error } = await supabase.from('approval_type_settings').update({ requires_approval: !current, updated_at: new Date().toISOString() }).eq('system', system).eq('transaction_type', type)
    if (error) { toast.error(error.message); loadTypeSettings(); return }
  }

  const loadHandlers = async () => {
    const eligible: Record<string, EligibleApprover[]> = {}
    const active: Record<string, Set<string>> = {}
    for (const s of approvalSystems) {
      const [{ data: roster }, { data: current }] = await Promise.all([
        supabase.rpc('get_approvers_roster', { p_system: s.key }),
        supabase.from('complaint_handlers').select('admin_user_id').eq('system', s.key).eq('is_active', true),
      ])
      eligible[s.key] = roster ?? []
      active[s.key] = new Set((current ?? []).map((c) => c.admin_user_id))
    }
    setEligibleHandlers(eligible)
    setActiveHandlerIds(active)
  }

  const toggleHandler = async (system: string, adminUserId: string, isActive: boolean) => {
    const next = new Set(activeHandlerIds[system] ?? [])
    if (isActive) next.delete(adminUserId); else next.add(adminUserId)
    setActiveHandlerIds({ ...activeHandlerIds, [system]: next })

    if (isActive) {
      const { error } = await supabase.from('complaint_handlers').update({ is_active: false }).eq('system', system).eq('admin_user_id', adminUserId)
      if (error) { toast.error(error.message); loadHandlers(); return }
    } else {
      const { error } = await supabase.from('complaint_handlers').upsert(
        { system, admin_user_id: adminUserId, is_active: true },
        { onConflict: 'system,admin_user_id' }
      )
      if (error) { toast.error(error.message); loadHandlers(); return }
    }
    toast.success(isActive ? 'Handler removed' : 'Handler added')
  }

  const toggleNotifChannel = async (eventType: string, channel: 'whatsapp_enabled' | 'popup_enabled', current: boolean) => {
    setNotifPrefs((cur) => cur.map((p) => (p.event_type === eventType ? { ...p, [channel]: !current } : p)))
    const { error } = await supabase.from('notification_preferences').update({ [channel]: !current, updated_at: new Date().toISOString() }).eq('event_type', eventType)
    if (error) { toast.error(error.message); loadNotifPrefs(); return }
  }

  useEffect(() => {
    supabase.from('site_settings').select('*').order('key').then(({ data }) => {
      const s = data ?? []
      setSettings(s)
      const v: Record<string, string> = {}
      s.forEach((setting) => { v[setting.key] = setting.value ?? '' })
      setValues(v)
      if (v.footer_management_contacts) {
        try { setManagementContacts(JSON.parse(v.footer_management_contacts)) } catch { setManagementContacts([]) }
      }
      setLoading(false)
    })
    loadSectors()
    loadNotifPrefs()
    loadApprovers()
    loadTypeSettings()
    loadHandlers()
    loadTemplates()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const addSector = async () => {
    if (!newSectorName.trim()) { toast.error('Sector name required'); return }
    const { error } = await supabase.from('sectors').insert({ name: newSectorName.trim() })
    if (error) { toast.error(error.message); return }
    toast.success('Sector added')
    setNewSectorName('')
    loadSectors()
  }

  const renameSector = async (id: string) => {
    if (!editingSectorName.trim()) { toast.error('Sector name required'); return }
    const { error } = await supabase.from('sectors').update({ name: editingSectorName.trim() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Sector renamed')
    setEditingSector(null)
    loadSectors()
  }

  const deleteSector = async () => {
    if (!confirmDeleteSector) return
    const { error } = await supabase.from('sectors').delete().eq('id', confirmDeleteSector)
    if (error) { toast.error(error.message); setConfirmDeleteSector(null); return }
    toast.success('Sector deleted')
    setConfirmDeleteSector(null)
    loadSectors()
  }

  const addContact = () => {
    if (!newContact.name.trim()) { toast.error('Contact name required'); return }
    setManagementContacts([...managementContacts, { ...newContact }])
    setNewContact(emptyContact)
  }

  const removeContact = (idx: number) => {
    setManagementContacts(managementContacts.filter((_, i) => i !== idx))
  }

  const saveEditingContact = (idx: number) => {
    if (!editingContact.name.trim()) { toast.error('Contact name required'); return }
    setManagementContacts(managementContacts.map((c, i) => (i === idx ? { ...editingContact } : c)))
    setEditingContactIdx(null)
  }

  const saveAll = async () => {
    setSaving(true)
    const finalValues = { ...values, footer_management_contacts: JSON.stringify(managementContacts) }
    const updates = Object.entries(finalValues).map(([key, value]) =>
      supabase.from('site_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key)
    )
    await Promise.all(updates)
    setValues(finalValues)
    toast.success('Settings saved')
    setSaving(false)
  }

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant">Loading settings...</div>

  // Renders the generic key/value cards for whichever settingGroups belong to
  // a category — shared across every category tab that has any, instead of
  // repeating this block per tab.
  const renderSettingGroups = (category: SettingsCategory) => (
    <>
      {settingGroups.filter((g) => g.category === category).map((group) => (
        <div key={group.label} className="bg-white border border-dp-outline-variant rounded-lg p-6">
          <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3">
            {group.label}
          </h2>
          <div className="space-y-4">
            {group.keys.map((key) => {
              const setting = settings.find((s) => s.key === key)
              const isLong = ['about_text', 'vision', 'mission', 'invoice_instructions'].includes(key)
              return (
                <div key={key}>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {key.replace(/_/g, ' ').toUpperCase()}
                    {setting?.description && <span className="font-normal text-[12px] ml-2 opacity-70">— {setting.description}</span>}
                  </label>
                  {key === 'display_language' ? (
                    <>
                      <select
                        value={values[key] || 'en'}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                        className="input-field"
                      >
                        <option value="en">English</option>
                        <option value="ur">Urdu</option>
                      </select>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-2">
                        When set to Urdu, every bill, receipt, voucher, printable statement/register, and report switches to Urdu — labels, headings, and table columns. Company name/email and any name or note actually typed in (consumer names, particulars, etc.) always stay exactly as entered, in whichever script was used.
                      </p>
                    </>
                  ) : isLong ? (
                    <textarea
                      value={values[key] ?? ''}
                      onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      rows={3}
                      className="input-field resize-none"
                    />
                  ) : (
                    <input
                      type="text"
                      value={values[key] ?? ''}
                      onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      className="input-field"
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-[28px] sm:text-[32px] font-bold leading-[40px] text-dp-primary">Site Settings</h1>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">Changes in most sections save immediately. Company/branding/payment/document fields are staged — use Save All below.</p>
        </div>
        <button onClick={saveAll} disabled={saving} className="flex items-center gap-2 px-6 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 shrink-0">
          <Save size={16} /> {saving ? 'Saving...' : 'Save All'}
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-6 items-start">
        {/* Category sidebar */}
        <nav className="w-full md:w-60 shrink-0 bg-white border border-dp-outline-variant rounded-lg p-2 flex md:flex-col gap-1 overflow-x-auto md:overflow-visible md:sticky md:top-6">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon
            const active = activeCategory === cat.id
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all whitespace-nowrap shrink-0 md:shrink text-left ${
                  active
                    ? cat.id === 'danger' ? 'bg-dp-error/10 text-dp-error' : 'bg-dp-secondary text-white'
                    : cat.id === 'danger' ? 'text-dp-error hover:bg-dp-error/5' : 'text-dp-on-surface-variant hover:bg-dp-surface-container-low'
                }`}
              >
                <Icon size={16} /> {cat.label}
              </button>
            )
          })}
        </nav>

        {/* Category content */}
        <div className="flex-1 min-w-0 space-y-6">
          {activeCategory === 'general' && (
            <>
              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3">
                  Company Identity
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Company Name (English)</label>
                    <input type="text" value={values.company_name_en ?? ''} onChange={(e) => setValues({ ...values, company_name_en: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Company Name (Urdu)</label>
                    <input
                      type="text" dir="rtl" value={values.company_name_ur ?? ''}
                      onChange={(e) => setValues({ ...values, company_name_ur: e.target.value })}
                      style={{ fontFamily: 'var(--font-urdu), serif', textAlign: 'right' }}
                      className="input-field"
                    />
                  </div>
                  <div>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Company Email</label>
                    <input type="email" value={values.company_email ?? ''} onChange={(e) => setValues({ ...values, company_email: e.target.value })} className="input-field" />
                  </div>
                </div>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-3">Shown on every generated bill, cash receipt, and payment voucher. The Urdu name only appears when the display language below is set to Urdu.</p>
              </div>

              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3">
                  Branding
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <ImageUpload bucket="images" label="Committee Logo" currentUrl={values.invoice_logo_url} onUpload={(url) => setValues({ ...values, invoice_logo_url: url })} />
                  <ImageUpload bucket="images" label="Authorized Signature" currentUrl={values.invoice_signature_url} onUpload={(url) => setValues({ ...values, invoice_signature_url: url })} />
                </div>
                {values.invoice_logo_url && (
                  <div className="mt-6 pt-6 border-t border-dp-outline-variant">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-4">
                      <div>
                        <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Logo Size (px)</label>
                        <input type="number" min={20} max={200} value={values.invoice_logo_width || '56'} onChange={(e) => setValues({ ...values, invoice_logo_width: e.target.value })} className="input-field" />
                      </div>
                      <div>
                        <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Vertical Position (px, negative moves up)</label>
                        <input type="number" value={values.invoice_logo_offset_y || '0'} onChange={(e) => setValues({ ...values, invoice_logo_offset_y: e.target.value })} className="input-field" />
                      </div>
                    </div>
                    <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-2">Preview — top-left corner, heading stays centered, on every generated bill, receipt, and voucher:</p>
                    <div className="relative text-center bg-dp-surface-container-low/60 rounded-lg p-4">
                      <img
                        src={values.invoice_logo_url} alt="Logo preview"
                        style={{ width: +(values.invoice_logo_width || 56), height: +(values.invoice_logo_width || 56), marginTop: +(values.invoice_logo_offset_y || 0) }}
                        className="absolute left-4 top-4 object-contain"
                      />
                      {values.display_language === 'ur' && (
                        <p className="text-[16px] font-bold mb-1.5" style={{ fontFamily: 'var(--font-urdu), serif' }}>واٹر اینڈ ویلفئیر کمیٹی</p>
                      )}
                      <p className="text-[13px] font-bold text-dp-on-surface-variant">Dhab Pari</p>
                    </div>
                  </div>
                )}
              </div>

              {renderSettingGroups('general')}
            </>
          )}

          {activeCategory === 'payments' && renderSettingGroups('payments')}

          {activeCategory === 'documents' && (
            <>
              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3 flex items-center gap-2">
                  <MessageSquareText size={18} /> Message Templates
                </h2>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
                  Write each message in whichever language you want — English, Urdu, or a mix. Drop any of the tags below into the middle of your wording; each one gets replaced with the real value when the message is sent.
                </p>
                <div className="space-y-6">
                  {templates.map((t) => (
                    <div key={t.key} className="border border-dp-outline-variant rounded-lg p-4">
                      <p className="font-sans text-[14px] font-bold text-dp-on-surface mb-2">{t.label}</p>
                      <textarea
                        value={t.body}
                        onChange={(e) => setTemplates(templates.map((x) => (x.key === t.key ? { ...x, body: e.target.value } : x)))}
                        rows={4}
                        className="input-field resize-none"
                        style={{ direction: /[؀-ۿ]/.test(t.body) ? 'rtl' : 'ltr' }}
                      />
                      <div className="mt-2 bg-dp-surface-container-low/60 rounded-lg px-3 py-2.5">
                        <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">
                          Tags you can use in this message
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {(TEMPLATE_KEYS[t.key] ?? []).map((k) => (
                            <button
                              key={k.token}
                              onClick={() => copyToken(k.token)}
                              title={`Copy ${k.token}`}
                              className="flex items-center gap-1 px-2 py-1 bg-white border border-dp-outline-variant rounded font-mono text-[11.5px] text-dp-secondary hover:bg-dp-secondary/5 cursor-pointer transition-all"
                            >
                              {k.token} <Copy size={10} className="text-dp-on-surface-variant" />
                              <span className="font-sans text-dp-on-surface-variant">— {k.description}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <button
                        disabled={savingTemplate === t.key}
                        onClick={() => saveTemplate(t.key)}
                        className="mt-3 flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50"
                      >
                        <Save size={14} /> {savingTemplate === t.key ? 'Saving...' : 'Save Template'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3">
                  Invoice Template
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {invoiceTemplates.map((t) => {
                    const selected = (values.invoice_template || 'classic') === t.id
                    return (
                      <button
                        key={t.id}
                        onClick={() => setValues({ ...values, invoice_template: t.id })}
                        className={`text-left p-4 rounded-lg border-2 cursor-pointer transition-all ${selected ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
                      >
                        <p className={`font-sans text-[14px] font-bold mb-1 ${selected ? 'text-dp-secondary' : 'text-dp-on-surface'}`}>{t.label}</p>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t.blurb}</p>
                      </button>
                    )
                  })}
                </div>
              </div>

              {renderSettingGroups('documents')}

              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3">
                  Management Contacts
                </h2>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4">Committee members shown in the invoice footer, with their WhatsApp number — helps consumers reach the right person about a bill.</p>
                <div className="space-y-2 mb-4">
                  {managementContacts.map((c, idx) => (
                    <div key={idx} className="flex items-center gap-2 bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                      {editingContactIdx === idx ? (
                        <>
                          <input autoFocus placeholder="Name" value={editingContact.name} onChange={(e) => setEditingContact({ ...editingContact, name: e.target.value })} className="input-field !py-1.5 flex-1" />
                          <input placeholder="Designation" value={editingContact.designation} onChange={(e) => setEditingContact({ ...editingContact, designation: e.target.value })} className="input-field !py-1.5 flex-1" />
                          <input placeholder="WhatsApp number" value={editingContact.whatsapp} onChange={(e) => setEditingContact({ ...editingContact, whatsapp: e.target.value })} className="input-field !py-1.5 flex-1" />
                        </>
                      ) : (
                        <span className="font-sans text-[14px] flex-1">
                          {c.name}
                          {c.designation && <span className="text-dp-on-surface-variant"> — {c.designation}</span>}
                          {c.whatsapp && <span className="text-dp-on-surface-variant"> — {c.whatsapp}</span>}
                        </span>
                      )}
                      <div className="flex items-center gap-1 shrink-0">
                        {editingContactIdx === idx ? (
                          <>
                            <button onClick={() => saveEditingContact(idx)} className="p-1.5 text-emerald-600 hover:text-emerald-700 cursor-pointer"><Check size={15} /></button>
                            <button onClick={() => setEditingContactIdx(null)} className="p-1.5 text-dp-on-surface-variant cursor-pointer"><X size={15} /></button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => { setEditingContactIdx(idx); setEditingContact(c) }} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={14} /></button>
                            <button onClick={() => removeContact(idx)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input placeholder="Name" value={newContact.name} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} className="input-field flex-1" />
                  <input placeholder="Designation" value={newContact.designation} onChange={(e) => setNewContact({ ...newContact, designation: e.target.value })} className="input-field flex-1" />
                  <input placeholder="WhatsApp number" value={newContact.whatsapp} onChange={(e) => setNewContact({ ...newContact, whatsapp: e.target.value })} className="input-field flex-1" />
                  <button onClick={addContact} className="flex items-center justify-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0"><PlusCircle size={15} /> Add</button>
                </div>
              </div>
            </>
          )}

          {activeCategory === 'connections' && (
            <>
              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3">
                  Sectors
                </h2>
                <div className="space-y-2 mb-4">
                  {sectors.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                      {editingSector === s.id ? (
                        <input autoFocus value={editingSectorName} onChange={(e) => setEditingSectorName(e.target.value)} className="input-field !py-1.5 flex-1" />
                      ) : (
                        <span className="font-sans text-[14px]">{s.name}</span>
                      )}
                      <div className="flex items-center gap-1 shrink-0">
                        {editingSector === s.id ? (
                          <>
                            <button onClick={() => renameSector(s.id)} className="p-1.5 text-emerald-600 hover:text-emerald-700 cursor-pointer"><Check size={15} /></button>
                            <button onClick={() => setEditingSector(null)} className="p-1.5 text-dp-on-surface-variant cursor-pointer"><X size={15} /></button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => { setEditingSector(s.id); setEditingSectorName(s.name) }} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={14} /></button>
                            <button onClick={() => setConfirmDeleteSector(s.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input value={newSectorName} onChange={(e) => setNewSectorName(e.target.value)} placeholder="New sector name" className="input-field flex-1" />
                  <button onClick={addSector} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0"><PlusCircle size={15} /> Add</button>
                </div>
              </div>

              {renderSettingGroups('connections')}
            </>
          )}

          {activeCategory === 'approvals' && (
            <>
              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3 flex items-center gap-2">
                  <ShieldCheck size={18} /> Approvers
                </h2>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-5">
                  Every person checked below must confirm a gated expense, withdrawal, or purchase (in their system) before it posts — or it auto-posts 24 hours after it was created regardless. Unchecking someone here immediately revokes their approver status; checking a different person allocates them instead — the roster is always exactly who&apos;s checked right now.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
                  {approvalSystems.map((s) => (
                    <div key={s.key}>
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{s.label} — Requires Approval For</p>
                      <div className="space-y-1.5 mb-4">
                        {approvalTypes.map((t) => {
                          const isOn = (typeSettings[s.key] ?? {})[t.key] ?? true
                          return (
                            <label key={t.key} className="flex items-center gap-2 cursor-pointer bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                              <input type="checkbox" checked={isOn} onChange={() => toggleTypeRequirement(s.key, t.key, isOn)} className="accent-dp-secondary" />
                              <span className="font-sans text-[13.5px]">{t.label}</span>
                            </label>
                          )
                        })}
                      </div>

                      <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{s.label} — Approver Roster</p>
                      {(eligibleApprovers[s.key] ?? []).length === 0 ? (
                        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">No eligible users for this system yet.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {(eligibleApprovers[s.key] ?? []).map((u) => {
                            const isActive = (activeApproverIds[s.key] ?? new Set()).has(u.id)
                            const stat = (approverStats[s.key] ?? []).find((x) => x.admin_user_id === u.id)
                            return (
                              <label key={u.id} className="flex items-center justify-between gap-2 cursor-pointer bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                                <span className="flex items-center gap-2 min-w-0">
                                  <input type="checkbox" checked={isActive} onChange={() => toggleApprover(s.key, u.id, isActive)} className="accent-dp-secondary shrink-0" />
                                  <span className="font-sans text-[13.5px] truncate">{u.full_name}</span>
                                </span>
                                {isActive && stat && (
                                  <span className="font-sans text-[11px] text-dp-on-surface-variant shrink-0 whitespace-nowrap" title="Pending / Approved / Rejected / Approved-for-them-by-a-super-admin">
                                    {stat.pending_count} pending · {stat.approved_count} approved
                                    {stat.rejected_count > 0 && ` · ${stat.rejected_count} rejected`}
                                    {stat.overridden_count > 0 && ` · ${stat.overridden_count} overridden`}
                                  </span>
                                )}
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3 flex items-center gap-2">
                  <MessageSquareWarning size={18} /> Complaint Handlers
                </h2>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
                  Everyone checked below is notified the moment a complaint is registered for that system, and can be assigned or assign themselves to it. Verification (final sign-off) is granted separately per-person from User Management, not here.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {approvalSystems.map((s) => (
                    <div key={s.key}>
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{s.label}</p>
                      {(eligibleHandlers[s.key] ?? []).length === 0 ? (
                        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">No eligible users for this system yet.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {(eligibleHandlers[s.key] ?? []).map((u) => {
                            const isActive = (activeHandlerIds[s.key] ?? new Set()).has(u.id)
                            return (
                              <label key={u.id} className="flex items-center gap-2 cursor-pointer bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                                <input type="checkbox" checked={isActive} onChange={() => toggleHandler(s.key, u.id, isActive)} className="accent-dp-secondary" />
                                <span className="font-sans text-[13.5px]">{u.full_name}</span>
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3 flex items-center gap-2">
                  <Bell size={18} /> Notification Preferences
                </h2>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
                  Choose how each alert reaches people — an in-app popup (instant, only seen while logged in) and/or a WhatsApp message (opens a pre-filled chat someone taps to send, since no WhatsApp Business API is connected). Both can be on at once.
                </p>
                {notifPrefs.length === 0 ? (
                  <p className="font-sans text-[13px] text-dp-on-surface-variant">No notification types configured yet.</p>
                ) : (
                  <div className="space-y-2">
                    {notifPrefs.map((p) => (
                      <div key={p.event_type} className="flex items-center justify-between gap-3 bg-dp-surface-container-low/50 rounded-lg px-4 py-3 flex-wrap">
                        <span className="font-sans text-[13.5px] text-dp-on-surface">{p.label}</span>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={p.popup_enabled} onChange={() => toggleNotifChannel(p.event_type, 'popup_enabled', p.popup_enabled)} className="accent-dp-secondary" />
                            <span className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-center gap-1"><Bell size={12} /> Popup</span>
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={p.whatsapp_enabled} onChange={() => toggleNotifChannel(p.event_type, 'whatsapp_enabled', p.whatsapp_enabled)} className="accent-[#25d366]" />
                            <span className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-center gap-1"><MessageCircle size={12} /> WhatsApp</span>
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {activeCategory === 'danger' && (
            <div className="bg-white border-2 border-dp-error/40 rounded-lg p-6">
              <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-error mb-1 flex items-center gap-2">
                <AlertTriangle size={20} /> Danger Zone
              </h2>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4 pb-3 border-b border-dp-outline-variant">
                Resetting a system permanently clears its bills, payments, vouchers, purchases, inventory movement history, and recurring schedules. Consumers, inventory stock levels, and the chart of accounts are kept exactly as they are. This cannot be undone.
              </p>
              <div className="space-y-3">
                {(['water_supply', 'donors_projects'] as const).map((sys) => (
                  <div key={sys} className="border border-dp-outline-variant rounded-lg p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-sans text-[14px] font-semibold text-dp-on-surface">{sys === 'water_supply' ? 'Water Supply' : 'Donors & Projects'}</span>
                      {resetSystem !== sys && (
                        <button onClick={() => { setResetSystem(sys); setResetConfirmText('') }} className="px-3 py-1.5 border border-dp-error text-dp-error rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-error/5 transition-all cursor-pointer">Reset...</button>
                      )}
                    </div>
                    {resetSystem === sys && (
                      <div className="mt-3 space-y-2 bg-dp-error-container/30 rounded-lg p-3">
                        <p className="font-sans text-[12.5px] text-dp-on-surface">
                          Type <span className="font-mono font-bold">{resetLabel(sys)}</span> to confirm.
                        </p>
                        <input
                          autoFocus value={resetConfirmText} onChange={(e) => setResetConfirmText(e.target.value)}
                          placeholder="Type to confirm" className="input-field !py-2 text-[14px]"
                        />
                        <div className="flex gap-2">
                          <button onClick={() => setResetSystem(null)} className="flex-1 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
                          <button
                            disabled={resetConfirmText !== resetLabel(sys) || resetting}
                            onClick={() => handleReset(sys)}
                            className="flex-1 px-3 py-2 bg-dp-error text-white rounded-lg font-sans text-[13px] font-semibold hover:opacity-90 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {resetting ? 'Resetting...' : 'Confirm Reset'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDeleteSector}
        title="Delete Sector"
        message="Existing consumers keep their assigned sector name as plain text — this only removes it from the dropdown for future use."
        onConfirm={deleteSector}
        onCancel={() => setConfirmDeleteSector(null)}
      />
    </>
  )
}
