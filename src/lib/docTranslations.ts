// Translation dictionary for everything a consumer/committee member actually
// sees: bills, receipts, printable statements/registers, and reports. Keyed off
// the same `display_language` site setting already read via
// fetchBrandingSettings() — not the separate, disconnected localStorage-based
// useTranslation()/translations.ts pair (those cover a handful of public-site
// nav strings only and were never wired to display_language).
//
// Deliberately NOT covering: company name/email (already handled separately
// via companyNameEn/companyNameUr), consumer/donor/vendor/party names, or any
// user-typed free text (particulars, notes, addresses) — those always render
// exactly as entered, in whichever script the user typed them in.
export type Lang = 'en' | 'ur'

export const DOC_STRINGS = {
  // Shared receipt/voucher labels
  authorizedSignatory: { en: 'Authorized Signatory', ur: 'مجاز دستخط کنندہ' },
  facebook: { en: 'Facebook', ur: 'فیس بک' },
  whatsappGroup: { en: 'WhatsApp Group', ur: 'واٹس ایپ گروپ' },
  currentProjects: { en: 'Current Projects', ur: 'جاری منصوبے' },
  donate: { en: 'Donate', ur: 'عطیہ دیں' },
  // Footer rows read as invitations, not as bare link labels — each pairs this
  // wording with its actual address on the same line.
  stayConnected: { en: 'Stay connected', ur: 'ہمارے ساتھ جڑے رہیں' },
  joinFacebookPage: { en: 'Join our Facebook page', ur: 'ہمارا فیس بک پیج جوائن کریں' },
  joinWhatsappGroup: { en: 'Join our WhatsApp group', ur: 'ہمارا واٹس ایپ گروپ جوائن کریں' },
  seeCurrentProjects: { en: 'See our current projects', ur: 'ہمارے جاری منصوبے دیکھیں' },
  donateOnline: { en: 'Donate online', ur: 'آن لائن عطیہ دیں' },
  emailUs: { en: 'Email us', ur: 'ہمیں ای میل کریں' },
  // Short captions under the Universal Slip's branded icon row.
  website: { en: 'Website', ur: 'ویب سائٹ' },
  email: { en: 'Email', ur: 'ای میل' },
  // Short forms — an icon caption has ~70px, so the sentence-length variants
  // above ("Join our WhatsApp group") wrap to three lines there.
  whatsappShort: { en: 'WhatsApp', ur: 'واٹس ایپ' },
  projectsShort: { en: 'Projects', ur: 'منصوبے' },
  chatWithUs: { en: 'Chat with us', ur: 'ہم سے بات کریں' },
  notYetConfirmed: { en: 'Not yet confirmed', ur: 'ابھی تصدیق نہیں ہوئی' },
  groupShort: { en: 'Group', ur: 'گروپ' },
  suggestionsShort: { en: 'Suggestions', ur: 'تجاویز' },
  complaintsShort: { en: 'Complaints', ur: 'شکایات' },
  // Payroll body (Universal Slip). Our model nets advances into the employee's
  // own ledger account rather than listing them as payslip deductions, so the
  // right-hand column is Owed / Paid Now / Carried Forward, not a deductions list.
  titleSalarySlip: { en: 'Salary Slip', ur: 'تنخواہ کی پرچی' },
  employee: { en: 'Employee', ur: 'ملازم کا نام' },
  earningsThisCycle: { en: 'Earnings This Cycle', ur: 'اس دورانیے کی آمدنی' },
  settlement: { en: 'Settlement', ur: 'حساب' },
  salaryAccrued: { en: 'Salary Accrued', ur: 'واجب الادا تنخواہ' },
  overtime: { en: 'Overtime', ur: 'اوور ٹائم' },
  eidBonus: { en: 'Eid Bonus', ur: 'عید بونس' },
  emergencyWork: { en: 'Emergency Work', ur: 'ہنگامی کام' },
  totalEarnings: { en: 'Total Earnings', ur: 'کل آمدنی' },
  balanceOwed: { en: 'Balance Owed', ur: 'واجب الادا رقم' },
  paidNow: { en: 'Paid Now', ur: 'ابھی ادا شدہ' },
  carriedForward: { en: 'Balance Carried Forward', ur: 'آئندہ کے لیے بقایا' },
  netPay: { en: 'Net Pay', ur: 'خالص تنخواہ' },
  period: { en: 'Period', ur: 'مدت' },
  designation: { en: 'Designation', ur: 'عہدہ' },
  forProject: { en: 'For Project', ur: 'برائے منصوبہ' },
  generalFund: { en: 'General Fund', ur: 'جنرل فنڈ' },
  // Spelled out as an instruction rather than a bare "Helpline:" label — a
  // donor/consumer reading a printed receipt should not have to guess what the
  // number is for or that WhatsApp works on it too.
  helplineDonation: {
    en: 'Call or WhatsApp this number for any donation issue: ',
    ur: 'کسی بھی عطیہ سے متعلق مسئلے کے لیے اس نمبر پر کال یا واٹس ایپ کریں: ',
  },
  helplineWater: {
    en: 'Call or WhatsApp this number for any water supply issue: ',
    ur: 'کسی بھی واٹر سپلائی مسئلے کے لیے اس نمبر پر کال یا واٹس ایپ کریں: ',
  },
  helplineGeneral: {
    en: 'Call or WhatsApp this number for any query: ',
    ur: 'کسی بھی سوال کے لیے اس نمبر پر کال یا واٹس ایپ کریں: ',
  },
  complaint: { en: 'Complaint: ', ur: 'شکایت: ' },
  subtotal: { en: 'Subtotal', ur: 'ذیلی مجموعہ' },
  discount: { en: 'Discount', ur: 'رعایت' },
  discountAppliedColon: { en: 'Discount applied: − Rs. ', ur: 'دی گئی رعایت: − روپے ' },
  totalPayable: { en: 'Total Payable', ur: 'کل قابل ادائیگی' },
  paid: { en: 'Paid', ur: 'ادا شدہ' },
  balanceDue: { en: 'Balance Due', ur: 'بقایا رقم' },
  securityDepositNote: {
    en: 'Security Deposit — collected separately, refundable (not included in Total Payable)',
    ur: 'سیکیورٹی ڈیپازٹ — علیحدہ وصول کیا گیا، واپسی کے قابل (کل قابل ادائیگی میں شامل نہیں)',
  },
  receiptHash: { en: 'Receipt #', ur: 'رسید نمبر ' },
  billingPeriod: { en: 'Billing Period: ', ur: 'بلنگ مدت: ' },
  paidStamp: { en: 'PAID', ur: 'ادا شدہ' },
  partialPaymentStamp: { en: 'PARTIAL PAYMENT', ur: 'جزوی ادائیگی' },
  titleBill: { en: 'Bill', ur: 'بل' },
  titlePaymentVoucher: { en: 'Payment Voucher', ur: 'ادائیگی واؤچر' },
  titleReceipt: { en: 'Receipt', ur: 'رسید' },
  // Donation receipts speak in donation vocabulary throughout, not the generic
  // debtor/collection vocabulary a water bill uses:
  //   donationReceived   — the amount on THIS receipt (replaces "Total"/کل)
  //   totalContributed   — the donor's lifetime total INCLUDING this receipt
  //   announcedRemaining — announced/pledged but not yet collected; the donor
  //                        analogue of a consumer's outstanding amount
  totalContributed: { en: 'Total Contributed', ur: 'کل عطیہ' },
  donationReceived: { en: 'Donation Received', ur: 'عطیہ وصولی' },
  announcedRemaining: { en: 'Announced Remaining', ur: 'اعلان شدہ بقایا' },
  outstandingAmount: { en: 'Outstanding Amount', ur: 'بقایا رقم' },
  paidTo: { en: 'Paid To', ur: 'ادائیگی بنام' },
  paidFrom: { en: 'Paid From', ur: 'ادائیگی بذریعہ' },
  receivedFrom: { en: 'Received From', ur: 'وصول کنندہ از' },
  billedTo: { en: 'Billed To', ur: 'بل بنام' },
  vendor: { en: 'Vendor', ur: 'فراہم کنندہ' },
  customerDebtor: { en: 'Customer/Debtor', ur: 'صارف/مقروض' },
  paidToLine: { en: 'Paid to: ', ur: 'ادائیگی بنام: ' },
  receivedWithThanksFrom: { en: 'Received with thanks from: ', ur: 'شکریے کے ساتھ وصول کنندہ از: ' },
  receivedWithThanksFromDonor: { en: 'Received with thanks from donor: ', ur: 'شکریے کے ساتھ عطیہ دہندہ: ' },
  amountBilledTo: { en: 'Amount billed to: ', ur: 'بل کی رقم بنام: ' },
  due: { en: 'Due ', ur: 'آخری تاریخ ' },
  from: { en: 'From', ur: 'از' },
  to: { en: 'To', ur: 'بنام' },
  date: { en: 'Date', ur: 'تاریخ' },
  noSuffix: { en: 'No.', ur: 'نمبر' },
  description: { en: 'Description', ur: 'تفصیل' },
  qty: { en: 'Qty', ur: 'مقدار' },
  rate: { en: 'Rate', ur: 'نرخ' },
  amount: { en: 'Amount', ur: 'رقم' },
  total: { en: 'Total', ur: 'کل' },
  dateColon: { en: 'Date: ', ur: 'تاریخ: ' },
  dueColon: { en: 'Due: ', ur: 'آخری تاریخ: ' },
  periodColon: { en: 'Period: ', ur: 'مدت: ' },
  totalPayableCaps: { en: 'TOTAL PAYABLE', ur: 'کل قابل ادائیگی' },
  totalCaps: { en: 'TOTAL', ur: 'کل' },
  depositRefundableSeparate: { en: 'Deposit (refundable, separate)', ur: 'ڈیپازٹ (واپسی کے قابل، علیحدہ)' },
  thankYou: { en: 'Thank you', ur: 'شکریہ' },
  receiptNoDot: { en: 'Receipt No. ', ur: 'رسید نمبر ' },
  dated: { en: 'Dated: ', ur: 'بتاریخ: ' },
  collectedBy: { en: 'Collected by: ', ur: 'وصول کنندہ: ' },
  remarks: { en: 'Remarks: ', ur: 'تبصرہ: ' },
  amountColon: { en: 'Amount: ', ur: 'رقم: ' },
  asOn: { en: ' (As on ', ur: ' (بتاریخ ' },
  closeParen: { en: ')', ur: ')' },

  // Invoice/bill page — ledger postings table + system labels
  ledgerPostings: { en: 'Ledger Postings', ur: 'کھاتہ اندراجات' },
  account: { en: 'Account', ur: 'اکاؤنٹ' },
  particular: { en: 'Particular', ur: 'تفصیل' },
  debit: { en: 'Debit', ur: 'ڈیبٹ' },
  credit: { en: 'Credit', ur: 'کریڈٹ' },
  noLedgerPostingsFound: { en: 'No ledger postings found.', ur: 'کوئی کھاتہ اندراج نہیں ملا۔' },
  waterSupplySystem: { en: 'Water Supply System', ur: 'واٹر سپلائی سسٹم' },
  donorsProjectsSystem: { en: 'Donors & Projects System', ur: 'ڈونرز اور منصوبہ جات سسٹم' },
  donorsProjects: { en: 'Donors & Projects', ur: 'ڈونرز اور منصوبہ جات' },

  // Reports — titles
  reportTrialBalance: { en: 'Trial Balance', ur: 'ٹرائل بیلنس' },
  reportBalanceSheet: { en: 'Balance Sheet', ur: 'بیلنس شیٹ' },
  reportIncomeExpense: { en: 'Profit & Loss Statement', ur: 'منافع و نقصان کا گوشوارہ' },
  reportConsumerOutstanding: { en: 'Consumer Outstanding Report', ur: 'صارف بقایا جات کی رپورٹ' },
  reportDonorReport: { en: 'Donor Report', ur: 'عطیہ دہندگان کی رپورٹ' },
  reportAccountStatement: { en: 'Account Statement Lookup', ur: 'اکاؤنٹ اسٹیٹمنٹ تلاش' },
  reportNonPayment: { en: '2-Month Non-Payment Report', ur: '2 ماہ عدم ادائیگی کی رپورٹ' },

  // Trial Balance
  code: { en: 'Code', ur: 'کوڈ' },
  header: { en: 'Header', ur: 'زمرہ' },

  // Balance Sheet
  assets: { en: 'Assets', ur: 'اثاثے' },
  totalAssets: { en: 'Total Assets', ur: 'کل اثاثے' },
  liabilities: { en: 'Liabilities', ur: 'واجبات' },
  totalLiabilities: { en: 'Total Liabilities', ur: 'کل واجبات' },
  fundBalance: { en: 'Unrestricted Fund Balance (Assets − Liabilities − Restricted Funds)', ur: 'غیر مخصوص فنڈ بیلنس (اثاثے − واجبات − مخصوص فنڈز)' },
  fundBalanceFootnote: {
    en: 'As of today. Unrestricted Fund Balance is a computed residual (accumulated surplus/deficit) after setting aside money still committed to specific projects below — not a separate postable account, appropriate for a committee rather than a shareholder "equity" figure.',
    ur: 'آج تک کے مطابق۔ غیر مخصوص فنڈ بیلنس ایک حسابی باقیات (مجموعی فاضل/خسارہ) ہے، نیچے مخصوص پروجیکٹس کے لیے مختص رقم الگ کرنے کے بعد — الگ سے پوسٹ کیا جانے والا اکاؤنٹ نہیں، یہ کمیٹی کے لیے موزوں ہے نہ کہ شیئر ہولڈر کے "ایکویٹی" اعداد کے لیے۔',
  },
  restrictedProjectFunds: { en: 'Restricted Funds — Committed to Specific Projects', ur: 'مخصوص فنڈز — مخصوص پروجیکٹس کے لیے مختص' },
  restrictedProjectFundsFootnote: {
    en: 'Money donors gave FOR a specific project, sitting inside Cash above but not free to spend on anything else. A positive balance is still unspent; a negative one means that project was spent past what it was ever specifically donated — funded, in effect, by a loan from the general pool.',
    ur: 'وہ رقم جو عطیہ دہندگان نے کسی مخصوص پروجیکٹ کے لیے دی، جو اوپر کیش میں شامل ہے مگر کسی اور چیز پر خرچ کرنے کے لیے آزاد نہیں۔ مثبت بیلنس ابھی خرچ نہیں ہوا؛ منفی بیلنس کا مطلب ہے کہ اس پروجیکٹ پر اس سے زیادہ خرچ ہوا جتنا اسے مخصوص طور پر عطیہ ملا — یعنی عمومی فنڈ سے قرض لے کر پورا کیا گیا۔',
  },
  heldForProjects: { en: 'Held for Incomplete Projects', ur: 'نامکمل پروجیکٹس کے لیے محفوظ' },
  overspentProjects: { en: 'Overspent Projects', ur: 'زائد خرچ شدہ پروجیکٹس' },
  totalRestrictedFunds: { en: 'Net Restricted Funds', ur: 'خالص مخصوص فنڈز' },

  // Profit & Loss
  revenue: { en: 'Revenue', ur: 'آمدنی' },
  grossRevenue: { en: 'Gross Revenue', ur: 'مجموعی آمدنی' },
  lessDiscountGiven: { en: 'Less: Discount Given', ur: 'مائنس: دی گئی رعایت' },
  netRevenue: { en: 'Net Revenue', ur: 'خالص آمدنی' },
  lessCogs: { en: 'Less: Cost of Goods Sold', ur: 'مائنس: فروخت شدہ مال کی لاگت' },
  grossProfit: { en: 'Gross Profit', ur: 'مجموعی منافع' },
  operatingExpenses: { en: 'Operating Expenses', ur: 'آپریٹنگ اخراجات' },
  totalOperatingExpenses: { en: 'Total Operating Expenses', ur: 'کل آپریٹنگ اخراجات' },
  netSurplusDeficit: { en: 'Net Surplus / (Deficit)', ur: 'خالص فاضل / (خسارہ)' },

  // Consumer Outstanding Report
  consumer: { en: 'Consumer', ur: 'صارف' },
  sector: { en: 'Sector', ur: 'سیکٹر' },
  mobile: { en: 'Mobile', ur: 'موبائل' },
  outstanding: { en: 'Outstanding', ur: 'بقایا' },
  statement: { en: 'Statement', ur: 'اسٹیٹمنٹ' },
  noOutstandingBalances: { en: 'No outstanding balances.', ur: 'کوئی بقایا رقم نہیں۔' },
  totalOutstanding: { en: 'Total Outstanding', ur: 'کل بقایا' },
  view: { en: 'View', ur: 'دیکھیں' },

  // Donor Report
  donor: { en: 'Donor', ur: 'عطیہ دہندہ' },
  project: { en: 'Project', ur: 'منصوبہ' },
  method: { en: 'Method', ur: 'طریقہ' },
  noDonationsInPeriod: { en: 'No donations in this period.', ur: 'اس مدت میں کوئی عطیہ موصول نہیں ہوا۔' },

  // Account Statement Lookup
  selectAccountToView: { en: 'Select an account above to view its statement.', ur: 'اسٹیٹمنٹ دیکھنے کے لیے اوپر ایک اکاؤنٹ منتخب کریں۔' },
  billHash: { en: 'Bill #', ur: 'بل نمبر ' },
  balance: { en: 'Balance', ur: 'بیلنس' },
  openingBalance: { en: 'Opening Balance', ur: 'ابتدائی بیلنس' },
  noTransactionsInPeriod: { en: 'No transactions in this period.', ur: 'اس مدت میں کوئی لین دین نہیں۔' },

  // Non-Payment Report
  nonPaymentSubtitle: {
    en: 'Consumers who failed to pay (unpaid or partial) for 2 consecutive months',
    ur: 'وہ صارفین جنہوں نے مسلسل 2 ماہ ادائیگی نہیں کی (غیر ادا شدہ یا جزوی)',
  },
  consumersFlagged: { en: 'Consumers Flagged', ur: 'نشان زدہ صارفین' },
  sectorsAffected: { en: 'Sectors Affected', ur: 'متاثرہ سیکٹرز' },
  totalPending: { en: 'Total Pending', ur: 'کل زیر التوا' },
  noConsumersFailedToPay: {
    en: 'No consumers have failed to pay for 2 consecutive months.',
    ur: 'کسی صارف نے مسلسل 2 ماہ ادائیگی میں کوتاہی نہیں کی۔',
  },
  unassignedSector: { en: 'Unassigned Sector', ur: 'غیر متعین سیکٹر' },
  contact: { en: 'Contact', ur: 'رابطہ' },
  pendingBills: { en: 'Pending Bills', ur: 'زیر التوا بل' },
  dueSuffix: { en: ' due', ur: ' واجب الادا' },

  // Daily Register / Account Statement
  dailyRegister: { en: 'Daily Register', ur: 'روزانہ رجسٹر' },
  closingBalance: { en: 'Closing Balance', ur: 'اختتامی بیلنس' },
  type: { en: 'Type', ur: 'قسم' },
  noCashBankTransactions: { en: 'No cash/bank transactions in this period.', ur: 'اس مدت میں کوئی نقد/بینک لین دین نہیں۔' },
  advanceBalance: { en: 'Advance Balance', ur: 'ایڈوانس بیلنس' },
  currentBalance: { en: 'Current Balance', ur: 'موجودہ بیلنس' },
  connections: { en: 'Connections', ur: 'کنکشنز' },
  amountDonated: { en: 'Amount Donated', ur: 'عطیہ کردہ رقم' },
  billReceivable: { en: 'Bill Receivable', ur: 'بل وصولی' },
  noTransactionsYet: { en: 'No transactions yet for this account.', ur: 'اس اکاؤنٹ میں ابھی تک کوئی لین دین نہیں۔' },
  receivedVia: { en: 'Received via', ur: 'موصولہ ذریعہ' },

  // Voucher/reference type labels (src/lib/ledgerLabels.ts)
  typeExpense: { en: 'Expense', ur: 'اخراجات' },
  typeIncome: { en: 'Income', ur: 'آمدنی' },
  typeBankTransfer: { en: 'Bank Transfer', ur: 'بینک ٹرانسفر' },
  typeCashWithdrawal: { en: 'Cash Withdrawal', ur: 'نقد نکاسی' },
  typeCashDeposit: { en: 'Cash Deposit', ur: 'نقد جمع' },
  typeSecurityDeposit: { en: 'Security Deposit', ur: 'سیکیورٹی ڈیپازٹ' },
  typeSecurityDepositRefund: { en: 'Security Deposit Refund', ur: 'سیکیورٹی ڈیپازٹ واپسی' },
  typeAdvancePayment: { en: 'Advance Payment', ur: 'ایڈوانس ادائیگی' },
  typeComplaintWaiver: { en: 'Complaint Waiver Settlement', ur: 'شکایت معافی سیٹلمنٹ' },
  typeProjectTransfer: { en: 'Project Fund Transfer', ur: 'پروجیکٹ فنڈ کی منتقلی' },
  typeBill: { en: 'Bill', ur: 'بل' },
  typeReceipt: { en: 'Receipt', ur: 'رسید' },
  typeDonation: { en: 'Donation', ur: 'عطیہ' },
  typeManualEntry: { en: 'Manual Entry', ur: 'دستی اندراج' },
  typeInventory: { en: 'Inventory', ur: 'انوینٹری' },
  typeCollectorSettlement: { en: 'Collector Settlement', ur: 'کلکٹر تصفیہ' },
  typeVoucher: { en: 'Voucher', ur: 'واؤچر' },
  typeKafalatPayment: { en: 'Kafalat Payment', ur: 'کفالت ادائیگی' },
  typeWazifaPayment: { en: 'Wazifa Payment', ur: 'وظیفہ ادائیگی' },
  typeWazifaRepayment: { en: 'Wazifa Repayment', ur: 'وظیفہ واپسی' },
  typeWazifaContribution: { en: 'Wazifa Contribution', ur: 'وظیفہ حصہ' },
  typeZakatDisbursement: { en: 'Zakat Disbursement', ur: 'زکوٰۃ ادائیگی' },
  typeUshrDisbursement: { en: 'Ushr Disbursement', ur: 'عشر ادائیگی' },
  typeEsalESawab: { en: 'Esal-e-Sawab', ur: 'ایصالِ ثواب' },

  // Running Capital
  runningCapital: { en: 'Running Capital', ur: 'چلتا سرمایہ' },
  livePosition: { en: 'Live Position', ur: 'موجودہ پوزیشن' },
  cashInHand: { en: 'Cash in Hand', ur: 'دستیاب نقدی' },
  cashInBank: { en: 'Cash in Bank', ur: 'بینک میں نقدی' },
  totalCash: { en: 'Total Cash', ur: 'کل نقدی' },
  totalReceivable: { en: 'Total Receivable', ur: 'کل وصولیاں' },
  totalPayableRC: { en: 'Total Payable', ur: 'کل واجب الادا' },
  grossPosition: { en: 'Cash + Receivable (before payables)', ur: 'نقدی + وصولیاں (واجبات سے پہلے)' },
  netRealizablePosition: { en: 'Cash + Receivable − Payable (net)', ur: 'نقدی + وصولیاں − واجبات (خالص)' },
  thisMonthsProfit: { en: "This Month's Profit", ur: 'اس مہینے کا منافع' },
  billingIncome: { en: 'Billing Income', ur: 'بلنگ آمدنی' },
  saleServiceIncome: { en: 'Sale / Service Income', ur: 'فروخت / سروس آمدنی' },
  totalExpenses: { en: 'Total Expenses', ur: 'کل اخراجات' },
  monthOverMonth: { en: 'Month-over-Month', ur: 'ماہ بہ ماہ موازنہ' },
  previousMonth: { en: 'Previous Month', ur: 'پچھلا مہینہ' },
  thisMonth: { en: 'This Month', ur: 'اس مہینے' },
  change: { en: 'Change', ur: 'فرق' },
  previousMonthBilling: { en: 'Previous Month Billing', ur: 'پچھلے مہینے کی بلنگ' },
  previousMonthReceivable: { en: 'Previous Month Receivable', ur: 'پچھلے مہینے کی وصولیاں' },
  thisMonthRecovery: { en: "This Month's Recovery", ur: 'اس مہینے کی وصولی' },
  totalPendingToDate: { en: 'Total Pending to Date', ur: 'آج تک کل زیر التوا' },
  pendingBySector: { en: 'Pending by Sector', ur: 'سیکٹر کے لحاظ سے زیر التوا' },
  monthlyClosingReports: { en: 'Monthly Closing Reports', ur: 'ماہانہ اختتامی رپورٹس' },
  viewPrint: { en: 'View / Print', ur: 'دیکھیں / پرنٹ کریں' },
  newConnectionsCount: { en: 'New Connections', ur: 'نئے کنکشن' },
  disconnectionsCount: { en: 'Disconnections', ur: 'منقطع شدہ کنکشن' },
  nonPayersDueToComplaint: { en: 'Non-Payers Due to Complaint', ur: 'شکایت کی وجہ سے عدم ادائیگی' },
  addNonPayer: { en: 'Add', ur: 'شامل کریں' },
  name: { en: 'Name', ur: 'نام' },
  reason: { en: 'Reason', ur: 'وجہ' },
  noReportsYet: { en: 'No monthly closing reports yet.', ur: 'ابھی تک کوئی ماہانہ اختتامی رپورٹ موجود نہیں۔' },
  billedAmountGross: { en: 'Billed Amount (Gross)', ur: 'بل شدہ رقم (مجموعی)' },
  discountGiven: { en: 'Discount Given', ur: 'دی گئی رعایت' },
  netBillingIncome: { en: 'Net Billing Income', ur: 'خالص بلنگ آمدنی' },
  discountByConsumer: { en: 'Discount by Consumer', ur: 'صارف کے لحاظ سے رعایت' },
  cashInMonth: { en: 'Cash In This Month', ur: 'اس مہینے نقدی آمد' },
  cashOutMonth: { en: 'Cash Out This Month', ur: 'اس مہینے نقدی اخراج' },
  activatedBadge: { en: 'Activated', ur: 'فعال ہو گیا' },
  inProgressBadge: { en: 'In Progress', ur: 'جاری' },
  notYetAssigned: { en: 'Not yet assigned', ur: 'ابھی تک مقرر نہیں' },
  inchargeColon: { en: 'Incharge:', ur: 'انچارج:' },
  donationsReceived: { en: 'Donations Received', ur: 'موصول شدہ عطیات' },
  opBalanceMismatchTitle: { en: "Opening balance doesn't match last month's closing figure", ur: 'ابتدائی بیلنس پچھلے مہینے کے اختتامی اعداد سے مماثل نہیں' },
  opBalanceMismatchExpected: { en: 'Expected Rs.', ur: 'متوقع روپے' },
  opBalanceMismatchLastReported: { en: "(last month's reported closing cash), but the ledger now shows Rs.", ur: '(پچھلے مہینے کی رپورٹ شدہ اختتامی نقدی)، لیکن لیجر اب روپے دکھا رہا ہے' },
  opBalanceMismatchExplain: { en: 'This means a prior-period transaction was edited or deleted after that month was reported. Open last month\'s report below to see what changed and add an explanation.', ur: 'اس کا مطلب ہے کہ اس مہینے کی رپورٹ کے بعد پچھلی مدت کی کوئی ٹرانزیکشن تبدیل یا حذف کی گئی۔ نیچے پچھلے مہینے کی رپورٹ کھول کر دیکھیں کیا بدلا اور وضاحت شامل کریں۔' },
  saved: { en: 'Saved', ur: 'محفوظ ہو گیا' },
  reportRegenerated: { en: 'Report regenerated with current figures', ur: 'رپورٹ موجودہ اعداد کے ساتھ دوبارہ تیار ہو گئی' },
  regenerating: { en: 'Regenerating...', ur: 'دوبارہ تیار ہو رہا ہے...' },
  regenerate: { en: 'Regenerate', ur: 'دوبارہ تیار کریں' },
  recomputeTitle: { en: 'Recompute this report with current figures/logic', ur: 'موجودہ اعداد/منطق کے ساتھ اس رپورٹ کو دوبارہ شمار کریں' },
  reconciliationExplainNote: { en: "Explain why this month's opening balance didn't match the previous report — this note is included when the report is printed.", ur: 'وضاحت کریں کہ اس مہینے کا ابتدائی بیلنس پچھلی رپورٹ سے کیوں مماثل نہیں تھا — یہ نوٹ رپورٹ پرنٹ ہونے پر شامل ہوتا ہے۔' },
  reconciliationPlaceholder: { en: 'e.g. Deleted a duplicate expense voucher dated last month...', ur: 'مثلاً پچھلے مہینے کی مورخہ ایک ڈپلیکیٹ اخراجاتی واؤچر حذف کر دیا...' },
  savingDots: { en: 'Saving...', ur: 'محفوظ ہو رہا ہے...' },
  saveBtn: { en: 'Save', ur: 'محفوظ کریں' },
  nonPayerAutoDetectNote: { en: "Auto-detected — a consumer with an active complaint and an outstanding bill. Add the committee's opinion for the printed report; nothing else here is editable.", ur: 'خودکار طور پر پتا چلا — ایک صارف جس کی فعال شکایت اور واجب الادا بل ہے۔ پرنٹ شدہ رپورٹ کے لیے کمیٹی کی رائے شامل کریں؛ یہاں اور کچھ قابلِ ترمیم نہیں۔' },
  complaintSincePrefix: { en: 'Complaint since', ur: 'شکایت بتاریخ' },
  unpaidSincePrefix: { en: 'Unpaid since', ur: 'عدم ادائیگی بتاریخ' },
  committeeOpinionPlaceholder: { en: "Committee's opinion...", ur: 'کمیٹی کی رائے...' },
  cashOutBadge: { en: 'vs', ur: 'بمقابلہ' },
} as const

export type DocStringKey = keyof typeof DOC_STRINGS

export function dt(lang: Lang, key: DocStringKey): string {
  return DOC_STRINGS[key][lang]
}

// The Universal Slip can print BOTH languages in the same slot rather than
// making them compete for it — "Donation Received / عطیہ وصولی". A slip is read
// by villagers who are comfortable in Urdu and by committee members who keep
// their books in English; printing one language forces one of them to guess.
export type SlipLang = Lang | 'both'

// Returned as parts, not a joined string, because the two scripts need
// different fonts and different bidi handling — the caller renders each in its
// own span. Trailing/leading punctuation is never baked in for the same reason.
export function dtBoth(mode: SlipLang, key: DocStringKey): { en: string | null; ur: string | null } {
  const pair = DOC_STRINGS[key]
  if (mode === 'en') return { en: pair.en, ur: null }
  if (mode === 'ur') return { en: null, ur: pair.ur }
  // Identical in both languages (numbers, proper nouns) — don't print it twice.
  if (pair.en === pair.ur) return { en: pair.en, ur: null }
  return { en: pair.en, ur: pair.ur }
}
