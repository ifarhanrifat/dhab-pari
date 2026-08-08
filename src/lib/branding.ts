import { createClient } from '@/lib/supabase/client'
import type { InvoiceTemplate } from '@/components/admin/ReceiptDocument'

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
  footerComplaintNumber: string | null
  footerManagementContacts: ManagementContact[]
  footerFacebookLink: string | null
  footerWhatsappGroupLink: string | null
  footerProjectsLink: string | null
  footerDonationLink: string | null
}

const KEYS = [
  'company_name_en', 'company_name_ur', 'company_email',
  'invoice_logo_url', 'invoice_logo_width', 'invoice_logo_offset_y', 'invoice_signature_url',
  'display_language', 'invoice_template', 'helpline_numbers', 'invoice_instructions',
  'footer_complaint_number', 'footer_management_contacts',
  'footer_facebook_link', 'footer_whatsapp_group_link', 'footer_projects_link', 'footer_donation_link',
]

// Donor receipts can override any of these (migration 158) — company
// name/logo/signature stay shared (same organization identity either way),
// only wording/footer/help-numbers/template are ever donor-specific.
const DONOR_OVERRIDE_KEYS: Record<string, string> = {
  invoice_template: 'donor_invoice_template',
  helpline_numbers: 'donor_helpline_numbers',
  invoice_instructions: 'donor_invoice_instructions',
  footer_complaint_number: 'donor_footer_complaint_number',
  footer_management_contacts: 'donor_footer_management_contacts',
  footer_facebook_link: 'donor_footer_facebook_link',
  footer_whatsapp_group_link: 'donor_footer_whatsapp_group_link',
  footer_projects_link: 'donor_footer_projects_link',
  footer_donation_link: 'donor_footer_donation_link',
}

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
    }
    return v[sharedKey] ?? null
  }

  let contacts: ManagementContact[] = []
  const contactsRaw = pick('footer_management_contacts')
  if (contactsRaw) {
    try { contacts = JSON.parse(contactsRaw) } catch { contacts = [] }
  }

  return {
    companyNameEn: v.company_name_en || 'Dhab Pari',
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
    footerComplaintNumber: pick('footer_complaint_number'),
    footerManagementContacts: contacts,
    footerFacebookLink: pick('footer_facebook_link'),
    footerWhatsappGroupLink: pick('footer_whatsapp_group_link'),
    footerProjectsLink: pick('footer_projects_link'),
    footerDonationLink: pick('footer_donation_link'),
  }
}
