// One place that knows what "send it to" actually means for a given
// system — separate real accounts for Donor & Projects vs Water Supply
// (migration 253), read from site_settings so the committee can update
// them without a deploy. SITE constants remain the fallback so nothing
// breaks if a key is ever missing.
import { SupabaseClient } from '@supabase/supabase-js'
import { SITE } from '@/lib/constants'

export interface PaymentAccount {
  jazzcashNumber: string
  jazzcashName: string
  easypaisaNumber: string
  easypaisaName: string
  bankName: string
  bankAccountTitle: string
  bankAccountNumber: string
  bankIban: string
  bankBranch: string
  bankBranchCode: string
}

const KEYS = [
  'jazzcash_number', 'jazzcash_name', 'easypaisa_number', 'easypaisa_name',
  'bank_name', 'bank_account_title', 'bank_account_number', 'bank_iban',
  'bank_branch', 'bank_branch_code',
] as const

export async function getPaymentAccount(
  supabase: SupabaseClient, system: 'donors_projects' | 'water_supply'
): Promise<PaymentAccount> {
  const prefix = system === 'water_supply' ? 'water_' : 'donor_'
  const { data } = await supabase.from('site_settings').select('key, value')
    .in('key', KEYS.map((k) => `${prefix}${k}`))
  const v = Object.fromEntries((data ?? []).map((r) => [r.key.replace(prefix, ''), r.value ?? '']))
  return {
    jazzcashNumber: v.jazzcash_number || SITE.jazzcash,
    jazzcashName: v.jazzcash_name || SITE.jazzcashName,
    easypaisaNumber: v.easypaisa_number || SITE.easypaisa,
    easypaisaName: v.easypaisa_name || SITE.easypaisaName,
    bankName: v.bank_name || SITE.bankName,
    bankAccountTitle: v.bank_account_title || SITE.fullName,
    bankAccountNumber: v.bank_account_number || '',
    bankIban: v.bank_iban || SITE.bankAccount,
    bankBranch: v.bank_branch || SITE.bankBranch,
    bankBranchCode: v.bank_branch_code || '',
  }
}
