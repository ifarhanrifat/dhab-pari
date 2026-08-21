// Translates the `particular` column of ledger_entries (and similar
// system-generated free-text like bill/voucher descriptions built the same
// way) for display in Urdu mode.
//
// This text is written once, in English, by SQL triggers at transaction
// time (trg_bill_ledger, trg_payment_ledger, post_voucher_ledger_legs,
// etc.) — there's no Urdu column, and retroactively rewriting historical
// financial records to "translate" them would be the wrong fix even if it
// weren't risky (an accounting ledger is a factual record of what actually
// happened, not UI copy). Genuinely free-text particulars — a voucher's own
// description, a manual journal entry — are the accountant's own words and
// can't be machine-translated reliably; those fall through unchanged, the
// same as English mode already shows today.
//
// What this recognizes is the small set of fixed, system-generated
// phrasings (bills, payments, security deposits, discounts, donations,
// inventory, project transfers) that make up the great majority of what
// actually shows on a real account statement, and swaps just those fixed
// fragments — bill numbers, names, amounts, dates, and any trailing
// free-text note are left exactly as written.

type TFn = (key: string, fallback?: string) => string

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthKey = (i: number) => `w.month${i}`

const METHOD_KEY: Record<string, string> = {
  cash: 'billing.methodCash', bank: 'billing.methodBank', jazzcash: 'billing.methodJazzcash', easypaisa: 'billing.methodEasypaisa',
}
const method = (t: TFn, m: string) => t(METHOD_KEY[m] ?? '', m)

export function translateParticular(text: string | null | undefined, t: TFn, isUrdu: boolean): string {
  if (!text || !isUrdu) return text ?? ''
  let out = text

  // Water Bill #WB-00026 - April 2024
  out = out.replace(/^Water Bill #(\S+) - (\w+) (\d{4})$/, (_m, no: string, mon: string, yr: string) => {
    const mi = MONTHS.indexOf(mon)
    const label = mi > 0 ? t(monthKey(mi), mon) : mon
    return `${t('lp.waterBillHash', 'Water Bill #')}${no} - ${label} ${yr}`
  })

  // Discount — Bill #WB-00045
  out = out.replace(/^Discount — Bill #(\S+)$/, (_m, no: string) =>
    `${t('billing.discountLabel', 'Discount')} — ${t('tx.billHash', 'Bill #')}${no}`)

  // Security deposit — Name — Bill WB-00049
  out = out.replace(/^Security deposit — (.+) — Bill (\S+)$/, (_m, name: string, no: string) =>
    `${t('lp.securityDeposit', 'Security deposit')} — ${name} — ${t('tx.billFallback', 'Bill')} ${no}`)

  // Payment received (cash) [— Bill #X — Bill Paid in Full | Partial Payment — Rs. N remaining] [— received by NAME] [— note]
  out = out.replace(/^Payment received \((\w+)\)/, (_m, meth: string) =>
    `${t('tx.paymentReceived', 'Payment received')} (${method(t, meth)})`)
  out = out.replace(/— Bill Paid in Full/g, `— ${t('lp.billPaidInFull', 'Bill Paid in Full')}`)
  out = out.replace(/— Partial Payment — /g, `— ${t('lp.partialPayment', 'Partial Payment')} — `)
  out = out.replace(/ remaining(?=$|\s*—)/g, ` ${t('kf.remaining', 'remaining')}`)
  out = out.replace(/— received by /g, `— ${t('lp.receivedBy', 'received by')} `)

  // Advance / Prepayment received (cash) — Advance / Prepayment
  out = out.replace(/^Advance \/ Prepayment received \((\w+)\)/, (_m, meth: string) =>
    `${t('lp.advancePrepaymentReceived', 'Advance / Prepayment received')} (${method(t, meth)})`)
  out = out.replace(/— Advance \/ Prepayment$/, `— ${t('f.advancePrepayment', 'Advance / Prepayment')}`)

  // Donation - Project Title / Donation / Donation (KAFALAT)
  out = out.replace(/^Donation(?=[ (]|$)/, t('tx.donationFallback', 'Donation'))

  // Inventory purchase/restored/issued — item x{n} unit
  out = out.replace(/^Inventory purchase — /, `${t('tx.inventoryPurchase', 'Inventory purchase')} — `)
  out = out.replace(/^Inventory restored — /, `${t('lp.inventoryRestored', 'Inventory restored')} — `)
  out = out.replace(/^Inventory issued — /, `${t('lp.inventoryIssued', 'Inventory issued')} — `)

  // Fund transfer between projects — ...
  out = out.replace(/^Fund transfer between projects — /, `${t('lp.fundTransferBetweenProjects', 'Fund transfer between projects')} — `)

  return out
}
