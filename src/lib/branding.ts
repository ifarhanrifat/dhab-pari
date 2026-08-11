import { createClient } from '@/lib/supabase/client'
import type { InvoiceTemplate } from '@/components/admin/ReceiptDocument'
import type { SlipLang } from '@/lib/docTranslations'
import { SITE } from '@/lib/constants'

export interface ManagementContact { name: string; designation: string; whatsapp: string }

export interface BrandingSettings {
  companyNameEn: string
  companyNameUr: string
  companyEmail: string
  logoUrl: string | null
  logoWidth: number
  logoOffsetY: number
  signatureUrl: string | null
  language: 'en' | 'ur'
  invoiceTemplate: InvoiceTemplate
  helplineNumbers: string | null
  instructions: string | null
  fundNote: string | null
  footerComplaintNumber: string | null
  footerManagementContacts: ManagementContact[]
  footerFacebookLink: string | null
  footerWhatsappGroupLink: string | null
  footerProjectsLink: string | null
  footerDonationLink: string | null
  footerWebsiteLink: string | null
  footerWhatsappChat: string | null
  // Green contact box wording — editable per system (migration 174). Null when
  // unset, which tells the slip to use its built-in wording.
  helplineLabelEn: string | null
  helplineLabelUr: string | null
  complaintLabelEn: string | null
  complaintLabelUr: string | null
  footerSuggestionsLink: string | null
  footerComplaintsLink: string | null
  // Universal Slip only — see migration 172.
  slipDisplayMode: SlipLang
  slipFontHeading: number
  slipFontBody: number
  slipFontFooter: number
  slipFormat: SlipFormat
}

export type SlipFormat = 'a4' | 'thermal'

const KEYS = [
  'company_name_en', 'company_name_ur', 'company_email',
  'invoice_logo_url', 'invoice_logo_width', 'invoice_logo_offset_y', 'invoice_signature_url',
  'display_language', 'invoice_template', 'helpline_numbers', 'invoice_instructions', 'receipt_fund_note',
  'footer_complaint_number', 'footer_management_contacts',
  'footer_facebook_link', 'footer_whatsapp_group_link', 'footer_projects_link', 'footer_donation_link',
  'footer_website_link', 'footer_whatsapp_chat', 'footer_suggestions_link', 'footer_complaints_link',
  'helpline_label_en', 'helpline_label_ur', 'complaint_label_en', 'complaint_label_ur',
  'slip_display_mode', 'slip_font_heading', 'slip_font_body', 'slip_font_footer',
  'slip_format_water', 'slip_format_donor',
]

// Donor receipts can override any of these (migration 158) — company
// name/logo/signature stay shared (same organization identity either way),
// only wording/footer/help-numbers/template are ever donor-specific.
const DONOR_OVERRIDE_KEYS: Record<string, string> = {
  invoice_template: 'donor_invoice_template',
  helpline_numbers: 'donor_helpline_numbers',
  invoice_instructions: 'donor_invoice_instructions',
  receipt_fund_note: 'donor_receipt_fund_note',
  footer_complaint_number: 'donor_footer_complaint_number',
  footer_management_contacts: 'donor_footer_management_contacts',
  footer_facebook_link: 'donor_footer_facebook_link',
  footer_whatsapp_group_link: 'donor_footer_whatsapp_group_link',
  footer_projects_link: 'donor_footer_projects_link',
  footer_donation_link: 'donor_footer_donation_link',
  footer_website_link: 'donor_footer_website_link',
  footer_whatsapp_chat: 'donor_footer_whatsapp_chat',
  helpline_label_en: 'donor_helpline_label_en',
  helpline_label_ur: 'donor_helpline_label_ur',
  complaint_label_en: 'donor_complaint_label_en',
  complaint_label_ur: 'donor_complaint_label_ur',
  footer_suggestions_link: 'donor_footer_suggestions_link',
  footer_complaints_link: 'donor_footer_complaints_link',
}

// Free-text prose keys — see the comment in pick() below.
const NO_FALLBACK_KEYS = new Set([
  'invoice_instructions', 'receipt_fund_note',
  // Same reason: a donor receipt must never inherit water-supply wording.
  'helpline_label_en', 'helpline_label_ur', 'complaint_label_en', 'complaint_label_ur',
])

// Every generated bill, cash receipt, and payment voucher (ReceiptDocument) pulls
// its company identity and footer content from here — one place instead of three
// separate ad-hoc site_settings fetches that could silently drift out of sync.
//
// Pass system: 'donors_projects' to let a donor_* override win over its
// shared counterpart wherever one has actually been filled in — otherwise
// (or for 'water_supply'/omitted) this behaves exactly as before.
export async function fetchBrandingSettings(system?: 'water_supply' | 'donors_projects'): Promise<BrandingSettings> {
  const supabase = createClient()
  const donorKeys = system === 'donors_projects' ? Object.values(DONOR_OVERRIDE_KEYS) : []
  const { data } = await supabase.from('site_settings').select('key, value').in('key', [...KEYS, ...donorKeys])
  const v = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]))

  const pick = (sharedKey: string): string | null => {
    if (system === 'donors_projects') {
      const donorValue = v[DONOR_OVERRIDE_KEYS[sharedKey]]
      if (donorValue) return donorValue
      // Prose written for one system is wrong on the other's paperwork — the
      // water supply's "don't waste water, pay by the 7th" note has no business
      // appearing on a donation receipt. Blank means blank for these, not
      // "inherit the water supply wording". Phone numbers, links and the
      // template style DO still fall back: those are the same either way.
      if (NO_FALLBACK_KEYS.has(sharedKey)) return null
    }
    return v[sharedKey] ?? null
  }

  // Guards against a blank or garbage value in settings collapsing the slip to
  // 0px type — a saved empty string must fall back to the default, not to NaN.
  const num = (raw: string | undefined, fallback: number) => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  let contacts: ManagementContact[] = []
  const contactsRaw = pick('footer_management_contacts')
  if (contactsRaw) {
    try { contacts = JSON.parse(contactsRaw) } catch { contacts = [] }
  }

  return {
    companyNameEn: v.company_name_en || SITE.name,
    companyNameUr: v.company_name_ur || 'واٹر اینڈ ویلفئیر کمیٹی',
    companyEmail: v.company_email || 'dhabpariwelfare@gmail.com',
    logoUrl: v.invoice_logo_url ?? null,
    logoWidth: v.invoice_logo_width ? +v.invoice_logo_width : 56,
    logoOffsetY: v.invoice_logo_offset_y ? +v.invoice_logo_offset_y : 0,
    signatureUrl: v.invoice_signature_url ?? null,
    language: v.display_language === 'ur' ? 'ur' : 'en',
    invoiceTemplate: (pick('invoice_template') as InvoiceTemplate) || 'classic',
    helplineNumbers: pick('helpline_numbers'),
    instructions: pick('invoice_instructions'),
    fundNote: pick('receipt_fund_note'),
    footerComplaintNumber: pick('footer_complaint_number'),
    footerManagementContacts: contacts,
    footerFacebookLink: pick('footer_facebook_link'),
    footerWhatsappGroupLink: pick('footer_whatsapp_group_link'),
    footerProjectsLink: pick('footer_projects_link'),
    footerDonationLink: pick('footer_donation_link'),
    footerWebsiteLink: pick('footer_website_link'),
    footerWhatsappChat: pick('footer_whatsapp_chat'),
    helplineLabelEn: pick('helpline_label_en'),
    helplineLabelUr: pick('helpline_label_ur'),
    complaintLabelEn: pick('complaint_label_en'),
    complaintLabelUr: pick('complaint_label_ur'),
    footerSuggestionsLink: pick('footer_suggestions_link'),
    footerComplaintsLink: pick('footer_complaints_link'),
    // Type sizes and label language are one global setting for both systems —
    // the committee prints on the same paper either way, so splitting these per
    // system would only create two places to keep in sync.
    slipDisplayMode: (['en', 'ur', 'both'].includes(v.slip_display_mode) ? v.slip_display_mode : 'both') as SlipLang,
    slipFontHeading: num(v.slip_font_heading, 21),
    slipFontBody: num(v.slip_font_body, 14),
    slipFontFooter: num(v.slip_font_footer, 12),
    slipFormat: (system === 'donors_projects' ? v.slip_format_donor : v.slip_format_water) === 'thermal' ? 'thermal' : 'a4',
  }
}
