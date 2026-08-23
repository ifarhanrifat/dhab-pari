// A committee note's "Related Link" picker offers three sources (see
// migration 306): a real project (its own foreign key, resolved from the
// live record), one of these fixed site features, or a fully custom URL.
// This list is what makes "we're launching Kafalat, link the announcement to
// it" a one-line addition here instead of a migration + new column + new
// admin UI branch every time a module launches — the same reasoning
// post_categories (migration 181) applies to article categories.
//
// All public pages (no login required) per explicit decision: a shared
// announcement has to work for whoever clicks it, not only members already
// logged into the portal — they can always log in from there if they want
// to act. Esal-e-Sawab and the four modules on /welfare that don't have
// their own page get an in-page anchor instead of a separate route.
export interface SiteFeatureLink {
  key: string
  labelEn: string
  labelUr: string
  path: string
}

export const SITE_FEATURE_LINKS: SiteFeatureLink[] = [
  { key: 'water', labelEn: 'Water Bill', labelUr: 'واٹر بل', path: '/water' },
  { key: 'blood', labelEn: 'Blood Donation', labelUr: 'خون کا عطیہ', path: '/blood' },
  { key: 'projects', labelEn: 'All Projects', labelUr: 'تمام منصوبے', path: '/projects' },
  { key: 'jobs', labelEn: 'Job Listings', labelUr: 'ملازمتوں کے اشتہار', path: '/jobs' },
  { key: 'accounts', labelEn: 'Accounts', labelUr: 'اکاؤنٹس', path: '/accounts' },
  { key: 'donate', labelEn: 'Donate', labelUr: 'عطیہ دیں', path: '/donate' },
  { key: 'welfare', labelEn: 'Welfare & Education', labelUr: 'فلاح و تعلیم', path: '/welfare' },
  { key: 'zakat', labelEn: 'Zakat & Ushr', labelUr: 'زکوٰۃ و عشر', path: '/welfare#zakat' },
  { key: 'kafalat', labelEn: 'Kafalat', labelUr: 'کفالت', path: '/welfare#kafalat' },
  { key: 'wazifa', labelEn: 'Taleemi Wazifa', labelUr: 'تعلیمی وظیفہ', path: '/welfare#wazifa' },
  { key: 'esal', labelEn: 'Esal-e-Sawab', labelUr: 'ایصال ثواب', path: '/sadqa-jariya' },
  { key: 'news', labelEn: 'News', labelUr: 'خبریں', path: '/news' },
  { key: 'videos', labelEn: 'Videos', labelUr: 'ویڈیوز', path: '/videos' },
  { key: 'gallery', labelEn: 'Gallery', labelUr: 'گیلری', path: '/gallery' },
  { key: 'about', labelEn: 'Committee', labelUr: 'کمیٹی', path: '/about' },
  { key: 'volunteer', labelEn: 'Volunteer', labelUr: 'رضاکار', path: '/volunteer' },
  { key: 'suggestions', labelEn: 'Suggestions', labelUr: 'تجاویز', path: '/suggestions' },
  { key: 'complaints', labelEn: 'Complaints', labelUr: 'شکایات', path: '/complaints' },
]
