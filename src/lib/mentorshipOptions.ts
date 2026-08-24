// Shared option lists for the student mentorship/freelancing profile fields
// (migration 322) — one place so signup and the profile-edit page can't
// drift apart. Values are stored as plain varchar (not CHECK-constrained for
// profession — see the migration comment), same reasoning as
// volunteers.help_types: the list will grow, and that should be a code
// change, not a migration.

export const PROFESSION_OPTIONS = [
  'student', 'freelancer', 'farmer', 'laborer', 'government_employee',
  'private_employee', 'business_owner', 'teacher', 'unemployed', 'other',
] as const

export const PROFESSION_LABELS: Record<string, { en: string; ur: string }> = {
  student: { en: 'Student', ur: 'طالب علم' },
  freelancer: { en: 'Freelancer / self-employed', ur: 'فری لانسر / خود روزگار' },
  farmer: { en: 'Farmer', ur: 'کسان' },
  laborer: { en: 'Laborer', ur: 'مزدور' },
  government_employee: { en: 'Government employee', ur: 'سرکاری ملازم' },
  private_employee: { en: 'Private employee', ur: 'نجی ملازم' },
  business_owner: { en: 'Business owner', ur: 'کاروباری' },
  teacher: { en: 'Teacher', ur: 'استاد' },
  unemployed: { en: 'Not currently working', ur: 'فی الحال بے روزگار' },
  other: { en: 'Other', ur: 'دیگر' },
}

// intermediate/diploma/bachelors/masters match wazifa_students.level
// (migration 212) — same terms, so a Wazifa cross-link reads consistently.
export const EDUCATION_LEVEL_OPTIONS = [
  'below_matric', 'matric', 'intermediate', 'diploma', 'bachelors', 'masters', 'phd', 'other',
] as const

export const EDUCATION_LEVEL_LABELS: Record<string, { en: string; ur: string }> = {
  below_matric: { en: 'Below Matric', ur: 'میٹرک سے کم' },
  matric: { en: 'Matric', ur: 'میٹرک' },
  intermediate: { en: 'Intermediate', ur: 'انٹرمیڈیٹ' },
  diploma: { en: 'Diploma', ur: 'ڈپلومہ' },
  bachelors: { en: "Bachelor's", ur: 'بیچلرز' },
  masters: { en: "Master's", ur: 'ماسٹرز' },
  phd: { en: 'PhD', ur: 'پی ایچ ڈی' },
  other: { en: 'Other', ur: 'دیگر' },
}
