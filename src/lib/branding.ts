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

// Every generated bill, cash receipt, and payment voucher (ReceiptDocument) pulls
// its company identity and footer content from here — one place instead of three
// separate ad-hoc site_settings fetches that could silently drift out of sync.
export async function fetchBrandingSettings(): Promise<BrandingSettings> {
  const supabase = createClient()
  const { data } = await supabase.from('site_settings').select('key, value').in('key', KEYS)
  const v = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]))

  let contacts: ManagementContact[] = []
  if (v.footer_management_contacts) {
    try { contacts = JSON.parse(v.footer_management_contacts) } catch { contacts = [] }
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
    invoiceTemplate: (v.invoice_template as InvoiceTemplate) || 'classic',
    helplineNumbers: v.helpline_numbers ?? null,
    instructions: v.invoice_instructions ?? null,
    footerComplaintNumber: v.footer_complaint_number ?? null,
    footerManagementContacts: contacts,
    footerFacebookLink: v.footer_facebook_link ?? null,
    footerWhatsappGroupLink: v.footer_whatsapp_group_link ?? null,
    footerProjectsLink: v.footer_projects_link ?? null,
    footerDonationLink: v.footer_donation_link ?? null,
  }
}
