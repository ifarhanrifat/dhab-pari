'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Save, PlusCircle, Trash2, Pencil, X, Check, Bell, MessageCircle, ShieldCheck, MessageSquareWarning, AlertTriangle, Copy, MessageSquareText, Building2, Wallet, FileText, MapPin, Heart, ChevronDown, ChevronRight, ChevronLeft, Languages } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import type { ManagementContact } from '@/lib/branding'
import { TEMPLATE_KEYS } from '@/lib/messageTemplates'
import { SITE } from '@/lib/constants'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { MODULES } from '@/lib/constants'
import { LanguageSettings } from '@/components/admin/LanguageSettings'
import { useLocale } from '@/lib/i18n/LocaleProvider'

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
  { id: 'universal', label: 'Universal Slip (Recommended)', blurb: 'One design for A4 and Bluetooth thermal, bilingual labels, branded contact icons' },
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

type SettingsCategory = 'general' | 'payments' | 'language' | 'documents' | 'donorTemplates' | 'connections' | 'approvals' | 'danger'

// Grouped by which part of the system each one belongs to, so a village that
// runs only water supply — or only donations — sees a settings screen with
// nothing in it belonging to a module they do not have. The `system` field is
// what does that filtering; `group` is only the heading it sits under.
const CATEGORIES: {
  id: SettingsCategory
  label: string
  icon: typeof Building2
  group: string
  blurb: string
  system?: 'water_supply' | 'donors_projects'
}[] = [
  { id: 'general', label: 'Committee & Identity', icon: Building2, group: 'Committee',
    blurb: 'Name, display language, about text and office hours' },
  { id: 'payments', label: 'Payment Methods', icon: Wallet, group: 'Committee',
    blurb: 'WhatsApp, JazzCash, Easypaisa and bank details' },
  { id: 'language', label: 'Language & Wording', icon: Languages, group: 'Committee',
    blurb: 'Urdu and English wording, voucher types and report column headings' },

  { id: 'connections', label: 'Connections & Billing', icon: MapPin, group: 'Water Supply', system: 'water_supply',
    blurb: 'Sectors, new connection charges and reminder fees' },
  { id: 'documents', label: 'Bills & Water Documents', icon: FileText, group: 'Water Supply', system: 'water_supply',
    blurb: 'Bill template, slip format, footer links and WhatsApp messages' },

  { id: 'donorTemplates', label: 'Receipts & Donor Documents', icon: Heart, group: 'Donors & Projects', system: 'donors_projects',
    blurb: 'Donation receipt template, slip format and donor footer' },

  { id: 'approvals', label: 'Approvals & Alerts', icon: ShieldCheck, group: 'System',
    blurb: 'Who approves spending, who handles complaints, which alerts are sent' },
  { id: 'danger', label: 'Danger Zone', icon: AlertTriangle, group: 'System',
    blurb: 'Reset an accounting system — irreversible' },
]

const settingGroups: { label: string; keys: string[]; category: SettingsCategory }[] = [
  { label: 'Accounts Display Language', keys: ['display_language'], category: 'general' },
  { label: 'WhatsApp', keys: ['whatsapp_number', 'whatsapp_link'], category: 'payments' },
  {
    label: 'Donor & Projects — Payment Accounts', keys: [
      'donor_jazzcash_number', 'donor_jazzcash_name', 'donor_easypaisa_number', 'donor_easypaisa_name',
      'donor_bank_name', 'donor_bank_account_title', 'donor_bank_account_number', 'donor_bank_iban',
      'donor_bank_branch', 'donor_bank_branch_code',
    ], category: 'payments',
  },
  {
    label: 'Water Supply — Payment Accounts', keys: [
      'water_jazzcash_number', 'water_jazzcash_name', 'water_easypaisa_number', 'water_easypaisa_name',
      'water_bank_name', 'water_bank_account_title', 'water_bank_account_number', 'water_bank_iban',
      'water_bank_branch', 'water_bank_branch_code',
    ], category: 'payments',
  },
  { label: 'Office', keys: ['office_hours'], category: 'general' },
  {
    label: 'Universal Slip — Language, Type Size & Printer', keys: [
      'slip_display_mode', 'slip_font_heading', 'slip_font_body', 'slip_font_footer',
      'slip_format_water', 'slip_format_donor', 'footer_website_link',
    ],
    category: 'documents',
  },
  {
    label: 'Invoice Footer', keys: [
      'helpline_numbers', 'helpline_label_en', 'helpline_label_ur',
      'footer_complaint_number', 'complaint_label_en', 'complaint_label_ur',
      'invoice_instructions', 'receipt_fund_note',
      'footer_facebook_link', 'footer_whatsapp_group_link', 'footer_whatsapp_chat',
      'footer_projects_link', 'footer_donation_link',
      'footer_suggestions_link', 'footer_complaints_link',
    ],
    category: 'documents',
  },
  {
    label: 'Donor Invoice Footer', keys: [
      'donor_helpline_numbers', 'donor_helpline_label_en', 'donor_helpline_label_ur',
      'donor_footer_complaint_number', 'donor_complaint_label_en', 'donor_complaint_label_ur',
      'donor_invoice_instructions', 'donor_receipt_fund_note',
      'donor_footer_facebook_link', 'donor_footer_whatsapp_group_link', 'donor_footer_projects_link', 'donor_footer_donation_link',
      'donor_footer_website_link', 'donor_footer_whatsapp_chat',
      'donor_footer_suggestions_link', 'donor_footer_complaints_link',
    ],
    category: 'donorTemplates',
  },
  {
    label: 'Recurring Donation Policy (shown to donors)', keys: [
      'recurring_policy_ur', 'recurring_policy_en',
    ],
    category: 'donorTemplates',
  },
  {
    label: 'Publisher Content Rules', keys: [
      'publisher_guidelines_version', 'publisher_guidelines_ur', 'publisher_guidelines_en',
    ],
    category: 'documents',
  },
  { label: 'About', keys: ['about_text', 'vision', 'mission'], category: 'general' },
  { label: 'Reminders', keys: ['defaulter_restore_fee'], category: 'connections' },
  { label: 'New Connection Charges', keys: ['connection_plumber_charge', 'connection_digging_charge', 'connection_security_deposit'], category: 'connections' },
]

const emptyContact: ManagementContact = { name: '', designation: '', whatsapp: '' }

// Every settings section used to be an always-open card, so a category like
// "Documents & Templates" was one long unbroken scroll and finding anything
// meant hunting. Each section is now a collapsible card with a chevron; the
// first section of a category opens by default so the page never looks empty.
function SettingsSection({
  title, icon: Icon, description, defaultOpen = false, children,
}: {
  title: string
  icon?: typeof Building2
  description?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-5 sm:px-6 py-4 text-start cursor-pointer hover:bg-dp-surface-container-low/60 transition-colors"
      >
        <span className="flex items-center gap-2.5 min-w-0">
          {Icon && <Icon size={17} className="text-dp-secondary shrink-0" />}
          <span className="font-sans text-[16px] sm:text-[17px] font-semibold text-dp-primary truncate">{title}</span>
        </span>
        <ChevronDown size={18} className={`shrink-0 text-dp-on-surface-variant transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-5 sm:px-6 pb-6 pt-1 border-t border-dp-outline-variant">
          {description && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4 mt-3">{description}</p>}
          <div className={description ? '' : 'mt-4'}>{children}</div>
        </div>
      )}
    </div>
  )
}

export default function AdminSettingsPage() {
  const { t: tr, isUrdu } = useLocale()
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
  // Donor Templates' own Management Contacts list — separate from the
  // shared one above, same shape/handlers, shown only on donor receipts.
  const [donorManagementContacts, setDonorManagementContacts] = useState<ManagementContact[]>([])
  const [newDonorContact, setNewDonorContact] = useState<ManagementContact>(emptyContact)
  const [editingDonorContactIdx, setEditingDonorContactIdx] = useState<number | null>(null)
  const [editingDonorContact, setEditingDonorContact] = useState<ManagementContact>(emptyContact)
  const [resetSystem, setResetSystem] = useState<'water_supply' | 'donors_projects' | null>(null)
  const [resetConfirmText, setResetConfirmText] = useState('')
  const [resetting, setResetting] = useState(false)
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [savingTemplate, setSavingTemplate] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general')
  // On a phone the category list is the whole screen until one is picked, the
  // way a settings app works — the old horizontal strip of seven tabs meant
  // the later ones were permanently off-screen and never found.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(true)
  const access = useSystemAccess()

  const visibleCategories = CATEGORIES.filter((c) => {
    if (c.system === 'water_supply') return MODULES.waterSupply && (access.loading || access.canWaterSupply)
    if (c.system === 'donors_projects') return MODULES.donors && (access.loading || access.canDonorsProjects)
    return true
  })

  // If the open category belongs to a module this user cannot see, fall back
  // rather than rendering a panel they should not be looking at.
  useEffect(() => {
    if (access.loading) return
    if (!visibleCategories.some((c) => c.id === activeCategory)) setActiveCategory('general')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.loading, access.canWaterSupply, access.canDonorsProjects])
  const supabase = createClient()

  const resetLabel = (sys: 'water_supply' | 'donors_projects') => (sys === 'water_supply' ? 'WATER SUPPLY' : 'DONORS PROJECTS')

  const handleReset = async (system: 'water_supply' | 'donors_projects') => {
    setResetting(true)
    const { error } = await supabase.rpc('reset_accounting_system', { p_system: system })
    setResetting(false)
    if (error) { toast.error(friendlyError(error)); return }
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
    if (error) { toast.error(friendlyError(error)); return }
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
      if (error) { toast.error(friendlyError(error)); loadApprovers(); return }
    } else {
      const { error } = await supabase.from('approval_approvers').upsert(
        { system, admin_user_id: adminUserId, is_active: true },
        { onConflict: 'system,admin_user_id' }
      )
      if (error) { toast.error(friendlyError(error)); loadApprovers(); return }
    }
    toast.success(isActive ? 'Approver removed' : 'Approver added')
    loadApprovers()
  }

  const toggleTypeRequirement = async (system: string, type: string, current: boolean) => {
    setTypeSettings({ ...typeSettings, [system]: { ...typeSettings[system], [type]: !current } })
    const { error } = await supabase.from('approval_type_settings').update({ requires_approval: !current, updated_at: new Date().toISOString() }).eq('system', system).eq('transaction_type', type)
    if (error) { toast.error(friendlyError(error)); loadTypeSettings(); return }
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
      if (error) { toast.error(friendlyError(error)); loadHandlers(); return }
    } else {
      const { error } = await supabase.from('complaint_handlers').upsert(
        { system, admin_user_id: adminUserId, is_active: true },
        { onConflict: 'system,admin_user_id' }
      )
      if (error) { toast.error(friendlyError(error)); loadHandlers(); return }
    }
    toast.success(isActive ? 'Handler removed' : 'Handler added')
  }

  const toggleNotifChannel = async (eventType: string, channel: 'whatsapp_enabled' | 'popup_enabled', current: boolean) => {
    setNotifPrefs((cur) => cur.map((p) => (p.event_type === eventType ? { ...p, [channel]: !current } : p)))
    const { error } = await supabase.from('notification_preferences').update({ [channel]: !current, updated_at: new Date().toISOString() }).eq('event_type', eventType)
    if (error) { toast.error(friendlyError(error)); loadNotifPrefs(); return }
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
      if (v.donor_footer_management_contacts) {
        try { setDonorManagementContacts(JSON.parse(v.donor_footer_management_contacts)) } catch { setDonorManagementContacts([]) }
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
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Sector added')
    setNewSectorName('')
    loadSectors()
  }

  const renameSector = async (id: string) => {
    if (!editingSectorName.trim()) { toast.error('Sector name required'); return }
    const { error } = await supabase.from('sectors').update({ name: editingSectorName.trim() }).eq('id', id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Sector renamed')
    setEditingSector(null)
    loadSectors()
  }

  const deleteSector = async () => {
    if (!confirmDeleteSector) return
    const { error } = await supabase.from('sectors').delete().eq('id', confirmDeleteSector)
    if (error) { toast.error(friendlyError(error)); setConfirmDeleteSector(null); return }
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

  const addDonorContact = () => {
    if (!newDonorContact.name.trim()) { toast.error('Contact name required'); return }
    setDonorManagementContacts([...donorManagementContacts, { ...newDonorContact }])
    setNewDonorContact(emptyContact)
  }

  const removeDonorContact = (idx: number) => {
    setDonorManagementContacts(donorManagementContacts.filter((_, i) => i !== idx))
  }

  const saveEditingDonorContact = (idx: number) => {
    if (!editingDonorContact.name.trim()) { toast.error('Contact name required'); return }
    setDonorManagementContacts(donorManagementContacts.map((c, i) => (i === idx ? { ...editingDonorContact } : c)))
    setEditingDonorContactIdx(null)
  }

  const saveAll = async () => {
    setSaving(true)
    const finalValues = {
      ...values,
      footer_management_contacts: JSON.stringify(managementContacts),
      donor_footer_management_contacts: JSON.stringify(donorManagementContacts),
    }
    const updates = Object.entries(finalValues).map(([key, value]) =>
      supabase.from('site_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key)
    )
    await Promise.all(updates)
    setValues(finalValues)
    toast.success('Settings saved')
    setSaving(false)
  }

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant">{tr('st.loading')}</div>

  // Renders the generic key/value cards for whichever settingGroups belong to
  // a category — shared across every category tab that has any, instead of
  // repeating this block per tab.
  // Categories that render bespoke sections above their generic settingGroups
  // — there the first *visible* card is one of those, so the first generic
  // group shouldn't also auto-open (two open cards looks arbitrary).
  const hasBespokeSectionAbove = (category: SettingsCategory) =>
    category === 'general' || category === 'documents' || category === 'donorTemplates' || category === 'connections'

  const renderSettingGroups = (category: SettingsCategory) => (
    <>
      {settingGroups.filter((g) => g.category === category).map((group, groupIdx) => (
        <SettingsSection key={group.label} title={group.label} defaultOpen={groupIdx === 0 && !hasBespokeSectionAbove(category)}>
          <div className="space-y-4">
            {group.keys.map((key) => {
              const setting = settings.find((s) => s.key === key)
              const isLong = ['about_text', 'vision', 'mission', 'invoice_instructions', 'donor_invoice_instructions', 'receipt_fund_note', 'donor_receipt_fund_note', 'publisher_guidelines_ur', 'publisher_guidelines_en', 'recurring_policy_ur', 'recurring_policy_en'].includes(key)
              return (
                <div key={key}>
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                    {key.replace(/_/g, ' ').toUpperCase()}
                    {setting?.description && <span className="font-normal text-[12px] ms-2 opacity-70">— {setting.description}</span>}
                  </label>
                  {key === 'slip_display_mode' ? (
                    <>
                      <select value={values[key] || 'both'} onChange={(e) => setValues({ ...values, [key]: e.target.value })} className="input-field">
                        <option value="both">{tr('st.bothLangs')}</option>
                        <option value="en">{tr('st.englishOnly')}</option>
                        <option value="ur">{tr('st.urduOnly')}</option>
                      </select>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-2">
                        Applies to the Universal Slip. &ldquo;Both&rdquo; prints each label in English and Urdu together (Donation Received / عطیہ وصولی) so neither language has to give up its slot. Names, amounts and anything typed in always print exactly as entered.
                      </p>
                    </>
                  ) : key === 'slip_format_water' || key === 'slip_format_donor' ? (
                    <>
                      <select value={values[key] || 'a4'} onChange={(e) => setValues({ ...values, [key]: e.target.value })} className="input-field">
                        <option value="a4">A4 printer / PDF</option>
                        <option value="thermal">{tr('st.thermal')}</option>
                      </select>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-2">
                        Which target is pre-selected when a {key === 'slip_format_donor' ? 'donor' : 'consumer'} slip is opened. Whoever is printing can still switch it on the slip itself.
                      </p>
                    </>
                  ) : key.startsWith('slip_font_') ? (
                    <div className="flex items-center gap-3">
                      <input
                        type="number" min={8} max={48}
                        value={values[key] ?? ''}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                        className="input-field max-w-[120px]"
                      />
                      <span className="font-sans text-[12px] text-dp-on-surface-variant">px</span>
                      <span
                        className="font-sans text-dp-on-surface truncate"
                        style={{ fontSize: Math.min(Math.max(Number(values[key]) || 14, 8), 48) }}
                      >
                        {tr('st.sample')}
                      </span>
                    </div>
                  ) : key === 'display_language' ? (
                    <>
                      <select
                        value={values[key] || 'en'}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                        className="input-field"
                      >
                        <option value="en">{tr('st.english')}</option>
                        <option value="ur">{tr('st.urdu')}</option>
                      </select>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant mt-2">
                        When set to Urdu, every bill, receipt, voucher, printable statement/register, and report switches to Urdu — labels, headings, and table columns. Company name/email and any name or note actually typed in (consumer names, particulars, etc.) always stay exactly as entered, in whichever script was used.
                      </p>
                    </>
                  ) : isLong ? (
                    <textarea
                      value={values[key] ?? ''}
                      onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      rows={key.startsWith('publisher_guidelines') || key.startsWith('recurring_policy') ? 14 : 3}
                      dir={key.endsWith('_ur') ? 'rtl' : 'ltr'}
                      className="input-field resize-y"
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
        </SettingsSection>
      ))}
    </>
  )

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-[28px] sm:text-[32px] font-bold leading-[40px] text-dp-primary">{tr('st.title')}</h1>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">Changes in most sections save immediately. Company/branding/payment/document fields are staged — use Save All below.</p>
        </div>
        <button onClick={saveAll} disabled={saving} className="flex items-center gap-2 px-6 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 shrink-0">
          <Save size={16} /> {saving ? 'Saving...' : 'Save All'}
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-6 items-start">
        {/* Category navigation.
            Desktop: a grouped sidebar, so "which module does this belong to" is
            visible at a glance.
            Mobile: the list IS the screen until something is picked, then it is
            replaced by that section with a back arrow — the previous horizontal
            strip pushed four of the seven tabs off the edge where nobody found
            them. */}
        <nav
          className={`w-full md:w-64 shrink-0 md:sticky md:top-6 ${mobileMenuOpen ? 'block' : 'hidden'} md:block`}
        >
          <div className="bg-white border border-dp-outline-variant rounded-lg p-2 space-y-1">
            {Array.from(new Set(visibleCategories.map((c) => c.group))).map((group) => (
              <div key={group}>
                <p className="px-3 pt-3 pb-1.5 font-sans text-[11px] font-bold uppercase tracking-[0.08em] text-dp-outline">
                  {group}
                </p>
                {visibleCategories.filter((c) => c.group === group).map((cat) => {
                  const Icon = cat.icon
                  const active = activeCategory === cat.id
                  const danger = cat.id === 'danger'
                  return (
                    <button
                      key={cat.id}
                      onClick={() => { setActiveCategory(cat.id); setMobileMenuOpen(false) }}
                      className={`w-full flex items-start gap-2.5 px-3.5 py-3 md:py-2.5 rounded-lg font-sans cursor-pointer transition-all text-start ${
                        active
                          ? danger ? 'bg-dp-error/10 text-dp-error' : 'bg-dp-secondary text-white'
                          : danger ? 'text-dp-error hover:bg-dp-error/5' : 'text-dp-on-surface-variant hover:bg-dp-surface-container-low'
                      }`}
                    >
                      <Icon size={17} className="shrink-0 mt-0.5" />
                      <span className="min-w-0">
                        <span className="block text-[14px] md:text-[13.5px] font-semibold">{cat.label}</span>
                        {/* The blurb answers "is the thing I want in here?"
                            without opening every section to find out. */}
                        <span className={`block text-[11.5px] font-normal leading-snug mt-0.5 md:hidden ${active ? 'text-white/75' : 'text-dp-on-surface-variant/75'}`}>
                          {cat.blurb}
                        </span>
                      </span>
                      <ChevronRight size={16} className={`shrink-0 ms-auto mt-0.5 md:hidden ${active ? 'text-white/70' : 'text-dp-outline'}`} />
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </nav>

        {/* Category content */}
        <div className={`flex-1 min-w-0 space-y-6 ${mobileMenuOpen ? 'hidden' : 'block'} md:block`}>
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="md:hidden flex items-center gap-1.5 text-dp-secondary font-sans text-[13.5px] font-semibold cursor-pointer mb-1"
          >
            <ChevronLeft size={17} /> {tr('st.allSettings')}
          </button>
          {activeCategory === 'general' && (
            <>
              <SettingsSection title="Company Identity" icon={Building2} defaultOpen>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{tr('st.companyNameEn')}</label>
                    <input type="text" value={values.company_name_en ?? ''} onChange={(e) => setValues({ ...values, company_name_en: e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{tr('st.companyNameUr')}</label>
                    <input
                      type="text" dir="rtl" value={values.company_name_ur ?? ''}
                      onChange={(e) => setValues({ ...values, company_name_ur: e.target.value })}
                      style={{ fontFamily: 'var(--font-urdu), serif', textAlign: 'right' }}
                      className="input-field"
                    />
                  </div>
                  <div>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{tr('st.companyEmail')}</label>
                    <input type="email" value={values.company_email ?? ''} onChange={(e) => setValues({ ...values, company_email: e.target.value })} className="input-field" />
                  </div>
                </div>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-3">Shown on every generated bill, cash receipt, and payment voucher. The Urdu name only appears when the display language below is set to Urdu.</p>
              </SettingsSection>

              <SettingsSection title="Branding" icon={FileText}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <ImageUpload bucket="images" label="Committee Logo" currentUrl={values.invoice_logo_url} onUpload={(url) => setValues({ ...values, invoice_logo_url: url })} />
                  <ImageUpload bucket="images" label="Authorized Signature" currentUrl={values.invoice_signature_url} onUpload={(url) => setValues({ ...values, invoice_signature_url: url })} />
                </div>
                {values.invoice_logo_url && (
                  <div className="mt-6 pt-6 border-t border-dp-outline-variant">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-4">
                      <div>
                        <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{tr('st.logoSize')}</label>
                        <input type="number" min={20} max={200} value={values.invoice_logo_width || '56'} onChange={(e) => setValues({ ...values, invoice_logo_width: e.target.value })} className="input-field" />
                      </div>
                      <div>
                        <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{tr('st.verticalPos')}</label>
                        <input type="number" value={values.invoice_logo_offset_y || '0'} onChange={(e) => setValues({ ...values, invoice_logo_offset_y: e.target.value })} className="input-field" />
                      </div>
                    </div>
                    <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-2">Preview — top-left corner, heading stays centered, on every generated bill, receipt, and voucher:</p>
                    <div dir="ltr" className="relative text-center bg-dp-surface-container-low/60 rounded-lg p-4">
                      <img
                        src={values.invoice_logo_url} alt="Logo preview"
                        style={{ width: +(values.invoice_logo_width || 56), height: +(values.invoice_logo_width || 56), marginTop: +(values.invoice_logo_offset_y || 0) }}
                        className="absolute left-4 top-4 object-contain"
                      />
                      {values.display_language === 'ur' && (
                        <p className="text-[16px] font-bold mb-1.5" style={{ fontFamily: 'var(--font-urdu), serif' }}>واٹر اینڈ ویلفئیر کمیٹی</p>
                      )}
                      <p className="text-[13px] font-bold text-dp-on-surface-variant">{SITE.name}</p>
                    </div>
                  </div>
                )}
              </SettingsSection>

              {renderSettingGroups('general')}
            </>
          )}

          {activeCategory === 'payments' && renderSettingGroups('payments')}

          {activeCategory === 'language' && <LanguageSettings />}

          {activeCategory === 'documents' && (
            <>
              <SettingsSection title="Message Templates" icon={MessageSquareText} defaultOpen>
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
                          {tr('st.tagsYouCanUse')}
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
              </SettingsSection>

              <SettingsSection title="Invoice Template">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {invoiceTemplates.map((t) => {
                    const selected = (values.invoice_template || 'classic') === t.id
                    return (
                      <button
                        key={t.id}
                        onClick={() => setValues({ ...values, invoice_template: t.id })}
                        className={`text-start p-4 rounded-lg border-2 cursor-pointer transition-all ${selected ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
                      >
                        <p className={`font-sans text-[14px] font-bold mb-1 ${selected ? 'text-dp-secondary' : 'text-dp-on-surface'}`}>{t.label}</p>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t.blurb}</p>
                      </button>
                    )
                  })}
                </div>
              </SettingsSection>

              {renderSettingGroups('documents')}

              <SettingsSection title="Management Contacts">
                <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4">Committee members shown in the invoice footer, with their WhatsApp number — helps consumers reach the right person about a bill.</p>
                <div className="space-y-2 mb-4">
                  {managementContacts.map((c, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-2 bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                      {editingContactIdx === idx ? (
                        <div className="flex flex-col sm:flex-row gap-2 flex-1">
                          <input autoFocus placeholder="Name" value={editingContact.name} onChange={(e) => setEditingContact({ ...editingContact, name: e.target.value })} className="input-field !py-1.5 flex-1" />
                          <input placeholder="Designation" value={editingContact.designation} onChange={(e) => setEditingContact({ ...editingContact, designation: e.target.value })} className="input-field !py-1.5 flex-1" />
                          <input placeholder="WhatsApp number" value={editingContact.whatsapp} onChange={(e) => setEditingContact({ ...editingContact, whatsapp: e.target.value })} className="input-field !py-1.5 flex-1" />
                        </div>
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
              </SettingsSection>
            </>
          )}

          {activeCategory === 'donorTemplates' && (
            <>
              <div className="bg-white border border-dp-outline-variant rounded-lg p-6">
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                  Everything here applies only to donation receipts — company name and logo stay shared with Water Supply (same organization), but the template style, help numbers, footer wording, and management contacts below can be set independently. Leave any of them blank to keep using the shared Water Supply version instead.
                </p>
              </div>

              <SettingsSection title="Invoice Template">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <button
                    onClick={() => setValues({ ...values, donor_invoice_template: '' })}
                    className={`text-start p-4 rounded-lg border-2 cursor-pointer transition-all ${!values.donor_invoice_template ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
                  >
                    <p className={`font-sans text-[14px] font-bold mb-1 ${!values.donor_invoice_template ? 'text-dp-secondary' : 'text-dp-on-surface'}`}>{tr('st.sameAsWater')}</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant">Uses whichever template is picked under Documents &amp; Templates</p>
                  </button>
                  {invoiceTemplates.map((t) => {
                    const selected = values.donor_invoice_template === t.id
                    return (
                      <button
                        key={t.id}
                        onClick={() => setValues({ ...values, donor_invoice_template: t.id })}
                        className={`text-start p-4 rounded-lg border-2 cursor-pointer transition-all ${selected ? 'border-dp-secondary bg-dp-secondary/5' : 'border-dp-outline-variant hover:bg-dp-surface-container-low'}`}
                      >
                        <p className={`font-sans text-[14px] font-bold mb-1 ${selected ? 'text-dp-secondary' : 'text-dp-on-surface'}`}>{t.label}</p>
                        <p className="font-sans text-[12px] text-dp-on-surface-variant">{t.blurb}</p>
                      </button>
                    )
                  })}
                </div>
              </SettingsSection>

              {renderSettingGroups('donorTemplates')}

              <SettingsSection title="Management Contacts">
                <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4">Committee members shown in the footer of donation receipts specifically — leave empty to keep showing the shared Management Contacts instead.</p>
                <div className="space-y-2 mb-4">
                  {donorManagementContacts.map((c, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-2 bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                      {editingDonorContactIdx === idx ? (
                        <div className="flex flex-col sm:flex-row gap-2 flex-1">
                          <input autoFocus placeholder="Name" value={editingDonorContact.name} onChange={(e) => setEditingDonorContact({ ...editingDonorContact, name: e.target.value })} className="input-field !py-1.5 flex-1" />
                          <input placeholder="Designation" value={editingDonorContact.designation} onChange={(e) => setEditingDonorContact({ ...editingDonorContact, designation: e.target.value })} className="input-field !py-1.5 flex-1" />
                          <input placeholder="WhatsApp number" value={editingDonorContact.whatsapp} onChange={(e) => setEditingDonorContact({ ...editingDonorContact, whatsapp: e.target.value })} className="input-field !py-1.5 flex-1" />
                        </div>
                      ) : (
                        <span className="font-sans text-[14px] flex-1">
                          {c.name}
                          {c.designation && <span className="text-dp-on-surface-variant"> — {c.designation}</span>}
                          {c.whatsapp && <span className="text-dp-on-surface-variant"> — {c.whatsapp}</span>}
                        </span>
                      )}
                      <div className="flex items-center gap-1 shrink-0">
                        {editingDonorContactIdx === idx ? (
                          <>
                            <button onClick={() => saveEditingDonorContact(idx)} className="p-1.5 text-emerald-600 hover:text-emerald-700 cursor-pointer"><Check size={15} /></button>
                            <button onClick={() => setEditingDonorContactIdx(null)} className="p-1.5 text-dp-on-surface-variant cursor-pointer"><X size={15} /></button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => { setEditingDonorContactIdx(idx); setEditingDonorContact(c) }} className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Pencil size={14} /></button>
                            <button onClick={() => removeDonorContact(idx)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={14} /></button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input placeholder="Name" value={newDonorContact.name} onChange={(e) => setNewDonorContact({ ...newDonorContact, name: e.target.value })} className="input-field flex-1" />
                  <input placeholder="Designation" value={newDonorContact.designation} onChange={(e) => setNewDonorContact({ ...newDonorContact, designation: e.target.value })} className="input-field flex-1" />
                  <input placeholder="WhatsApp number" value={newDonorContact.whatsapp} onChange={(e) => setNewDonorContact({ ...newDonorContact, whatsapp: e.target.value })} className="input-field flex-1" />
                  <button onClick={addDonorContact} className="flex items-center justify-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0"><PlusCircle size={15} /> Add</button>
                </div>
              </SettingsSection>
            </>
          )}

          {activeCategory === 'connections' && (
            <>
              <SettingsSection title="Sectors" icon={MapPin} defaultOpen>
                <div className="space-y-2 mb-4">
                  {sectors.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 bg-dp-surface-container-low/50 rounded-lg px-3 py-2 flex-wrap">
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
              </SettingsSection>

              {renderSettingGroups('connections')}
            </>
          )}

          {activeCategory === 'approvals' && (
            <>
              <SettingsSection title="Approvers" icon={ShieldCheck} defaultOpen>
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
                        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{tr('st.noEligible')}</p>
                      ) : (
                        <div className="space-y-1.5">
                          {(eligibleApprovers[s.key] ?? []).map((u) => {
                            const isActive = (activeApproverIds[s.key] ?? new Set()).has(u.id)
                            const stat = (approverStats[s.key] ?? []).find((x) => x.admin_user_id === u.id)
                            return (
                              <label key={u.id} className="flex items-center justify-between gap-2 cursor-pointer bg-dp-surface-container-low/50 rounded-lg px-3 py-2 flex-wrap">
                                <span className="flex items-center gap-2 min-w-0">
                                  <input type="checkbox" checked={isActive} onChange={() => toggleApprover(s.key, u.id, isActive)} className="accent-dp-secondary shrink-0" />
                                  <span className="font-sans text-[13.5px] truncate">{u.full_name}</span>
                                </span>
                                {isActive && stat && (
                                  <span className="font-sans text-[11px] text-dp-on-surface-variant shrink-0" title="Pending / Approved / Rejected / Approved-for-them-by-a-super-admin">
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
              </SettingsSection>

              <SettingsSection title="Complaint Handlers" icon={MessageSquareWarning}>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
                  Everyone checked below is notified the moment a complaint is registered for that system, and can be assigned or assign themselves to it. Verification (final sign-off) is granted separately per-person from User Management, not here.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {approvalSystems.map((s) => (
                    <div key={s.key}>
                      <p className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2">{s.label}</p>
                      {(eligibleHandlers[s.key] ?? []).length === 0 ? (
                        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{tr('st.noEligible')}</p>
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
              </SettingsSection>

              <SettingsSection title="Notification Preferences" icon={Bell}>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">
                  Choose how each alert reaches people — an in-app popup (instant, only seen while logged in) and/or a WhatsApp message (opens a pre-filled chat someone taps to send, since no WhatsApp Business API is connected). Both can be on at once.
                </p>
                {notifPrefs.length === 0 ? (
                  <p className="font-sans text-[13px] text-dp-on-surface-variant">{tr('st.noNotifTypes')}</p>
                ) : (
                  <div className="space-y-2">
                    {notifPrefs.map((p) => (
                      <div key={p.event_type} className="flex items-center justify-between gap-3 bg-dp-surface-container-low/50 rounded-lg px-4 py-3 flex-wrap">
                        <span className="font-sans text-[13.5px] text-dp-on-surface">{p.label}</span>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={p.popup_enabled} onChange={() => toggleNotifChannel(p.event_type, 'popup_enabled', p.popup_enabled)} className="accent-dp-secondary" />
                            <span className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-center gap-1"><Bell size={12} /> {tr('st.popup')}</span>
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={p.whatsapp_enabled} onChange={() => toggleNotifChannel(p.event_type, 'whatsapp_enabled', p.whatsapp_enabled)} className="accent-[#25d366]" />
                            <span className="font-sans text-[12.5px] text-dp-on-surface-variant flex items-center gap-1"><MessageCircle size={12} /> {tr('w.whatsapp')}</span>
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SettingsSection>
            </>
          )}

          {activeCategory === 'danger' && (
            <div className="bg-white border-2 border-dp-error/40 rounded-lg p-6">
              <h2 className="font-sans text-[18px] font-semibold leading-[26px] text-dp-error mb-1 flex items-center gap-2">
                <AlertTriangle size={20} /> {tr('st.dangerZone')}
              </h2>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-4 pb-3 border-b border-dp-outline-variant">
                Resetting a system permanently clears its bills, payments, vouchers, purchases, inventory movement history, and recurring schedules. Consumers, inventory stock levels, and the chart of accounts are kept exactly as they are. This cannot be undone.
              </p>
              <div className="space-y-3">
                {(['water_supply', 'donors_projects'] as const)
                  // Only offer to wipe books this user can actually reach, and
                  // only modules this village runs. Reset is SECURITY DEFINER
                  // and checks permission itself — this keeps the button from
                  // being there to mis-click in the first place.
                  .filter((sys) => sys === 'water_supply'
                    ? MODULES.waterSupply && access.canWaterSupply
                    : MODULES.donors && access.canDonorsProjects)
                  .map((sys) => (
                  <div key={sys} className="border border-dp-outline-variant rounded-lg p-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <span className="font-sans text-[14px] font-semibold text-dp-on-surface">{sys === 'water_supply' ? 'Water Supply' : 'Donors & Projects'}</span>
                      {resetSystem !== sys && (
                        <button onClick={() => { setResetSystem(sys); setResetConfirmText('') }} className="px-3 py-1.5 border border-dp-error text-dp-error rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-error/5 transition-all cursor-pointer">{tr('st.reset')}</button>
                      )}
                    </div>
                    {resetSystem === sys && (
                      <div className="mt-3 space-y-2 bg-dp-error-container/30 rounded-lg p-3">
                        <p className="font-sans text-[12.5px] text-dp-on-surface">
                          {tr('a.type')} <span className="font-mono font-bold">{resetLabel(sys)}</span> to confirm.
                        </p>
                        <input
                          autoFocus value={resetConfirmText} onChange={(e) => setResetConfirmText(e.target.value)}
                          placeholder="Type to confirm" className="input-field !py-2 text-[14px]"
                        />
                        <div className="flex gap-2">
                          <button onClick={() => setResetSystem(null)} className="flex-1 px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">{tr('action.cancel')}</button>
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
    </div>
  )
}
