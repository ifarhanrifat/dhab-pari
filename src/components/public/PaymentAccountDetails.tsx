'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { getPaymentAccount, type PaymentAccount } from '@/lib/paymentAccounts'

/**
 * "Send it yourself, any of these ways" — but with the real number right
 * there to copy, instead of a donor having to note it down from a screen
 * and retype it into JazzCash/Easypaisa/their banking app by hand.
 *
 * Two completely separate account sets exist (migration 253) — donor/
 * project giving and water-bill payments never share a number — so this
 * always takes an explicit `system` rather than guessing from context,
 * and only ever shows that one system's accounts.
 */

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null
  const copy = async () => {
    await navigator.clipboard.writeText(value.replace(/\s+/g, ''))
    toast.success('Copied')
  }
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-wide text-dp-on-surface-variant">{label}</p>
        <p className="font-mono text-[13.5px] font-semibold text-dp-on-surface truncate">{value}</p>
      </div>
      <button onClick={copy} title="Copy" className="shrink-0 p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer">
        <Copy size={14} />
      </button>
    </div>
  )
}

export function PaymentAccountDetails({
  system, method, international = false,
}: { system: 'donors_projects' | 'water_supply'; method: string; international?: boolean }) {
  const [account, setAccount] = useState<PaymentAccount | null>(null)

  useEffect(() => {
    getPaymentAccount(createClient(), system).then(setAccount)
  }, [system])

  if (!account || method === 'cash') return null
  // International senders can only use bank/IBAN — JazzCash and Easypaisa
  // are domestic mobile-wallet rails and don't accept transfers from abroad.
  const showBank = method === 'bank' || international

  return (
    <div className="bg-dp-surface-container-low rounded-lg px-4 py-2.5 mt-2 divide-y divide-dp-outline-variant/60">
      {method === 'jazzcash' && !international && (
        <>
          <Field label="JazzCash Number" value={account.jazzcashNumber} />
          <Field label="Account Title" value={account.jazzcashName} />
        </>
      )}
      {method === 'easypaisa' && !international && (
        <>
          <Field label="Easypaisa Number" value={account.easypaisaNumber} />
          <Field label="Account Title" value={account.easypaisaName} />
        </>
      )}
      {showBank && (
        <>
          <Field label="Bank" value={account.bankName} />
          <Field label="Account Title" value={account.bankAccountTitle} />
          <Field label="Account Number" value={account.bankAccountNumber} />
          <Field label={international ? 'IBAN (for international transfer)' : 'IBAN'} value={account.bankIban} />
          <Field label="Branch" value={account.bankBranch} />
          <Field label="Branch Code" value={account.bankBranchCode} />
        </>
      )}
    </div>
  )
}
