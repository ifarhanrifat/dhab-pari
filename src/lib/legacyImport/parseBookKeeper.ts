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

export interface LegacyImportData {
  companyName: string | null
  projects: LegacyProject[]
  donations: LegacyDonation[]
  expenses: LegacyExpense[]
  /** Receipts whose credited party isn't a real donor account (the one
   *  known case: a refund posted against an expense account) — surfaced,
   *  never silently dropped or silently guessed at. */
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

  const receipts = one<{ v_id: number; date: string; vch_no: string; debit: string; credit: string; amount: number; narration: string | null }>(
    `SELECT v_id, date, vch_no, debit, credit, amount, narration FROM vouchers WHERE v_type = 'Receipt' ORDER BY v_id`
  )

  const donations: LegacyDonation[] = []
  const anomalies: LegacyImportData['anomalies'] = []
  for (const r of receipts) {
    const donor = donorAccounts.get(r.credit)
    if (!donor) {
      anomalies.push({ vchNo: r.vch_no, date: r.date, credit: r.credit, debit: r.debit, amount: r.amount })
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
  // The one known real-world anomaly (a refund credited against an expense
  // account, not a donor) — per explicit instruction, imported as-is rather
  // than silently recategorized. Still surfaced in `anomalies` for the
  // preview screen so it's never a surprise.
  for (const a of anomalies) {
    donations.push({
      vchNo: a.vchNo, date: a.date, donorName: a.credit, donorPhone: null, donorAddress: null,
      donorType: 'villager', projectAname: projects.some((p) => p.aname === a.debit) ? a.debit : null,
      amount: a.amount, narration: `(refund/adjustment — originally credited against "${a.credit}")`,
    })
  }

  const payments = one<{ v_id: number; date: string; vch_no: string; debit: string; credit: string; amount: number; narration: string | null }>(
    `SELECT v_id, date, vch_no, debit, credit, amount, narration FROM vouchers WHERE v_type = 'Payment' ORDER BY v_id`
  )
  const expenses: LegacyExpense[] = payments
    .filter((p) => projects.some((proj) => proj.aname === p.credit))
    .map((p) => ({
      vchNo: p.vch_no, date: p.date, category: p.debit,
      projectAname: p.credit, amount: p.amount, narration: p.narration,
    }))

  db.close()

  return { companyName: company[0]?.c_name ?? null, projects, donations, expenses, anomalies }
}
