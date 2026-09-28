// Real gap, 2026-09-28: every password field in this app (admin accept-
// invite, admin/portal reset, admin/portal profile change-password,
// portal signup) said "at least 8 characters" and only checked length
// client-side — but Supabase Auth is actually configured with a much
// stricter policy (confirmed directly from a live rejection: "Password
// should be at least 12 characters... one character of each: lowercase,
// uppercase, 0-9, and a special character"). A password that looked
// perfectly valid by every on-screen hint was silently rejected on
// submit. This is the single source of truth both the live checklist
// component and each form's own client-side guard read from, so the two
// can never drift apart again the way the old copy did from the real
// server-side policy.
export interface PasswordRequirement {
  key: string
  labelEn: string
  labelUr: string
  test: (pw: string) => boolean
}

// Kept outside the character class as its own alternation-free string so
// there's exactly one place that has to agree with Supabase's own set.
const SPECIAL_CHARS = /[!@#$%^&*()_+=[\]{};':"\\|,.<>/?`~-]/

export const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  { key: 'length', labelEn: 'At least 12 characters', labelUr: 'کم از کم 12 حروف', test: (pw) => pw.length >= 12 },
  { key: 'lower', labelEn: 'One lowercase letter (a-z)', labelUr: 'ایک چھوٹا حرف (a-z)', test: (pw) => /[a-z]/.test(pw) },
  { key: 'upper', labelEn: 'One uppercase letter (A-Z)', labelUr: 'ایک بڑا حرف (A-Z)', test: (pw) => /[A-Z]/.test(pw) },
  { key: 'digit', labelEn: 'One number (0-9)', labelUr: 'ایک ہندسہ (0-9)', test: (pw) => /[0-9]/.test(pw) },
  { key: 'special', labelEn: 'One special character (!@#$%...)', labelUr: 'ایک خاص علامت (!@#$% وغیرہ)', test: (pw) => SPECIAL_CHARS.test(pw) },
]

export function passwordMeetsPolicy(password: string): boolean {
  return PASSWORD_REQUIREMENTS.every((r) => r.test(password))
}
