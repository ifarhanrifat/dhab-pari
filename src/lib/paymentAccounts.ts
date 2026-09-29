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
  // Real ask, 2026-09-29: every method always showed as a payment option
  // regardless of whether the committee actually wanted to offer it
  // through that channel — a checkbox per method, per system (Settings >
  // Payment Accounts), lets the committee turn one off (e.g. bank-only for
  // water bills) without deleting its account details, which stay saved
  // for whenever it's turned back on. Unset means enabled, matching every
  // method's behavior before this existed.
  enabled: { jazzcash: boolean; easypaisa: boolean; bank: boolean; cash: boolean }
}

const KEYS = [
  'jazzcash_number', 'jazzcash_name', 'easypaisa_number', 'easypaisa_name',
  'bank_name', 'bank_account_title', 'bank_account_number', 'bank_iban',
  'bank_branch', 'bank_branch_code',
  'enable_jazzcash', 'enable_easypaisa', 'enable_bank', 'enable_cash',
] as const

export async function getPaymentAccount(
  supabase: SupabaseClient, system: 'donors_projects' | 'water_supply'
): Promise<PaymentAccount> {
  const prefix = system === 'water_supply' ? 'water_' : 'donor_'
  const { data } = await supabase.from('site_settings').select('key, value')
    .in('key', KEYS.map((k) => `${prefix}${k}`))
  const v = Object.fromEntries((data ?? []).map((r) => [r.key.replace(prefix, ''), r.value ?? '']))
  const isEnabled = (key: string) => v[key] !== 'false'
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
    enabled: {
      jazzcash: isEnabled('enable_jazzcash'),
      easypaisa: isEnabled('enable_easypaisa'),
      bank: isEnabled('enable_bank'),
      cash: isEnabled('enable_cash'),
    },
  }
}
