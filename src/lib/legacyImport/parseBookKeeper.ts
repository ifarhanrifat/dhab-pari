// Reads a BookKeeper (Android accounting app) SQLite backup and pulls out
// exactly the shapes Dhab Pari needs — nothing else in that file (bills,
// stock, salary, tax tables...) is relevant, this app never used those
// modules for donor/project bookkeeping.
//
// Server-only (Node) — sql.js's WASM binary is read straight off disk
// rather than trusting bundler path resolution, which is fragile across
// dev vs a production serverless build.
import initSqlJs, { type Database } from 'sql.js'
import { readFileSync } from 'fs'
import path from 'path'

export interface LegacyProject {
  aname: string // BookKeeper account name — the stable external key
}

export interface LegacyDonation {
  vchNo: string
  date: string
  donorName: string
  donorPhone: string | null
  donorAddress: string | null
  donorType: 'villager' | 'overseas'
  projectAname: string | null
  amount: number
  narration: string | null
}

export interface LegacyExpense {
  vchNo: string
  date: string
  category: string
  projectAname: string
  amount: number
  narration: string | null
}

/** A single BookKeeper voucher that really covered several expense
 *  categories in one payment (e.g. a trip that paid Vehicle Rent, an OT
 *  Expenses advance, and a misc cost all at once) — imported as ONE real
 *  voucher with its true per-category breakdown as line items, so it
 *  prints as one itemized Payment Voucher instead of several unrelated-
 *  looking ones under synthetic reference numbers. */
export interface LegacyExpenseSplit {
  vchNo: string
  date: string
  projectAname: string
  amount: number
  narration: string | null
  lines: { category: string; amount: number }[]
}

/** A Receipt voucher where money flowed back INTO an expense account (a
 *  refund of a prior payment, e.g. a hospital returning an unused advance)
 *  — this is a reduction of that expense, not new donor income, and must
 *  never be posted as a donation. */
export interface LegacyExpenseReversal {
  vchNo: string
  date: string
  expenseAccountName: string
  projectAname: string
  amount: number
  narration: string | null
}

export interface LegacyImportData {
  companyName: string | null
  projects: LegacyProject[]
  donations: LegacyDonation[]
  expenses: LegacyExpense[]
  expenseSplits: LegacyExpenseSplit[]
  expenseReversals: LegacyExpenseReversal[]
  /** Receipts whose credited party is neither a real donor account nor a
   *  recognizable expense-refund — surfaced, never silently dropped or
   *  silently guessed at. */
  anomalies: { vchNo: string; date: string; credit: string; debit: string; amount: number }[]
}

// Pakistan-local numbers get the country code; anything already
// international (Dubai, Kuwait, etc. — this committee has real overseas
// donors) is left exactly as entered.
function normalizePhone(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const digits = trimmed.replace(/[^\d+]/g, '')
  if (!digits) return null
  if (digits.startsWith('+')) return digits
  if (digits.startsWith('0')) return '+92' + digits.slice(1)
  if (digits.startsWith('92')) return '+' + digits
  return digits
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

export async function parseBookKeeperDb(fileBuffer: Buffer): Promise<LegacyImportData> {
  const wasmPath = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  const SQL = await initSqlJs({ wasmBinary: toArrayBuffer(readFileSync(wasmPath)) })
  const db: Database = new SQL.Database(new Uint8Array(toArrayBuffer(fileBuffer)))

  const one = <T = unknown>(sql: string): T[] => {
    const res = db.exec(sql)
    if (!res.length) return []
    const [{ columns, values }] = res
    return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))) as T[]
  }

  const company = one<{ c_name: string }>(`SELECT c_name FROM company LIMIT 1`)

  const projects = one<{ aname: string }>(
    `SELECT aname FROM account_detail WHERE a_type = 'Cash-in-hand' ORDER BY date_created, aname`
  ).map((r) => ({ aname: r.aname }))

  const donorAccounts = new Map<string, { phone: string | null; address: string | null; group: string | null }>()
  for (const r of one<{ aname: string; phone: string | null; address: string | null; account_group: string | null }>(
    `SELECT aname, phone, address, account_group FROM account_detail WHERE a_type = 'Sundry Debtors'`
  )) {
    donorAccounts.set(r.aname, { phone: r.phone, address: r.address, group: r.account_group })
  }

  // Expense-account names — used below to recognize a Receipt that's
  // actually a refund flowing back into an expense account, not a donation.
  const expenseAccountNames = new Set(
    one<{ aname: string }>(`SELECT aname FROM account_detail WHERE a_type = 'Direct Expenses'`).map((r) => r.aname)
  )

  const receipts = one<{ v_id: number; date: string; vch_no: string; debit: string; credit: string; amount: number; narration: string | null }>(
    `SELECT v_id, date, vch_no, debit, credit, amount, narration FROM vouchers WHERE v_type = 'Receipt' ORDER BY v_id`
  )

  const donations: LegacyDonation[] = []
  const expenseReversals: LegacyImportData['expenseReversals'] = []
  const anomalies: LegacyImportData['anomalies'] = []
  for (const r of receipts) {
    const donor = donorAccounts.get(r.credit)
    if (!donor) {
      if (expenseAccountNames.has(r.credit)) {
        expenseReversals.push({
          vchNo: r.vch_no, date: r.date, expenseAccountName: r.credit,
          projectAname: r.debit, amount: r.amount, narration: r.narration,
        })
      } else {
        anomalies.push({ vchNo: r.vch_no, date: r.date, credit: r.credit, debit: r.debit, amount: r.amount })
      }
      continue
    }
    donations.push({
      vchNo: r.vch_no,
      date: r.date,
      donorName: r.credit,
      donorPhone: normalizePhone(donor.phone),
      donorAddress: donor.address?.trim() || null,
      donorType: donor.group === 'Overseas Donor' ? 'overseas' : 'villager',
      projectAname: projects.some((p) => p.aname === r.debit) ? r.debit : null,
      amount: r.amount,
      narration: r.narration,
    })
  }
  // `anomalies` (a Receipt credited against neither a real donor nor a
  // known expense account) stays surfaced-only, never guessed into a
  // donation — the one real case seen so far (a hospital refund posted
  // against "OT Expenses") turned out to be exactly this misclassification
  // and is now caught by the expense-account check above instead.

  // BookKeeper's `vouchers` table only ever stores ONE debit/credit pair per
  // voucher — for a genuinely compound payment (a single trip that covered
  // Doctor Fee + Medicine + Vehicle Rent, say) it collapses every real
  // category into the FIRST one and just sums the total amount there. The
  // true per-category split lives in `vouchers_all` (same v_id, one row per
  // real leg) — BookKeeper's own per-account reports read from there, which
  // is why a category like "Photocopy Expense" can show real entries on
  // BookKeeper's screen while being entirely invisible in `vouchers`.
  // Reading `vouchers_all` here (not `vouchers.debit`/`vouchers.amount`) is
  // the only way to get category totals that actually match BookKeeper's
  // own reports.
  const payments = one<{ v_id: number; date: string; vch_no: string; credit: string; narration: string | null }>(
    `SELECT v_id, date, vch_no, credit, narration FROM vouchers WHERE v_type = 'Payment' ORDER BY v_id`
  )
  const splitLines = one<{ v_id: number; debit: string; amount: number }>(
    `SELECT v_id, debit, amount FROM vouchers_all ORDER BY v_id, rowid`
  )
  const linesByVoucher = new Map<number, { debit: string; amount: number }[]>()
  for (const l of splitLines) {
    if (!l.amount || l.amount <= 0) continue // e.g. a leftover "Round off" placeholder line of 0.00
    if (!linesByVoucher.has(l.v_id)) linesByVoucher.set(l.v_id, [])
    linesByVoucher.get(l.v_id)!.push({ debit: l.debit, amount: l.amount })
  }

  const expenses: LegacyExpense[] = []
  const expenseSplits: LegacyExpenseSplit[] = []
  for (const p of payments) {
    if (!projects.some((proj) => proj.aname === p.credit)) continue
    const lines = linesByVoucher.get(p.v_id) ?? []
    if (lines.length > 1) {
      expenseSplits.push({
        vchNo: p.vch_no, date: p.date, projectAname: p.credit,
        amount: lines.reduce((s, l) => s + l.amount, 0), narration: p.narration,
        lines: lines.map((l) => ({ category: l.debit, amount: l.amount })),
      })
    } else if (lines.length === 1) {
      expenses.push({
        vchNo: p.vch_no, date: p.date, category: lines[0].debit,
        projectAname: p.credit, amount: lines[0].amount, narration: p.narration,
      })
    }
  }

  db.close()

  return { companyName: company[0]?.c_name ?? null, projects, donations, expenses, expenseSplits, expenseReversals, anomalies }
}
