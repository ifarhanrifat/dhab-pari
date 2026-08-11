// Every value that identifies *this* village, in one place, read from the
// environment with the current values as fallbacks.
//
// Why env and not the site_settings table: page metadata, the PWA manifest and
// the OpenGraph image are all produced at build time, before any database
// connection exists. Anything the browser tab or a shared WhatsApp link shows
// has to come from the environment. Operational text that staff should be able
// to change without a deploy (helpline wording, receipt notes, bank details on
// slips) stays in site_settings, where it already is.
//
// The fallbacks mean this deployment keeps working with no .env changes at all.
// A second village sets the NEXT_PUBLIC_* variables and gets its own identity
// without a single code edit — which is the whole point of moving these out of
// 39 files.
//
// NEXT_PUBLIC_ prefix is required: this module is imported by client components,
// and anything without that prefix is stripped from the browser bundle.
const env = (key: string, fallback: string) =>
  (process.env[key]?.trim() || fallback)

const name = env('NEXT_PUBLIC_VILLAGE_NAME', 'Dhab Pari')
const nameUrdu = env('NEXT_PUBLIC_VILLAGE_NAME_UR', 'ڈھاب پڑی')
const committee = env('NEXT_PUBLIC_COMMITTEE_NAME', 'Water & Welfare Committee')
const committeeUrdu = env('NEXT_PUBLIC_COMMITTEE_NAME_UR', 'واٹر اینڈ ویلفیئر کمیٹی')

export const SITE = {
  name,
  nameUrdu,
  committee,
  committeeUrdu,

  // Derived, so the two never drift apart and no caller has to remember the
  // order. Used in page titles, WhatsApp message headers and document headings.
  fullName: `${name} ${committee}`,
  fullNameUrdu: `${nameUrdu} ${committeeUrdu}`,
  shortCommittee: `${name} Committee`,

  taglineUrdu: env('NEXT_PUBLIC_TAGLINE_UR', `${nameUrdu} ${committeeUrdu} - آپ کی خدمت، ہمارا مشن`),

  whatsapp: env('NEXT_PUBLIC_WHATSAPP', '0333-5008575'),
  whatsappLink: env('NEXT_PUBLIC_WHATSAPP_LINK', 'https://wa.me/923335008575'),
  whatsappGroupLink: env('NEXT_PUBLIC_WHATSAPP_GROUP_LINK', 'https://chat.whatsapp.com/EJicjqKIjUU8qEjKeRzHiR?s=sh&p=a&ilr=4'),
  facebookLink: env('NEXT_PUBLIC_FACEBOOK_LINK', 'https://www.facebook.com/share/1JdVXFHyPz/'),

  jazzcash: env('NEXT_PUBLIC_JAZZCASH', '0300-0000000'),
  jazzcashName: env('NEXT_PUBLIC_JAZZCASH_NAME', `${name} Welfare`),
  easypaisa: env('NEXT_PUBLIC_EASYPAISA', '0345-0000000'),
  easypaisaName: env('NEXT_PUBLIC_EASYPAISA_NAME', 'DP Welfare Committee'),
  bankName: env('NEXT_PUBLIC_BANK_NAME', 'HBL'),
  bankAccount: env('NEXT_PUBLIC_BANK_ACCOUNT', 'PK00 MCBA 0012 3456 7890 12'),
  bankBranch: env('NEXT_PUBLIC_BANK_BRANCH', `${name} Water & Welfare Branch`),

  district: env('NEXT_PUBLIC_DISTRICT', 'Chakwal'),
  province: env('NEXT_PUBLIC_PROVINCE', 'Punjab'),
  location: env('NEXT_PUBLIC_LOCATION', `${name}, Dist. Chakwal, Punjab, Pakistan`),
  established: env('NEXT_PUBLIC_ESTABLISHED', '2018'),
  domain: env('NEXT_PUBLIC_DOMAIN', 'dhabpari.com'),
  email: env('NEXT_PUBLIC_EMAIL', 'info@dhabpari.org'),
  officeHours: env('NEXT_PUBLIC_OFFICE_HOURS', 'Mon-Sat: 9AM-2PM, Fri: 9AM-12PM'),
}

// ── Which parts of the system this deployment runs ───────────────────────
// A village that only wants water billing should not be shown donor pages, and
// a committee that only collects donations has no consumers. Defaults are on,
// so this deployment is unchanged; a new one turns off what it did not buy.
//
// This gates *navigation and pages*, not data access — that stays with the role
// checks and RLS, which are the real boundary. A module switch is a product
// decision; it must never be the only thing standing between a user and
// somebody's money.
const flag = (key: string, fallback: boolean) => {
  const v = process.env[key]?.trim().toLowerCase()
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1' || v === 'yes'
}

export const MODULES = {
  waterSupply: flag('NEXT_PUBLIC_MODULE_WATER', true),
  donors: flag('NEXT_PUBLIC_MODULE_DONORS', true),
  business: flag('NEXT_PUBLIC_MODULE_BUSINESS', false),
}
