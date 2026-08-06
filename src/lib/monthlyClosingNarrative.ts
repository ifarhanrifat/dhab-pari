// Builds the Urdu monthly closing narrative for Running Capital's report
// archive. Always Urdu, regardless of the display_language setting — this is
// a dedicated Urdu report type the accountant presents to management/committee
// members, not a document that should flip to English (unlike bills/receipts/
// reports elsewhere, which follow src/lib/docTranslations.ts's dt()).
//
// Written as real explanatory prose — each section opens with a plain-language
// sentence, not a bare list of figures — because this is meant to be read aloud
// to people who don't work with the ledger day to day. Water Supply and Donors
// & Projects get genuinely different narratives; donors have no billing/
// receivable/connections concept.
//
// Returns { before, after } instead of one string — the expense detail is
// rendered as a real table by the page (a wall of comma-joined line items
// read as unprofessional), sitting between these two halves of the prose.

export interface NonPayerEntry { name: string; sector: string; reason: string }
export interface NonPayerDueToComplaint {
  consumer_id: string; name: string; sector: string | null
  complaint_since: string; unpaid_since: string | null; outstanding: number
}
export interface NonPayerOpinion { consumer_id: string; opinion: string }
export interface PendingBillConsumer { consumer_name: string; sector: string; amount: number }
export interface TwoMonthDefaulter { consumer_name: string; sector: string | null; outstanding: number; flagged_since: string }
export interface ExpenseLine { description: string; amount: number; approved_by: string[]; auto_posted: boolean }
export interface NewConnectionDetail { consumer_name: string; incharge_name: string | null; activated: boolean }
export interface ComplaintEntry {
  name: string | null; sector: string | null; text: string
  status: 'open' | 'awaiting_verification' | 'verified'
  incharge_name: string | null; resolved_by_name: string | null; resolved_at: string | null
}
export interface TaskProgressEntry { request_number: string; consumer_name: string; sector: string | null; incharge_name: string | null; task_status: string }
export interface DonorBreakdown { by_project: { title: string; total: number }[]; by_type: { type: string; total: number }[] }
export interface ProjectProgressEntry { title: string; status: string; progress_percent: number | null; budget_pkr: number | null; spent_pkr: number | null }
export interface CashCategoryAmount { category: string; amount: number }
export interface ReconciliationChange { summary: string; actor_name: string | null; action: string; performed_at: string }

export interface ClosingReportData {
  report_month: number
  report_year: number
  new_connections: number | null
  disconnections: number | null
  new_connections_detail: NewConnectionDetail[]
  prev_month_cash: number
  this_month_cash: number
  cash_in: number
  cash_out: number
  cash_in_breakdown: CashCategoryAmount[]
  cash_out_breakdown: CashCategoryAmount[]
  opening_balance_expected: number | null
  opening_balance_actual: number
  opening_balance_mismatch: boolean
  reconciliation_changes: ReconciliationChange[]
  reconciliation_remarks: string
  prev_month_billing: number
  prev_month_receivable: number
  this_month_billed: number | null
  this_month_discount: number | null
  discount_by_consumer: { consumer_name: string; amount: number }[]
  this_month_recovery: number
  total_receivable: number
  total_payable: number
  total_pending_bills: number
  pending_by_sector: Record<string, number>
  pending_bills_by_consumer: PendingBillConsumer[]
  two_month_defaulters: TwoMonthDefaulter[]
  billing_income: number | null
  sale_income: number | null
  total_expenses: number
  expense_lines: ExpenseLine[]
  net_surplus: number
  non_payers: NonPayerEntry[]
  non_payers_due_to_complaint: NonPayerDueToComplaint[]
  non_payer_opinions: NonPayerOpinion[]
  complaints_this_month: ComplaintEntry[]
  task_progress: TaskProgressEntry[]
  donor_breakdown: DonorBreakdown
  project_progress: ProjectProgressEntry[]
}

export interface NarrativeParts { before: string; after: string }

const urduMonths = [
  'جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون',
  'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر',
]

const taskStatusUr: Record<string, string> = {
  unassigned: 'غیر تفویض شدہ', assigned: 'تفویض شدہ', in_progress: 'زیر تکمیل', done: 'مکمل',
}
const projectStatusUr: Record<string, string> = {
  ongoing: 'جاری', completed: 'مکمل', upcoming: 'آئندہ',
}
const auditActionUr: Record<string, string> = { update: 'ترمیم', delete: 'حذف' }
const complaintStatusUr: Record<ComplaintEntry['status'], string> = {
  open: 'زیر التوا', awaiting_verification: 'حل کیا گیا، تصدیق باقی', verified: 'مکمل طور پر حل شدہ',
}
function complaintStatusClause(c: ComplaintEntry): string {
  if (c.status === 'verified') return `حالت: ${complaintStatusUr[c.status]}${c.resolved_by_name ? `، حل کیا: ${c.resolved_by_name}` : ''}`
  if (c.status === 'awaiting_verification') return `حالت: ${complaintStatusUr[c.status]}${c.incharge_name ? `، انچارج: ${c.incharge_name}` : ''}`
  return `حالت: ${complaintStatusUr[c.status]}${c.incharge_name ? `، انچارج: ${c.incharge_name}` : ' — تاحال کسی کو تفویض نہیں'}`
}

export function urduDate(d: string | null): string {
  if (!d) return 'نامعلوم'
  const dt = new Date(d)
  return `${dt.getDate()} ${urduMonths[dt.getMonth()]} ${dt.getFullYear()}`
}

// Cash category labels are generated server-side in plain English (they're
// structural, not user-typed) — translate them here before they go into Urdu
// prose. Falls back to the raw label for anything unmapped (e.g. a fallback
// voucher_type the SQL side didn't have a named case for) rather than
// silently dropping it.
const cashCategoryUr: Record<string, string> = {
  'Bill Collections': 'صارفین کے بلوں کی وصولی',
  'Advance / Prepayment Received': 'ایڈوانس / پیشگی ادائیگی کی وصولی',
  'Other Income': 'دیگر آمدنی',
  'Security Deposits Received': 'سیکیورٹی ڈیپازٹ کی وصولی',
  'Security Deposit Refund Received': 'سیکیورٹی ڈیپازٹ کی واپسی وصول',
  'Advance Settlement Refund': 'ایڈوانس تصفیہ سے وصولی',
  'Internal Transfer (Bank/Cash)': 'اندرونی منتقلی (بینک/نقد)',
  'Internal Transfer (Cash Withdrawal)': 'اندرونی منتقلی (نقد نکاسی)',
  'Internal Transfer (Cash Deposit)': 'اندرونی منتقلی (نقد جمع)',
  'Donations Received': 'عطیات کی وصولی',
  'Collector Settlement': 'کلکٹر تصفیہ',
  'Manual Entry': 'دستی اندراج',
  'Expenses Paid': 'اخراجات کی ادائیگی',
  'Advance Paid to Worker/Contractor': 'کارکن/ٹھیکیدار کو ایڈوانس ادائیگی',
  'Expenses Paid (Advance Settlement)': 'اخراجات کی ادائیگی (ایڈوانس تصفیہ)',
  'Security Deposit Refunded': 'سیکیورٹی ڈیپازٹ کی واپسی',
  Other: 'دیگر',
}
function catUr(category: string): string {
  return cashCategoryUr[category] ?? category
}

// Expenses already get their own dedicated table right after this narrative
// section — repeating "Expenses Paid: Rs. X" here as well just restates the
// same figure a second time with no new information. Only cash-out categories
// beyond expenses (advances, refunds, internal transfers) are worth calling
// out in prose; if that's everything, the paragraph is skipped entirely.
export const expenseCashOutCategories = new Set(['Expenses Paid', 'Expenses Paid (Advance Settlement)'])

function fmt(n: number | null | undefined) {
  return Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function prevMonthYear(month: number, year: number): [number, number] {
  return month === 1 ? [12, year - 1] : [month - 1, year]
}

function listAmounts(items: CashCategoryAmount[]): string {
  return items.map((c) => `${catUr(c.category)}: روپے ${fmt(c.amount)}`).join('، ')
}

function openingBalanceParagraph(r: ClosingReportData, prevMonthName: string, prevYear: number): string {
  if (!r.opening_balance_mismatch) {
    return `اس مہینے کا آغاز روپے ${fmt(r.opening_balance_actual)} کی نقدی سے ہوا، جو پچھلی رپورٹ (${prevMonthName} ${prevYear}) کی اختتامی رقم سے مکمل مطابقت رکھتی ہے۔`
  }
  const diff = r.opening_balance_actual - (r.opening_balance_expected ?? 0)
  let p = `توجہ طلب: اس مہینے کی ابتدائی رقم روپے ${fmt(r.opening_balance_actual)} ہے، جبکہ پچھلی رپورٹ (${prevMonthName} ${prevYear}) کی اختتامی رقم روپے ${fmt(r.opening_balance_expected)} تھی — یعنی روپے ${fmt(Math.abs(diff))} کا فرق (${diff > 0 ? 'اضافہ' : 'کمی'})۔`
  if (r.reconciliation_changes.length > 0) {
    const list = r.reconciliation_changes.map((c) => `${c.summary} (${auditActionUr[c.action] ?? c.action}${c.actor_name ? `، بذریعہ ${c.actor_name}` : ''})`).join('؛ ')
    p += ` اس فرق کی وجہ پچھلے مہینے سے متعلقہ درج ذیل تبدیلیاں ہیں جو رپورٹ کے بعد کی گئیں: ${list}۔`
  } else {
    p += ' اس فرق کی کوئی خودکار وجہ ریکارڈ میں نہیں ملی — براہ کرم نیچے وضاحت درج کریں۔'
  }
  if (r.reconciliation_remarks.trim()) {
    p += ` محاسب کی وضاحت: ${r.reconciliation_remarks.trim()}۔`
  }
  return p
}

// "If every pending receivable were collected and every payable settled, this
// is what we'd actually be left with" — the same net-realizable figure shown
// on the live dashboard, now explained in words for the committee.
function netPositionParagraph(r: ClosingReportData): string {
  const net = Number(r.this_month_cash) + Number(r.total_receivable) - Number(r.total_payable)
  return `اگر تمام زیر التوا وصولیاں (روپے ${fmt(r.total_receivable)}) وصول ہو جائیں اور تمام واجب الادا رقم (روپے ${fmt(r.total_payable)}) ادا کر دی جائے، تو موجودہ نقدی کے ساتھ ملا کر کمیٹی کے پاس کل روپے ${fmt(net)} کی رقم بنے گی۔`
}

export function buildClosingNarrative(r: ClosingReportData, systemLabelUr: string): NarrativeParts {
  const monthName = urduMonths[r.report_month - 1]
  const [prevMonth, prevYear] = prevMonthYear(r.report_month, r.report_year)
  const prevMonthName = urduMonths[prevMonth - 1]

  const before: string[] = []
  const after: string[] = []

  before.push(`معزز مینجمنٹ اور ${systemLabelUr} کمیٹی ممبران، السلام علیکم۔ یہ ${monthName} ${r.report_year} کی ماہانہ اختتامی مالی رپورٹ ہے، جس میں اس مہینے کی مکمل نقدی صورتحال، آمدنی، اخراجات اور پیش رفت پیش کی جا رہی ہے۔`)

  before.push(openingBalanceParagraph(r, prevMonthName, prevYear))

  if (r.cash_in_breakdown.length > 0) {
    before.push(`اس مہینے کے دوران درج ذیل مدات سے نقدی وصول ہوئی: ${listAmounts(r.cash_in_breakdown)}۔ اس طرح مجموعی طور پر روپے ${fmt(r.cash_in)} کی نقدی موصول ہوئی۔`)
  }
  const nonExpenseCashOut = r.cash_out_breakdown.filter((c) => !expenseCashOutCategories.has(c.category))
  if (nonExpenseCashOut.length > 0) {
    before.push(`اخراجات کے علاوہ، اس مہینے درج ذیل مدات میں بھی نقدی ادا کی گئی: ${listAmounts(nonExpenseCashOut)}۔ اخراجات سمیت اس مہینے کی مجموعی نقد ادائیگی روپے ${fmt(r.cash_out)} رہی۔`)
  }

  if (r.new_connections_detail.length > 0) {
    const sentences = r.new_connections_detail.map((c) => {
      const inchargeClause = c.incharge_name ? `جس کی تنصیب کا انچارج ${c.incharge_name} تھا` : 'جس کا انچارج تاحال متعین نہیں'
      const statusClause = c.activated ? 'اکاؤنٹ اب فعال ہو چکا ہے' : 'اکاؤنٹ ابھی زیر تکمیل ہے'
      return `${c.consumer_name} کا نیا کنکشن نصب کیا گیا، ${inchargeClause}، اور ${statusClause}`
    })
    before.push(`اس مہینے مجموعی طور پر ${r.new_connections_detail.length} نئے کنکشن لگائے گئے: ${sentences.join('؛ ')}۔${r.disconnections ? ` اس کے ساتھ ساتھ ${r.disconnections} کنکشن منقطع بھی کیے گئے۔` : ''}`)
  } else if (r.disconnections) {
    before.push(`اس مہینے کوئی نیا کنکشن نصب نہیں کیا گیا، البتہ ${r.disconnections} کنکشن منقطع کیے گئے۔`)
  }

  if (r.complaints_this_month.length > 0) {
    const list = r.complaints_this_month.map((c) => `${c.name ?? 'نامعلوم'} (سیکٹر ${c.sector ?? '—'}) کی جانب سے: ${c.text} (${complaintStatusClause(c)})`).join('؛ ')
    before.push(`اس مہینے کمیٹی کو ${r.complaints_this_month.length} شکایات موصول ہوئیں: ${list}۔`)
  }
  if (r.non_payers_due_to_complaint.length > 0) {
    before.push(`قابل ذکر بات یہ ہے کہ ${r.non_payers_due_to_complaint.length} صارفین کی شکایت زیرِ التوا ہونے کی بنا پر انہوں نے بل ادا نہیں کیا — تفصیل، بشمول کمیٹی کی رائے، ذیل کے جدول میں دی گئی ہے۔`)
  }
  if (r.two_month_defaulters.length > 0) {
    before.push(`${r.two_month_defaulters.length} صارفین مسلسل 2 مہینے سے بل ادا نہیں کر رہے — مکمل فہرست ذیل کے جدول میں دی گئی ہے۔`)
  }

  let billingPara = `اب بلنگ کی صورتحال ملاحظہ کریں: اس مہینے کل روپے ${fmt(r.this_month_billed)} کی بلنگ کی گئی`
  if (r.this_month_discount) billingPara += `، جس میں سے روپے ${fmt(r.this_month_discount)} کی رعایت دی گئی`
  billingPara += `، اور خالص بلنگ آمدنی روپے ${fmt(r.billing_income)} رہی۔`
  before.push(billingPara)
  if (r.discount_by_consumer.length > 0) {
    before.push(`رعایت پانے والے صارفین کی مکمل فہرست ذیل کے جدول میں دی گئی ہے۔`)
  }
  before.push(`پچھلے مہینے (${prevMonthName} ${prevYear}) کل روپے ${fmt(r.prev_month_billing)} کی بلنگ ہوئی تھی، جبکہ اس مہینے روپے ${fmt(r.this_month_recovery)} کی وصولی کی گئی۔`)
  if (r.total_pending_bills > 0) {
    before.push(`آج تک کمیٹی کے ذمے روپے ${fmt(r.total_pending_bills)} کے بل زیر التوا ہیں — سیکٹر وار مکمل تفصیل ذیل کے جدول میں دی گئی ہے۔`)
  }
  before.push(netPositionParagraph(r))

  before.push(`اس مہینے کے اخراجات کی مکمل تفصیل ذیل کے جدول میں دی گئی ہے، جن کا مجموعہ روپے ${fmt(r.total_expenses)} رہا۔`)

  after.push(`آمدنی اور اخراجات کا موازنہ کرنے پر اس مہینے کا خالص ${r.net_surplus >= 0 ? 'فاضل' : 'خسارہ'} روپے ${fmt(Math.abs(r.net_surplus))} بنتا ہے۔`)

  if (r.task_progress.length > 0) {
    const list = r.task_progress.map((t) => `${t.consumer_name} (درخواست ${t.request_number}${t.sector ? `، سیکٹر ${t.sector}` : ''}) — انچارج ${t.incharge_name ?? 'تاحال متعین نہیں'}، موجودہ حالت: ${taskStatusUr[t.task_status] ?? t.task_status}`).join('؛ ')
    after.push(`نئی تنصیبات پر پیش رفت کی تفصیل: ${list}۔`)
  }

  after.push(`آخر میں، اس مہینے کے اختتام پر کمیٹی کے پاس کل روپے ${fmt(r.this_month_cash)} کی نقدی موجود ہے، جو اگلے مہینے کی ابتدائی رقم کے طور پر آگے لے جائی جائے گی۔`)

  return { before: before.join('\n\n'), after: after.join('\n\n') }
}

export function buildDonorClosingNarrative(r: ClosingReportData): NarrativeParts {
  const monthName = urduMonths[r.report_month - 1]
  const [prevMonth, prevYear] = prevMonthYear(r.report_month, r.report_year)
  const prevMonthName = urduMonths[prevMonth - 1]

  const before: string[] = []
  const after: string[] = []

  before.push(`معزز مینجمنٹ اور ڈونرز اینڈ پراجیکٹس کمیٹی ممبران، السلام علیکم۔ یہ ${monthName} ${r.report_year} کی ماہانہ اختتامی مالی رپورٹ ہے۔`)

  before.push(openingBalanceParagraph(r, prevMonthName, prevYear))

  if (r.cash_in_breakdown.length > 0) {
    before.push(`اس مہینے درج ذیل مدات سے نقدی وصول ہوئی: ${listAmounts(r.cash_in_breakdown)}۔ مجموعی وصولی روپے ${fmt(r.cash_in)} رہی۔`)
  }
  const nonExpenseCashOut = r.cash_out_breakdown.filter((c) => !expenseCashOutCategories.has(c.category))
  if (nonExpenseCashOut.length > 0) {
    before.push(`اخراجات کے علاوہ، اس مہینے درج ذیل مدات میں بھی نقدی ادا کی گئی: ${listAmounts(nonExpenseCashOut)}۔ اخراجات سمیت مجموعی نقد ادائیگی روپے ${fmt(r.cash_out)} رہی۔`)
  }

  before.push(`اس مہینے کل روپے ${fmt(r.billing_income)} کے عطیات موصول ہوئے، جبکہ پچھلے مہینے (${prevMonthName} ${prevYear}) یہ رقم روپے ${fmt(r.prev_month_billing)} تھی۔`)
  if (r.donor_breakdown.by_project.length > 0) {
    before.push(`منصوبہ جات کے لحاظ سے عطیات کی تفصیل: ${r.donor_breakdown.by_project.map((p) => `${p.title} — روپے ${fmt(p.total)}`).join('، ')}۔`)
  }
  if (r.donor_breakdown.by_type.length > 0) {
    const typeLabel: Record<string, string> = { villager: 'مقامی', overseas: 'بیرون ملک', unspecified: 'غیر متعین' }
    before.push(`عطیہ دہندگان کی قسم کے لحاظ سے: ${r.donor_breakdown.by_type.map((t) => `${typeLabel[t.type] ?? t.type} — روپے ${fmt(t.total)}`).join('، ')}۔`)
  }

  if (r.complaints_this_month.length > 0) {
    const list = r.complaints_this_month.map((c) => `${c.name ?? 'نامعلوم'} (سیکٹر ${c.sector ?? '—'}) کی جانب سے: ${c.text} (${complaintStatusClause(c)})`).join('؛ ')
    before.push(`اس مہینے ${r.complaints_this_month.length} شکایات موصول ہوئیں: ${list}۔`)
  }

  if (r.project_progress.length > 0) {
    const list = r.project_progress.map((p) => {
      const budgetClause = p.budget_pkr != null ? `، مختص بجٹ روپے ${fmt(p.budget_pkr)}، اب تک خرچ روپے ${fmt(p.spent_pkr)}` : ''
      return `${p.title} — حالت: ${projectStatusUr[p.status] ?? p.status}${p.progress_percent != null ? `، پیش رفت ${p.progress_percent} فیصد` : ''}${budgetClause}`
    }).join('؛ ')
    before.push(`جاری منصوبہ جات کی پیش رفت درج ذیل ہے: ${list}۔`)
  }
  before.push(netPositionParagraph(r))

  before.push(`اس مہینے کے اخراجات کی مکمل تفصیل ذیل کے جدول میں دی گئی ہے، جن کا مجموعہ روپے ${fmt(r.total_expenses)} رہا۔`)

  after.push(`آمدنی اور اخراجات کا موازنہ کرنے پر اس مہینے کا خالص ${r.net_surplus >= 0 ? 'فاضل' : 'خسارہ'} روپے ${fmt(Math.abs(r.net_surplus))} بنتا ہے۔`)
  after.push(`آخر میں، اس مہینے کے اختتام پر کمیٹی کے پاس کل روپے ${fmt(r.this_month_cash)} کی نقدی موجود ہے، جو اگلے مہینے کی ابتدائی رقم کے طور پر آگے لے جائی جائے گی۔`)

  return { before: before.join('\n\n'), after: after.join('\n\n') }
}
