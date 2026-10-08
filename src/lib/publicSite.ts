import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_TENANT_ID } from '@/lib/tenant'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

export interface PublicSite {
  name: string
  nameUrdu: string
  fullName: string
  fullNameUrdu: string
  shortCommittee: string
  committeeUrdu: string
  taglineUrdu: string

  whatsapp: string
  whatsappLink: string
  whatsappGroupLink: string
  facebookLink: string

  jazzcash: string
  jazzcashName: string
  easypaisa: string
  easypaisaName: string
  bankName: string
  bankAccount: string
  bankBranch: string

  district: string
  province: string
  location: string
  established: string
  email: string
  officeHours: string

  lat: number | null
  lng: number | null

  waterSupplyEnabled: boolean
  donorsEnabled: boolean
}

// A brand new tenant with none of the optional site_settings keys filled
// in yet still needs a working page -- derived straight from its own
// name, never from dhab-pari's. Payment fields are the one exception:
// an empty string here (never a real account) means "not configured",
// and every payment-detail-rendering spot must treat empty as "don't
// show this payment method" rather than printing a blank line.
function safeDefaults(name: string, nameUrdu: string): Omit<PublicSite, 'waterSupplyEnabled' | 'donorsEnabled'> {
  return {
    name, nameUrdu,
    fullName: name, fullNameUrdu: nameUrdu || name,
    shortCommittee: name,
    committeeUrdu: '',
    taglineUrdu: '',
    whatsapp: '', whatsappLink: '', whatsappGroupLink: '', facebookLink: '',
    jazzcash: '', jazzcashName: '', easypaisa: '', easypaisaName: '',
    bankName: '', bankAccount: '', bankBranch: '',
    district: '', province: '', location: '', established: '', email: '', officeHours: '',
    lat: null, lng: null,
  }
}

// Single source of truth for the public site's own identity and which
// modules it shows -- the public-facing counterpart to
// getTenantName()/getTenantWhatsapp() in src/lib/tenant.ts (those exist
// for outbound emails specifically; this covers the whole public website:
// Header, Footer, the homepage, document templates, OpenGraph images).
//
// Most fields reuse site_settings keys that already exist and are
// already tenant-scoped (migration 566) -- they just powered admin-side
// receipts/invoices until now, never the public site itself. A handful
// of brand_* keys (migration 638) cover what had no existing home.
export async function getPublicSiteContext(client: AnyClient, tenantId: string | null | undefined): Promise<PublicSite> {
  const id = tenantId || DEFAULT_TENANT_ID

  const [{ data: tenant }, { data: settingsRows }] = await Promise.all([
    client.from('tenants').select('name, name_ur, water_supply_enabled, donors_enabled').eq('id', id).maybeSingle(),
    client.from('site_settings').select('key, value').eq('tenant_id', id).in('key', [
      'brand_full_name', 'brand_full_name_ur', 'brand_short_committee', 'brand_committee_ur', 'brand_tagline_ur',
      'whatsapp_number', 'whatsapp_link', 'footer_whatsapp_group_link', 'footer_facebook_link',
      'jazzcash_number', 'jazzcash_name', 'easypaisa_number', 'easypaisa_name',
      'bank_name', 'bank_account', 'bank_branch',
      'brand_district', 'brand_province', 'brand_location', 'brand_established',
      'contact_email', 'office_hours', 'village_lat', 'village_lng',
    ]),
  ])

  const name = tenant?.name || 'Village Committee'
  const nameUrdu = tenant?.name_ur || ''
  const s = Object.fromEntries((settingsRows ?? []).map((r) => [r.key, r.value ?? '']))
  const num = (v: string | undefined) => (v && v.trim() !== '' ? Number(v) : null)

  const defaults = safeDefaults(name, nameUrdu)

  return {
    name, nameUrdu,
    fullName: s.brand_full_name || defaults.fullName,
    fullNameUrdu: s.brand_full_name_ur || defaults.fullNameUrdu,
    shortCommittee: s.brand_short_committee || defaults.shortCommittee,
    committeeUrdu: s.brand_committee_ur || defaults.committeeUrdu,
    taglineUrdu: s.brand_tagline_ur || defaults.taglineUrdu,

    whatsapp: s.whatsapp_number || '',
    whatsappLink: s.whatsapp_link || '',
    whatsappGroupLink: s.footer_whatsapp_group_link || '',
    facebookLink: s.footer_facebook_link || '',

    jazzcash: s.jazzcash_number || '',
    jazzcashName: s.jazzcash_name || '',
    easypaisa: s.easypaisa_number || '',
    easypaisaName: s.easypaisa_name || '',
    bankName: s.bank_name || '',
    bankAccount: s.bank_account || '',
    bankBranch: s.bank_branch || '',

    district: s.brand_district || '',
    province: s.brand_province || '',
    location: s.brand_location || '',
    established: s.brand_established || '',
    email: s.contact_email || '',
    officeHours: s.office_hours || '',

    lat: num(s.village_lat),
    lng: num(s.village_lng),

    waterSupplyEnabled: tenant?.water_supply_enabled ?? true,
    donorsEnabled: tenant?.donors_enabled ?? true,
  }
}
