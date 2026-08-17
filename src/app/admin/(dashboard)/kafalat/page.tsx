'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  GraduationCap, X, Plus, Save, ShieldAlert, UserPlus, Bus, Printer,
  Phone, AlertTriangle, Check, Wallet, HandCoins, RotateCcw, Info, HelpCircle, ChevronDown, Receipt,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ImageUpload } from '@/components/admin/ImageUpload'

/**
 * Kafalat — sponsoring a school child.
 *
 * Two things are load-bearing here and neither is obvious from the outside.
 *
 * Safeguarding: nothing on this screen is ever public. Children are shown to
 * sponsors by first name behind a login, and the ledger only ever sees the
 * code. A village site that publishes a poor child's photograph and full name
 * does that child real damage in a place where everyone knows everyone.
 *
 * Transport: it is the line that decides whether a village child continues.
 * Nothing for the school here; about Rs 4,000 a month for the run into
 * Chakwal, which is more than the school fee. Building the package from lines
 * rather than one number is what makes that visible.
 */

interface Measuring {
  academic_year: string; account_code: string
  required: number; confirmed: number; outstanding: number
  months_remaining: number; monthly_target: number; children_active: number
}

interface Child {
  id: string; code: string; first_name: string; first_name_ur: string | null
  full_name: string; guardian_name: string; guardian_phone: string | null
  gender: string | null; date_of_birth: string | null
  is_orphan: boolean; orphan_type: string | null
  school_name: string | null; current_class: string | null
  school_location: string; status: string
  guardian_consent_signed: boolean; photo_consent: boolean; do_not_display: boolean
  roll_no: string | null; section: string | null; uniform_mode: string
  created_at: string
}

interface DisbursementQueue {
  uniforms: {
    id: string; child_code: string; child_name: string; guardian: string
    guardian_phone: string | null; issue_no: number; scheduled_on: string
    amount: number; uniform_mode: string
  }[]
  disbursements: {
    id: string; child_code: string; child_name: string; guardian: string
    guardian_phone: string | null; category: string; month: string; amount: number
  }[]
}

interface ReverificationDue {
  child_id: string; code: string; name: string; guardian: string
  guardian_phone: string | null; current_class: string | null
  joined_on: string | null; last_verified: string | null
}

interface PackageLine {
  id: string; child_id: string; academic_year: string; category: string
  description: string | null; annual_amount_pkr: number
}

// What kafalat_sponsor_breakdown() returns per child — who has actually
// named this child and given, replacing kafalat_shares (which nothing ever
// wrote to and nothing ever confirmed a payment against).
interface Sponsor {
  name: string | null; is_anonymous: boolean; recurring: boolean; total_given: number
}

// What kafalat_children_for_naming() gives, for the same "how much of this
// child's requirement is covered" figure the donor portal shows.
interface NamingInfo { this_year_requirement: number; already_named: number }

// The pool-collection side, folded in from what used to be a separate
// /admin/pools screen — same shapes, just scoped to POOL-KFL only.
interface Position {
  pool_id: string; required: number; committed: number; received_this_month: number
  committee_covered_this_month: number; donors: number; coverage_percent: number
  suggested_share: number; min_share: number; donors_needed: number
  reserve_months: number; reserve_target_months: number; is_short: boolean
}
interface ShortMonth {
  pool_month_id: string; pool_code: string; month: string
  required: number; received: number; remaining: number; donors_needed: number
}
interface Lapsed {
  commitment_id: string; pool_code: string; name: string
  phone: string | null; amount: number; since: string
}
interface Cover { month: string; pool_code: string; amount: number; voucher_no: string | null; by: string | null }
interface Announcement {
  id: string; pool_code: string; donor_name: string | null; donor_phone: string | null
  amount: number; is_one_time: boolean; month: string; proof_url: string | null
  payment_batch_id: string | null
}

// Every school-fee/books/medical/exam-fee/tuition line, budgeted against
// what's actually been paid — the categories uniform and transport already
// had their own payment step for.
interface FeeQueueItem {
  line_id: string; child_id: string; child_code: string; child_name: string
  guardian: string; guardian_phone: string | null
  category: string; description: string | null; budgeted: number; paid_so_far: number
}

// kafalat_child_payment_form_data() — everything one child could owe right
// now, across the three tables above, in one call.
interface MonthlyFormData {
  fee_items: { line_id: string; category: string; description: string | null; budgeted: number; paid_so_far: number; covered_until: string | null }[]
  disbursements_due: { id: string; category: string; month: string; amount: number }[]
  uniform_due: { id: string; issue_no: number; academic_year: string; amount: number }[]
}
interface MonthlyItemEntry {
  kind: 'fee' | 'disbursement' | 'uniform'
  ref_id: string
  category: string
  label: string
  selected: boolean
  amount: number
  months_covered: number
  attachment_url: string
  paid_to: string
  note: string
}
interface MonthlyOtherEntry {
  category: 'admission_fee' | 'other'
  description: string
  amount: number
  attachment_url: string
  paid_to: string
}

interface Nomination {
  id: string; child_name: string; guardian_name: string | null
  approximate_age: number | null; gender: string | null
  address_hint: string | null; reason: string; status: string; created_at: string
  referrer_name: string | null; referrer_phone: string | null
  child_id: string | null; child_code: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const CATEGORIES = ['school_fee', 'uniform', 'books', 'stationery', 'transport', 'pocket_money', 'medical', 'exam_fee', 'tuition', 'other'] as const
const currentAcademicYear = () => {
  // The Punjab school year runs April to March, so a date in January still
  // belongs to the session that started last April.
  const d = new Date()
  const start = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

const emptyChild = {
  first_name: '', first_name_ur: '', full_name: '', guardian_name: '',
  guardian_relation: 'father', guardian_phone: '', address: '',
  date_of_birth: '', gender: 'male', is_orphan: false, orphan_type: '',
  school_id: '', school_name: '', current_class: '', school_location: 'village',
  guardian_consent_signed: false, photo_consent: false,
  roll_no: '', section: '', uniform_mode: 'staggered',
}

export default function KafalatPage() {
  const { t } = useLocale()
  const supabase = createClient()

  const [children, setChildren] = useState<Child[]>([])
  const [lines, setLines] = useState<PackageLine[]>([])
  const [sponsors, setSponsors] = useState<Record<string, Sponsor[]>>({})
  const [naming, setNaming] = useState<Record<string, NamingInfo>>({})
  const [nominations, setNominations] = useState<Nomination[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [measuring, setMeasuring] = useState<Measuring | null>(null)
  const [totalSpent, setTotalSpent] = useState(0)
  const [schools, setSchools] = useState<{ id: string; name: string; kind: string; location: string; monthly_fee_pkr: number; months_charged: number }[]>([])
  // What the chosen school actually charges for the class typed in, so the
  // committee sees the real number before the package is built rather than
  // after the challan arrives.
  const [feePreview, setFeePreview] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'children' | 'nominations' | 'operations' | 'collections' | 'reverify'>('children')
  const [showGuide, setShowGuide] = useState(false)
  const [queue, setQueue] = useState<DisbursementQueue | null>(null)

  // ── Collections: shortfall, lapsed donors, announced pledges awaiting
  // confirmation — folded in from what used to be a separate /admin/pools
  // screen, filtered to just this one pool.
  const [poolId, setPoolId] = useState<string | null>(null)
  const [poolPosition, setPoolPosition] = useState<Position | null>(null)
  const [shortMonths, setShortMonths] = useState<ShortMonth[]>([])
  const [lapsed, setLapsed] = useState<Lapsed[]>([])
  const [covers, setCovers] = useState<Cover[]>([])
  const [unrestrictedAvailable, setUnrestrictedAvailable] = useState(0)
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [batchSummary, setBatchSummary] = useState<Record<string, { count: number; total: number }>>({})
  const [covering, setCovering] = useState<ShortMonth | null>(null)
  const [coverAmount, setCoverAmount] = useState(0)
  const [coverNote, setCoverNote] = useState('')

  // ── Fees: school fee, books, medical, exam fee, tuition — the categories
  // that, unlike uniform and transport, never had a real payment step.
  const [feeQueue, setFeeQueue] = useState<FeeQueueItem[]>([])
  const [payingFee, setPayingFee] = useState<FeeQueueItem | null>(null)
  const [feeForm, setFeeForm] = useState({ amount: 0, method: 'cash', paid_to: '', signed_by: '', proof_url: '', note: '' })

  // ── One child, one form, one combined voucher — everything due this
  // month picked in a single sitting instead of paid one category at a
  // time. Reuses the same underlying fee/disbursement/uniform tables the
  // per-item flows above already write to (kafalat_record_monthly_payment),
  // so the queues here and on the Operations tab never disagree about
  // what's still owed.
  const [monthlyChild, setMonthlyChild] = useState<Child | null>(null)
  const [monthlyData, setMonthlyData] = useState<MonthlyFormData | null>(null)
  const [monthlyMethod, setMonthlyMethod] = useState('cash')
  const [monthlyItems, setMonthlyItems] = useState<MonthlyItemEntry[]>([])
  const [monthlyOthers, setMonthlyOthers] = useState<MonthlyOtherEntry[]>([])
  const [monthlyBusy, setMonthlyBusy] = useState(false)

  const [printingChild, setPrintingChild] = useState<Child | null>(null)
  const [dueList, setDueList] = useState<ReverificationDue[]>([])
  const [reverifyTarget, setReverifyTarget] = useState<ReverificationDue | null>(null)
  const [reverifyForm, setReverifyForm] = useState({
    home_visited: 'yes', household_matches: 'yes', household_note: '',
    father_employment_changed: false, father_employment_note: '',
    siblings_employment_changed: false, siblings_employment_note: '',
    income_verified: 'yes', observed_monthly_income_pkr: 0,
    school_continuing: 'yes', current_class: '', attendance_note: '',
    co_verifier_names: '', recommendation: 'continue', recommended_note: '', overall_note: '',
  })
  const [issuingUniform, setIssuingUniform] = useState<DisbursementQueue['uniforms'][number] | null>(null)
  const [uniformForm, setUniformForm] = useState({ received_by: '', signed_note: '', method: 'cash' })
  const [payingDisbursement, setPayingDisbursement] = useState<DisbursementQueue['disbursements'][number] | null>(null)
  const [disbursementForm, setDisbursementForm] = useState({ method: 'cash', signed_by: '', driver_name: '', signed_note: '' })
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyChild)
  // Set only while Add Child was opened from a nomination's "Register this
  // Child" — closes the loop nothing used to close: on success the
  // nomination gets marked Accepted and linked to the child it became,
  // instead of sitting in Screening forever with no way forward.
  const [registeringNomination, setRegisteringNomination] = useState<Nomination | null>(null)
  const [busy, setBusy] = useState(false)
  const [packageChild, setPackageChild] = useState<Child | null>(null)
  const [editLines, setEditLines] = useState<{ category: string; annual_amount_pkr: number }[]>([])

  // Ending a sponsorship reverses whatever of this year's requirement is
  // still owed, so the measuring account stops being measured against a
  // child who is no longer here — a raw status update would leave the pool
  // asking donors for money against a child that already left.
  const [endTarget, setEndTarget] = useState<Child | null>(null)
  const [endForm, setEndForm] = useState({ status: 'graduated', reason: '' })

  const endSponsorship = async () => {
    if (!endTarget) return
    setBusy(true)
    const { error } = await supabase.rpc('kafalat_end_child', {
      p_child_id: endTarget.id, p_status: endForm.status, p_reason: endForm.reason || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.ended'))
    setEndTarget(null)
    setEndForm({ status: 'graduated', reason: '' })
    load()
  }

  const load = useCallback(async () => {
    const [{ data: cs }, { data: ls }, { data: breakdown }, { data: named }, { data: ns }, { data: sum }, { data: sch }, { data: meas }, { data: spent }] = await Promise.all([
      supabase.from('kafalat_children').select('*').order('created_at', { ascending: false }),
      supabase.from('kafalat_package_lines').select('*'),
      supabase.rpc('kafalat_sponsor_breakdown'),
      supabase.rpc('kafalat_children_for_naming'),
      supabase.rpc('kafalat_nominations_with_referrer'),
      supabase.rpc('public_kafalat_summary'),
      supabase.from('schools').select('id, name, kind, location, monthly_fee_pkr, months_charged')
        .eq('is_active', true).order('location').order('name'),
      supabase.rpc('kafalat_measuring_position'),
      supabase.rpc('kafalat_total_spent'),
    ])
    setChildren((cs ?? []) as Child[])
    setLines((ls ?? []) as PackageLine[])
    setSponsors((breakdown ?? {}) as Record<string, Sponsor[]>)
    setNaming(Object.fromEntries(
      ((named ?? []) as (NamingInfo & { id: string })[]).map((n) => [n.id, n]),
    ))
    setNominations((ns ?? []) as Nomination[])
    setSummary((sum ?? {}) as Record<string, number>)
    setSchools((sch ?? []) as { id: string; name: string; kind: string; location: string; monthly_fee_pkr: number; months_charged: number }[])
    setMeasuring((meas ?? null) as Measuring | null)
    setTotalSpent(Number(spent ?? 0))
    setLoading(false)
  }, [supabase])

  const loadOperations = useCallback(async () => {
    const [{ data: q }, { data: due }, { data: fees }] = await Promise.all([
      supabase.rpc('kafalat_disbursement_queue'),
      supabase.rpc('kafalat_reverification_due'),
      supabase.rpc('kafalat_fee_queue'),
    ])
    setQueue((q ?? null) as DisbursementQueue | null)
    setDueList((due ?? []) as ReverificationDue[])
    setFeeQueue((fees ?? []) as FeeQueueItem[])
  }, [supabase])

  const loadCollections = useCallback(async () => {
    const { data: pool } = await supabase.from('support_pools').select('id').eq('code', 'POOL-KFL').single()
    const pid = (pool as { id: string } | null)?.id ?? null
    setPoolId(pid)
    const [{ data: pos }, { data: short }, { data: ann }] = await Promise.all([
      pid ? supabase.rpc('pool_position', { p_pool_id: pid }) : Promise.resolve({ data: null }),
      supabase.rpc('pool_shortfall_queue'),
      supabase.rpc('pool_announcement_queue'),
    ])
    setPoolPosition((pos ?? null) as Position | null)
    const s = short as { unrestricted_available: number; months: ShortMonth[]; lapsed: Lapsed[]; covers: Cover[] } | null
    setUnrestrictedAvailable(s?.unrestricted_available ?? 0)
    setShortMonths((s?.months ?? []).filter((m) => m.pool_code === 'POOL-KFL'))
    setLapsed((s?.lapsed ?? []).filter((l) => l.pool_code === 'POOL-KFL'))
    setCovers((s?.covers ?? []).filter((c) => c.pool_code === 'POOL-KFL'))
    const kflAnnouncements = ((ann ?? []) as Announcement[]).filter((a) => a.pool_code === 'POOL-KFL')
    setAnnouncements(kflAnnouncements)
    // A batch can span this pool, another pool, and a general donor pledge
    // all at once — payment_batch_summary() aggregates across every table,
    // so the total shown here is the real one even when part of the same
    // payment lives on a different admin page.
    const batchIds = Array.from(new Set(kflAnnouncements.filter((a) => a.payment_batch_id).map((a) => a.payment_batch_id as string)))
    if (batchIds.length > 0) {
      const { data: bs } = await supabase.rpc('payment_batch_summary', { p_batch_ids: batchIds })
      setBatchSummary((bs ?? {}) as Record<string, { count: number; total: number }>)
    } else {
      setBatchSummary({})
    }
  }, [supabase])

  useEffect(() => { if (tab === 'operations' || tab === 'reverify') loadOperations() }, [tab, loadOperations])
  // Loaded on mount, not gated on the tab being open — the Collections tab
  // shows a count badge of what's waiting, and a badge that only knows its
  // own number after you've already clicked into it is not a badge, it's a
  // reload button in disguise. This is exactly how a real announced-and-
  // proof-attached payment sat invisible: correctly saved, correctly
  // filtered, just never fetched until someone happened to open this tab.
  useEffect(() => { loadCollections() }, [loadCollections])

  const confirmAnnouncement = async (id: string) => {
    setBusy(true)
    const { error } = await supabase.rpc('pool_confirm_payment', { p_payment_id: id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.ok.confirmed'))
    loadCollections()
  }

  // pool_payments.proof_url is a path in the same private donation_receipts
  // bucket a general pledge's slip lives in (both now upload through
  // /portal/statement) — never a plain public URL, so it needs a signed
  // link minted per view, the same way /admin/donors already does it.
  const [viewingProofId, setViewingProofId] = useState<string | null>(null)
  const viewProof = async (id: string, path: string) => {
    setViewingProofId(id)
    const { data, error } = await supabase.storage.from('donation_receipts').createSignedUrl(path, 300)
    setViewingProofId(null)
    if (error || !data?.signedUrl) { toast.error('Could not open the payment screenshot'); return }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  const declineAnnouncement = async (id: string) => {
    const reason = prompt(t('pool.declineReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('pool_decline_announcement', { p_payment_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.ok.declined'))
    loadCollections()
  }

  const openCover = (m: ShortMonth) => {
    setCoverAmount(m.remaining)
    setCoverNote('')
    setCovering(m)
  }

  const submitCover = async () => {
    if (!covering) return
    setBusy(true)
    const { data, error } = await supabase.rpc('pool_cover_shortfall', {
      p_pool_month_id: covering.pool_month_id, p_amount: coverAmount, p_note: coverNote || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.covered').replace('{v}', (data as { voucher_no: string })?.voucher_no ?? ''))
    setCovering(null)
    loadCollections()
  }

  const openPayFee = (f: FeeQueueItem) => {
    setFeeForm({ amount: Math.max(f.budgeted - f.paid_so_far, 0) || f.budgeted, method: 'cash', paid_to: '', signed_by: '', proof_url: '', note: '' })
    setPayingFee(f)
  }

  const submitPayFee = async () => {
    if (!payingFee) return
    setBusy(true)
    const { data, error } = await supabase.rpc('kafalat_pay_fee_item', {
      p_line_id: payingFee.line_id, p_amount: feeForm.amount, p_method: feeForm.method,
      p_paid_to: feeForm.paid_to || null, p_signed_by: feeForm.signed_by || null,
      p_proof_url: feeForm.proof_url || null, p_note: feeForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { voucher_no: string }
    toast.success(t('kf.ok.feePaid').replace('{v}', r.voucher_no))
    setPayingFee(null)
    loadOperations()
  }

  const openMonthlyPayment = async (c: Child) => {
    setMonthlyChild(c)
    setMonthlyData(null)
    setMonthlyMethod('cash')
    setMonthlyOthers([])
    setMonthlyItems([])
    const { data, error } = await supabase.rpc('kafalat_child_payment_form_data', { p_child_id: c.id })
    if (error) { toast.error(friendlyError(error)); setMonthlyChild(null); return }
    const d = data as MonthlyFormData
    setMonthlyData(d)
    setMonthlyItems([
      ...d.fee_items.map((f): MonthlyItemEntry => ({
        kind: 'fee', ref_id: f.line_id, category: f.category,
        label: `${t(`kf.cat.${f.category}`)}${f.description ? ' — ' + f.description : ''}`,
        selected: false, amount: Math.max(f.budgeted - f.paid_so_far, 0) || f.budgeted,
        months_covered: 1, attachment_url: '', paid_to: '', note: '',
      })),
      ...d.disbursements_due.map((x): MonthlyItemEntry => ({
        kind: 'disbursement', ref_id: x.id, category: x.category,
        label: `${t(`kf.cat.${x.category}`)} — ${new Date(x.month).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`,
        selected: false, amount: x.amount, months_covered: 1, attachment_url: '', paid_to: '', note: '',
      })),
      ...d.uniform_due.map((x): MonthlyItemEntry => ({
        kind: 'uniform', ref_id: x.id, category: 'uniform',
        label: `${t('kf.cat.uniform')} ${x.issue_no}/2, ${x.academic_year}`,
        selected: false, amount: x.amount, months_covered: 1, attachment_url: '', paid_to: '', note: '',
      })),
    ])
  }

  const updateMonthlyItem = (idx: number, patch: Partial<MonthlyItemEntry>) => {
    setMonthlyItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }

  const addOtherRow = () => setMonthlyOthers((prev) => [...prev, { category: 'other', description: '', amount: 0, attachment_url: '', paid_to: '' }])
  const updateOtherRow = (idx: number, patch: Partial<MonthlyOtherEntry>) =>
    setMonthlyOthers((prev) => prev.map((o, i) => (i === idx ? { ...o, ...patch } : o)))
  const removeOtherRow = (idx: number) => setMonthlyOthers((prev) => prev.filter((_, i) => i !== idx))

  const monthlyTotal = () =>
    monthlyItems.filter((i) => i.selected).reduce((s, i) => s + (i.amount || 0), 0)
    + monthlyOthers.reduce((s, o) => s + (o.amount || 0), 0)

  const submitMonthlyPayment = async () => {
    if (!monthlyChild) return
    const selected = monthlyItems.filter((i) => i.selected && i.amount > 0)
    const others = monthlyOthers.filter((o) => o.amount > 0 && o.description.trim())
    if (selected.length === 0 && others.length === 0) { toast.error(t('kf.monthly.nothingSelected')); return }

    setMonthlyBusy(true)
    const items = [
      ...selected.map((i) => ({
        kind: i.kind, ref_id: i.ref_id, line_id: i.ref_id, category: i.category,
        amount: i.amount, months_covered: i.months_covered, attachment_url: i.attachment_url || null,
        paid_to: i.paid_to || null, note: i.note || null,
      })),
      ...others.map((o) => ({
        kind: 'other', category: o.category, amount: o.amount, description: o.description,
        attachment_url: o.attachment_url || null, paid_to: o.paid_to || null,
      })),
    ]
    const { data, error } = await supabase.rpc('kafalat_record_monthly_payment', {
      p_child_id: monthlyChild.id, p_method: monthlyMethod, p_items: items,
    })
    setMonthlyBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { voucher_no: string | null; status: string }
    toast.success(t('kf.monthly.ok').replace('{v}', r.voucher_no ?? (r.status === 'pending' ? 'pending approval' : r.status)))
    setMonthlyChild(null)
    setMonthlyData(null)
    loadOperations()
    loadCollections()
  }

  const [record, setRecord] = useState<{
    child_code: string; child_name: string; full_name: string; guardian_name: string
    guardian_phone: string | null; school_name: string | null; current_class: string | null
    academic_year: string; total_spent: number
    lines: { category: string; amount: number; paid_on: string; method: string | null; paid_to: string | null; signed_by: string | null; note: string | null }[]
  } | null>(null)

  const openPrintRecord = async (c: Child) => {
    const { data, error } = await supabase.rpc('kafalat_child_expense_record', { p_child_id: c.id })
    if (error) { toast.error(friendlyError(error)); return }
    setRecord(data as typeof record)
    setPrintingChild(c)
  }

  const printRecordNow = () => {
    if (!record) return
    const win = window.open('', '_blank')
    if (!win) return
    const rows = record.lines.map((l) => `
      <tr>
        <td>${new Date(l.paid_on).toLocaleDateString()}</td>
        <td style="text-transform:capitalize">${l.category.replace(/_/g, ' ')}</td>
        <td>Rs ${fmt(l.amount)}</td>
        <td>${l.method ?? ''}</td>
        <td>${l.paid_to ?? ''}</td>
        <td style="min-width:100px;border-bottom:1px solid #000">${l.signed_by ?? '&nbsp;'}</td>
      </tr>`).join('')
    win.document.write(`<html><head><title>${t('kf.record.title')} — ${record.child_name} (${record.child_code})</title>
      <style>
        body{font-family:sans-serif;padding:24px;font-size:12px}
        h1{font-size:18px;margin-bottom:2px} p{margin:2px 0}
        table{width:100%;border-collapse:collapse;margin-top:14px}
        th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:11.5px}
        th{background:#f3f3f3}
        .total{font-size:15px;font-weight:bold;margin-top:12px;text-align:right}
        .sign{margin-top:36px;display:flex;justify-content:space-between}
        .sign div{width:45%;border-top:1px solid #000;padding-top:4px;font-size:11px;text-align:center}
      </style></head><body>
      <h1>${t('kf.record.title')} — ${record.academic_year}</h1>
      <p><strong>${record.child_name}</strong> (${record.child_code}) — ${record.full_name}</p>
      <p>${t('kf.guardian')}: ${record.guardian_name}${record.guardian_phone ? ' · ' + record.guardian_phone : ''}</p>
      <p>${record.school_name ?? ''}${record.current_class ? ' · ' + t('kf.class') + ' ' + record.current_class : ''}</p>
      <table><thead><tr>
        <th>${t('kf.record.date')}</th><th>${t('kf.record.category')}</th><th>${t('kf.record.amount')}</th>
        <th>${t('kf.f.method')}</th><th>${t('kf.record.paidTo')}</th><th>${t('kf.record.signature')}</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="total">${t('kf.record.total')}: Rs ${fmt(record.total_spent)}</p>
      <div class="sign">
        <div>${t('kf.record.preparedBy')}</div>
        <div>${t('kf.record.committeeSignature')}</div>
      </div>
      </body></html>`)
    win.document.close()
    win.print()
  }

  const issueUniform = async () => {
    if (!issuingUniform) return
    if (!uniformForm.received_by.trim()) { toast.error(t('kf.err.receivedByRequired')); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('kafalat_issue_uniform', {
      p_issue_id: issuingUniform.id, p_received_by: uniformForm.received_by,
      p_signed_note: uniformForm.signed_note || null, p_method: uniformForm.method,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { voucher_no: string }
    toast.success(t('kf.ok.uniformIssued').replace('{v}', r.voucher_no))
    setIssuingUniform(null)
    setUniformForm({ received_by: '', signed_note: '', method: 'cash' })
    loadOperations()
  }

  const skipUniform = async (id: string) => {
    const reason = prompt(t('kf.skipReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('kafalat_skip_uniform', { p_issue_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.skipped'))
    loadOperations()
  }

  const payDisbursement = async () => {
    if (!payingDisbursement) return
    if (payingDisbursement.category === 'transport' && !disbursementForm.driver_name.trim()) {
      toast.error(t('kf.err.driverRequired')); return
    }
    setBusy(true)
    const { data, error } = await supabase.rpc('kafalat_pay_disbursement', {
      p_disbursement_id: payingDisbursement.id, p_method: disbursementForm.method,
      p_signed_by: disbursementForm.signed_by || null,
      p_driver_name: disbursementForm.driver_name || null,
      p_signed_note: disbursementForm.signed_note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { voucher_no: string }
    toast.success(t('kf.ok.disbursementPaid').replace('{v}', r.voucher_no))
    setPayingDisbursement(null)
    setDisbursementForm({ method: 'cash', signed_by: '', driver_name: '', signed_note: '' })
    loadOperations()
  }

  const skipDisbursement = async (id: string) => {
    const reason = prompt(t('kf.skipReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('kafalat_skip_disbursement', { p_disbursement_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.skipped'))
    loadOperations()
  }

  const printRegister = async () => {
    const { data, error } = await supabase.rpc('kafalat_register')
    if (error) { toast.error(friendlyError(error)); return }
    const reg = data as { academic_year: string
      children: { code: string; name: string; roll_no: string | null; section: string | null
        guardian: string; guardian_phone: string | null; current_class: string | null
        school_name: string | null; school_location: string; fee_annual: number
        transport_annual: number; uniform_mode: string
        uniform_status: { issue_no: number; status: string; scheduled_on: string }[] | null }[] }
    const win = window.open('', '_blank')
    if (!win) return
    const rows = reg.children.map((c) => `
      <tr>
        <td>${c.code}</td><td>${c.name}</td><td>${c.roll_no ?? ''}</td><td>${c.section ?? ''}</td>
        <td>${c.current_class ?? ''}</td><td>${c.school_name ?? ''}</td>
        <td>${c.guardian}${c.guardian_phone ? ' · ' + c.guardian_phone : ''}</td>
        <td>Rs ${fmt(c.fee_annual)}</td>
        <td>Rs ${fmt(c.transport_annual)}</td>
        <td style="min-width:120px;border-bottom:1px solid #000">&nbsp;</td>
      </tr>`).join('')
    win.document.write(`<html><head><title>${t('kf.registerTitle')} — ${reg.academic_year}</title>
      <style>
        body{font-family:sans-serif;padding:24px;font-size:12px}
        h1{font-size:18px} table{width:100%;border-collapse:collapse;margin-top:12px}
        th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:11.5px}
        th{background:#f3f3f3}
      </style></head><body>
      <h1>${t('kf.registerTitle')} — ${reg.academic_year}</h1>
      <p>${new Date().toLocaleDateString()}</p>
      <table><thead><tr>
        <th>Code</th><th>Name</th><th>${t('kf.rollNo')}</th><th>${t('kf.section')}</th>
        <th>${t('kf.class')}</th><th>School</th><th>${t('kf.guardian')}</th>
        <th>${t('kf.f.feeAnnual')}</th><th>${t('kf.f.transportAnnual')}</th><th>${t('kf.driverSignature')}</th>
      </tr></thead><tbody>${rows}</tbody></table>
      </body></html>`)
    win.document.close()
    win.print()
  }

  const openReverify = (d: ReverificationDue) => {
    setReverifyForm({
      home_visited: 'yes', household_matches: 'yes', household_note: '',
      father_employment_changed: false, father_employment_note: '',
      siblings_employment_changed: false, siblings_employment_note: '',
      income_verified: 'yes', observed_monthly_income_pkr: 0,
      school_continuing: 'yes', current_class: d.current_class ?? '', attendance_note: '',
      co_verifier_names: '', recommendation: 'continue', recommended_note: '', overall_note: '',
    })
    setReverifyTarget(d)
  }

  const submitReverify = async () => {
    if (!reverifyTarget) return
    setBusy(true)
    const { data, error } = await supabase.rpc('kafalat_record_reverification', {
      p_child_id: reverifyTarget.child_id,
      p_home_visited: reverifyForm.home_visited,
      p_household_matches: reverifyForm.household_matches,
      p_household_note: reverifyForm.household_note || null,
      p_father_employment_changed: reverifyForm.father_employment_changed,
      p_father_employment_note: reverifyForm.father_employment_note || null,
      p_siblings_employment_changed: reverifyForm.siblings_employment_changed,
      p_siblings_employment_note: reverifyForm.siblings_employment_note || null,
      p_income_verified: reverifyForm.income_verified,
      p_observed_monthly_income_pkr: reverifyForm.observed_monthly_income_pkr || null,
      p_school_continuing: reverifyForm.school_continuing,
      p_current_class: reverifyForm.current_class || null,
      p_attendance_note: reverifyForm.attendance_note || null,
      p_co_verifier_names: reverifyForm.co_verifier_names
        ? reverifyForm.co_verifier_names.split(',').map((s) => s.trim()).filter(Boolean) : null,
      p_recommendation: reverifyForm.recommendation,
      p_recommended_note: reverifyForm.recommended_note || null,
      p_overall_note: reverifyForm.overall_note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { verifiers: number; note?: string }
    if (r.verifiers < 2) {
      toast.warning(r.note ?? t('kf.reverify.needSecond'))
    } else {
      toast.success(t('kf.ok.reverified'))
    }
    setReverifyTarget(null)
    loadOperations()
    load()
  }

  useEffect(() => { load() }, [load])

  const packageTotal = (childId: string) =>
    lines.filter((l) => l.child_id === childId).reduce((s, l) => s + Number(l.annual_amount_pkr || 0), 0)

  // Against the same measuring-account requirement the pool divides among
  // donors, not the package total — a child can be fully named while their
  // package total and this year's requirement differ (mid-year joiners,
  // rate-card changes).
  const committed = (childId: string) => {
    const n = naming[childId]
    if (!n || n.this_year_requirement <= 0) return 0
    return Math.min(100, Math.round((n.already_named / n.this_year_requirement) * 100))
  }

  const previewFee = async (schoolId: string, currentClass: string) => {
    if (!schoolId) { setFeePreview(null); return }
    const { data } = await supabase.rpc('school_fee_for_class', {
      p_school_id: schoolId, p_class: currentClass || null,
    })
    setFeePreview((data ?? null) as Record<string, unknown> | null)
  }

  const addChild = async () => {
    if (!form.first_name.trim() || !form.full_name.trim() || !form.guardian_name.trim()) {
      toast.error(t('kf.err.required')); return
    }
    setBusy(true)
    const { data, error } = await supabase.from('kafalat_children').insert({
      ...form,
      school_id: form.school_id || null,
      first_name_ur: form.first_name_ur || null,
      guardian_phone: form.guardian_phone || null,
      address: form.address || null,
      date_of_birth: form.date_of_birth || null,
      orphan_type: form.is_orphan ? (form.orphan_type || 'father_deceased') : null,
      school_name: form.school_name || null,
      current_class: form.current_class || null,
      guardian_consent_at: form.guardian_consent_signed ? new Date().toISOString() : null,
      status: 'verified',
    }).select('id').single()
    if (error) { setBusy(false); toast.error(friendlyError(error)); return }

    // Prefills the package from the committee's own figures, with the
    // transport line following where the child actually studies.
    await supabase.rpc('kafalat_default_package', {
      p_child_id: data.id, p_academic_year: currentAcademicYear(),
    })

    if (registeringNomination) {
      const { error: acceptErr } = await supabase.rpc('kafalat_accept_nomination', {
        p_nomination_id: registeringNomination.id, p_child_id: data.id,
      })
      if (acceptErr) toast.error(`Child registered, but the nomination couldn't be marked Accepted: ${acceptErr.message}`)
      setRegisteringNomination(null)
    }

    setBusy(false)
    toast.success(t('kf.ok.added'))
    setShowForm(false)
    setForm(emptyChild)
    load()
  }

  // Pre-fills Add Child from a nomination's own submitted details, so the
  // committee isn't retyping a name/guardian/address it already has on
  // file. Date of birth is deliberately left blank rather than guessed
  // from an approximate age — that's exactly the kind of thing screening
  // in person is supposed to actually verify.
  const openRegisterFromNomination = (n: Nomination) => {
    setForm({
      ...emptyChild,
      first_name: n.child_name.split(' ')[0] || n.child_name,
      full_name: n.child_name,
      guardian_name: n.guardian_name || '',
      gender: n.gender === 'female' ? 'female' : 'male',
      address: n.address_hint || '',
    })
    setRegisteringNomination(n)
    setShowForm(true)
  }

  const openPackage = (c: Child) => {
    const existing = lines.filter((l) => l.child_id === c.id)
    setEditLines(
      CATEGORIES.map((cat) => ({
        category: cat,
        annual_amount_pkr: Number(existing.find((l) => l.category === cat)?.annual_amount_pkr ?? 0),
      }))
    )
    setPackageChild(c)
  }

  const savePackage = async () => {
    if (!packageChild) return
    setBusy(true)
    const year = currentAcademicYear()
    await supabase.from('kafalat_package_lines').delete().eq('child_id', packageChild.id).eq('academic_year', year)
    const rows = editLines.filter((l) => l.annual_amount_pkr > 0).map((l) => ({
      child_id: packageChild.id, academic_year: year,
      category: l.category, annual_amount_pkr: l.annual_amount_pkr,
    }))
    const { error } = rows.length > 0
      ? await supabase.from('kafalat_package_lines').insert(rows)
      : { error: null }
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.packageSaved'))
    setPackageChild(null)
    load()
  }

  const activate = async (c: Child) => {
    if (!c.guardian_consent_signed) { toast.error(t('kf.err.consentFirst')); return }
    // Runs the rate card and posts the year's requirement to the measuring
    // account in the same breath approval happens — a raw status update here
    // would leave the pool figure exactly where it was before this child ever
    // existed, the same class of bug the "cash received" button had.
    const { data, error } = await supabase.rpc('kafalat_approve_child', { p_child_id: c.id })
    if (error) { toast.error(friendlyError(error)); return }
    const r = data as { this_year_requirement: number; months_remaining: number }
    toast.success(t('kf.ok.activated').replace('{amt}', fmt(r.this_year_requirement)).replace('{n}', String(r.months_remaining)))
    load()
  }

  const reviewNomination = async (n: Nomination, status: string) => {
    const { data: adminId } = await supabase.rpc('current_admin_user_id')
    const { error } = await supabase.from('kafalat_nominations')
      .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: adminId ?? null }).eq('id', n.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.nominationReviewed'))
    load()
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <GraduationCap size={26} className="text-dp-secondary" /> {t('kf.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('kf.blurb')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowGuide((v) => !v)}
            className="flex items-center gap-1.5 px-3.5 py-2.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13.5px] font-semibold hover:border-dp-secondary transition-all cursor-pointer">
            <HelpCircle size={16} /> {t('kf.guide.toggle')}
            <ChevronDown size={14} className={`transition-transform ${showGuide ? 'rotate-180' : ''}`} />
          </button>
          <button onClick={() => { setForm(emptyChild); setRegisteringNomination(null); setShowForm(true) }}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <UserPlus size={16} /> {t('kf.addChild')}
          </button>
        </div>
      </div>

      {/* ── How this works — the whole flow, in plain language, for whoever
          is sitting at this screen: the donor accountant recording money,
          or a committee member checking on a child. */}
      {showGuide && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5 space-y-4">
          {([
            ['sponsorOrShare', 'kf.guide.sponsorOrShare'],
            ['measuring', 'kf.guide.measuring'],
            ['collections', 'kf.guide.collections'],
            ['operations', 'kf.guide.operations'],
            ['fees', 'kf.guide.fees'],
            ['reverify', 'kf.guide.reverify'],
            ['record', 'kf.guide.record'],
          ] as const).map(([key, base]) => (
            <div key={key}>
              <h4 className="font-heading text-[13.5px] font-bold text-dp-primary mb-1">{t(`${base}.title`)}</h4>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t(`${base}.body`)}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-5">
        <ShieldAlert size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('kf.safeguardingNotice')}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {([
          ['active_children', 'kf.card.active'],
          ['fully_sponsored', 'kf.card.full'],
          ['partly_sponsored', 'kf.card.partial'],
          ['awaiting_sponsor', 'kf.card.waiting'],
        ] as const).map(([key, label]) => (
          <div key={key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t(label)}</p>
            <p className="font-heading text-[24px] font-bold text-dp-primary">{summary[key] ?? 0}</p>
          </div>
        ))}
      </div>

      {/* ── The measuring account ──────────────────────────────────────
          What every registered child needs for the rest of this academic
          year, against what has been confirmed so far — the same figure
          Mushtarka Kafalat's pool divides among donors. A requirement
          register, not a fund: it holds no money of its own. */}
      {measuring && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-heading text-[14px] font-bold text-dp-primary">
              {t('kf.measuring.title')} {measuring.academic_year}
            </h3>
            <span className="font-mono text-[11px] text-dp-on-surface-variant">{measuring.account_code}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { v: fmt(measuring.required), l: t('kf.measuring.required') },
              { v: fmt(measuring.confirmed), l: t('kf.measuring.confirmed') },
              { v: fmt(measuring.outstanding), l: t('kf.measuring.outstanding') },
              { v: fmt(measuring.monthly_target), l: t('kf.measuring.monthlyTarget') },
              { v: fmt(totalSpent), l: t('kf.measuring.totalSpent') },
            ].map((s) => (
              <div key={s.l}>
                <p className="font-heading text-[18px] font-bold text-dp-primary">{s.v}</p>
                <p className="font-sans text-[11px] text-dp-on-surface-variant">{s.l}</p>
              </div>
            ))}
          </div>
          <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">
            {t('kf.measuring.monthsLeft').replace('{n}', String(measuring.months_remaining))}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {([
          ['children', `${t('kf.tab.children')} (${children.length})`],
          ['nominations', `${t('kf.tab.nominations')} (${nominations.filter((n) => n.status === 'new').length})`],
          ['operations', `${t('kf.tab.operations')}${queue ? ` (${queue.uniforms.length + queue.disbursements.length + feeQueue.length})` : ''}`],
          ['collections', `${t('kf.tab.collections')}${(announcements.length + lapsed.length + shortMonths.length) ? ` (${announcements.length + lapsed.length + shortMonths.length})` : ''}`],
          ['reverify', `${t('kf.tab.reverify')}${dueList.length ? ` (${dueList.length})` : ''}`],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === key ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && tab === 'children' && (
        <div className="space-y-3">
          {children.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.empty')}</p>
            </div>
          )}
          {children.map((c) => {
            const total = packageTotal(c.id)
            const pct = committed(c.id)
            const childSponsors = sponsors[c.id] ?? []
            return (
              <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-mono text-[11.5px] text-dp-on-surface-variant">{c.code}</span>
                      <span className="font-sans text-[15px] font-bold text-dp-on-surface">{c.first_name}</span>
                      <span className="font-sans text-[13px] text-dp-on-surface-variant">({c.full_name})</span>
                      {c.is_orphan && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('kf.orphan')}</span>}
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${c.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                        {t(`kf.status.${c.status}`)}
                      </span>
                      {!c.guardian_consent_signed && (
                        <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10.5px] font-bold">{t('kf.noConsent')}</span>
                      )}
                    </div>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {c.current_class && `${t('kf.class')} ${c.current_class} · `}
                      {c.roll_no && `${t('kf.rollNo')} ${c.roll_no}${c.section ? '/' + c.section : ''} · `}
                      {c.school_name}
                      <span className="inline-flex items-center gap-1 ms-2">
                        <Bus size={12} /> {t(`kf.loc.${c.school_location}`)}
                      </span>
                    </p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                      {t('kf.guardian')}: {c.guardian_name}{c.guardian_phone ? ` · ${c.guardian_phone}` : ''}
                    </p>

                    <div className="mt-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-sans text-[13px] font-semibold text-dp-on-surface">Rs {fmt(total)}/{t('es.year')}</span>
                        <span className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          · {pct}% {t('kf.sponsored')}{pct < 100 && ` · ${100 - pct}% ${t('kf.remaining')}`}
                        </span>
                      </div>
                      <div className="h-2 w-full max-w-xs bg-dp-surface-container rounded-full overflow-hidden">
                        <div className="h-full bg-dp-secondary" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      {childSponsors.length > 0 && (
                        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">
                          {childSponsors.map((s) =>
                            `${s.is_anonymous ? t('f.anonymousDonor') : s.name} — Rs ${fmt(s.total_given)}${s.recurring ? `/${t('pkf.month')}` : ''}`,
                          ).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 shrink-0">
                    {c.status === 'active' && (
                      <button onClick={() => openMonthlyPayment(c)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer whitespace-nowrap">
                        <HandCoins size={13} /> {t('kf.monthly.button')}
                      </button>
                    )}
                    {c.status === 'active' && (
                      <button onClick={() => openPrintRecord(c)}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                        <Receipt size={13} /> {t('kf.record.button')}
                      </button>
                    )}
                    <button onClick={() => openPackage(c)}
                      className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                      {t('kf.editPackage')}
                    </button>
                    {c.status !== 'active' && (
                      <button onClick={() => activate(c)}
                        className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer whitespace-nowrap">
                        {t('kf.activate')}
                      </button>
                    )}
                    {c.status === 'active' && (
                      <button onClick={() => setEndTarget(c)}
                        className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                        {t('kf.endSponsorship')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && tab === 'nominations' && (
        <div className="space-y-3">
          {nominations.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.noNominations')}</p>
            </div>
          )}
          {nominations.map((n) => (
            <div key={n.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">
                  {n.child_name}
                  {n.approximate_age && <span className="font-normal text-dp-on-surface-variant"> · {n.approximate_age} {t('kf.years')}</span>}
                </p>
                <p className="font-sans text-[11.5px] mt-0.5">
                  <span className={`px-1.5 py-0.5 rounded font-bold ${n.referrer_name ? 'bg-sky-100 text-sky-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>
                    {n.referrer_name ? `Referred by ${n.referrer_name}` : 'Referred by committee'}
                  </span>
                  {n.referrer_phone && <span className="text-dp-on-surface-variant"> · {n.referrer_phone}</span>}
                </p>
                {n.guardian_name && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">{t('kf.guardian')}: {n.guardian_name}</p>}
                {n.address_hint && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{n.address_hint}</p>}
                <p className="font-sans text-[13px] text-dp-on-surface mt-1.5 italic">{n.reason}</p>
              </div>
              {n.status === 'new' ? (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => reviewNomination(n, 'screening')}
                    className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    {t('kf.startScreening')}
                  </button>
                  <button onClick={() => reviewNomination(n, 'declined')}
                    className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                    {t('es.decline')}
                  </button>
                </div>
              ) : n.status === 'screening' ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-bold">{t(`kf.nstatus.${n.status}`)}</span>
                  <button onClick={() => openRegisterFromNomination(n)}
                    className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    Register this Child
                  </button>
                  <button onClick={() => reviewNomination(n, 'declined')}
                    className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                    {t('es.decline')}
                  </button>
                </div>
              ) : n.status === 'accepted' && n.child_code ? (
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold shrink-0">
                  {t('kf.nstatus.accepted')} → {n.child_code}
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-bold shrink-0">{t(`kf.nstatus.${n.status}`)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Operations: uniforms and monthly disbursements ──────────────
          The paper this actually produces — issue a uniform, pay a driver,
          print the register to carry to a school gate. */}
      {!loading && tab === 'operations' && (
        <div className="space-y-6">
          <button onClick={printRegister}
            className="flex items-center gap-2 px-4 py-2 bg-dp-primary text-white rounded-lg font-sans text-[13px] font-semibold hover:opacity-90 cursor-pointer">
            <Printer size={15} /> {t('kf.printRegister')}
          </button>

          <div>
            <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-2">{t('kf.uniformsDue')}</h3>
            {(!queue || queue.uniforms.length === 0) ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('kf.nothingDue')}</p>
            ) : (
              <div className="space-y-2">
                {queue.uniforms.map((u) => (
                  <div key={u.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
                        {u.child_name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{u.child_code}</span>
                        {' · '}{t('kf.uniformIssue')} {u.issue_no}/2
                      </p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {u.guardian}{u.guardian_phone ? ` · ${u.guardian_phone}` : ''} · Rs {fmt(u.amount)}
                        {' · '}{t(`kf.uniform.${u.uniform_mode}`)}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { setUniformForm({ received_by: '', signed_note: '', method: u.uniform_mode === 'cash' ? 'cash' : 'cash' }); setIssuingUniform(u) }}
                        className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.issue')}
                      </button>
                      <button onClick={() => skipUniform(u.id)}
                        className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.skip')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-2">{t('kf.disbursementsDue')}</h3>
            {(!queue || queue.disbursements.length === 0) ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('kf.nothingDue')}</p>
            ) : (
              <div className="space-y-2">
                {queue.disbursements.map((d) => (
                  <div key={d.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
                        {d.child_name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{d.child_code}</span>
                        {' · '}{t(`kf.cat.${d.category}`)}
                      </p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {d.guardian}{d.guardian_phone ? ` · ${d.guardian_phone}` : ''} · Rs {fmt(d.amount)}
                        {' · '}{new Date(d.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { setDisbursementForm({ method: 'cash', signed_by: '', driver_name: '', signed_note: '' }); setPayingDisbursement(d) }}
                        className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.pay')}
                      </button>
                      <button onClick={() => skipDisbursement(d.id)}
                        className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer">
                        {t('kf.skip')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Fees: school fee, books, medical, exam fee, tuition ──────
              These are budget lines, not scheduled disbursements — paid
              termly or as needed, so every line shown here regardless of
              whether it is fully settled yet, with what remains alongside
              what has already gone out. */}
          <div>
            <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-2">{t('kf.fees.due')}</h3>
            {feeQueue.length === 0 ? (
              <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('kf.nothingDue')}</p>
            ) : (
              <div className="space-y-2">
                {feeQueue.map((f) => (
                  <div key={f.line_id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
                        {f.child_name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{f.child_code}</span>
                        {' · '}{t(`kf.cat.${f.category}`)}
                      </p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {f.guardian}{f.guardian_phone ? ` · ${f.guardian_phone}` : ''}
                        {' · '}{t('kf.fees.paidOfBudgeted').replace('{paid}', fmt(f.paid_so_far)).replace('{budget}', fmt(f.budgeted))}
                      </p>
                    </div>
                    <button onClick={() => openPayFee(f)}
                      className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer shrink-0">
                      {t('kf.pay')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Collections: shortfall, lapsed donors, and pledges awaiting
          confirmation — folded in from what used to be a separate
          /admin/pools screen, scoped to just Kafalat. */}
      {!loading && tab === 'collections' && (
        <div className="space-y-6">
          {poolPosition && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { v: fmt(poolPosition.committed), l: t('pool.pledged') },
                  { v: String(poolPosition.donors), l: t('pool.donors') },
                  { v: `${poolPosition.coverage_percent}%`, l: t('kf.collections.coverage') },
                  { v: fmt(poolPosition.received_this_month), l: t('kf.collections.receivedThisMonth') },
                ].map((s) => (
                  <div key={s.l}>
                    <p className="font-heading text-[17px] font-bold text-dp-primary">{s.v}</p>
                    <p className="font-sans text-[11px] text-dp-on-surface-variant">{s.l}</p>
                  </div>
                ))}
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant flex items-center gap-1.5">
                <Wallet size={12} />
                {t('pool.reserve').replace('{n}', String(poolPosition.reserve_months)).replace('{target}', String(poolPosition.reserve_target_months))}
              </p>
            </div>
          )}

          {announcements.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <HandCoins size={16} /> {t('pool.queueTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.queueBlurb')}</p>
              <div className="space-y-2">
                {announcements.map((a) => (
                  <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{a.donor_name ?? '—'}</p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {a.donor_phone && <a href={`tel:${a.donor_phone}`} className="text-dp-secondary hover:underline">{a.donor_phone}</a>}
                        {' · '}Rs {fmt(a.amount)} · {a.is_one_time ? t('pool.oneTime') : t('pool.recurringMonthly')}
                      </p>
                      {a.payment_batch_id && batchSummary[a.payment_batch_id]?.count > 1 && (
                        <span title="Sent as one payment along with other pledges — some may be on other Collections tabs or /admin/donors"
                          className="inline-block mt-1 text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-amber-100 text-amber-800">
                          Part of Rs {batchSummary[a.payment_batch_id].total.toLocaleString()} · {batchSummary[a.payment_batch_id].count} items
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {a.proof_url && (
                        <button onClick={() => viewProof(a.id, a.proof_url!)} disabled={viewingProofId === a.id}
                          className="font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer disabled:opacity-50">
                          {viewingProofId === a.id ? '...' : t('pool.viewProof')}
                        </button>
                      )}
                      <button onClick={() => confirmAnnouncement(a.id)} disabled={busy}
                        className="bg-dp-secondary text-white font-sans text-[12px] font-bold px-3 py-1.5 rounded-lg disabled:opacity-50 cursor-pointer">
                        {t('pool.confirmThis')}
                      </button>
                      <button onClick={() => declineAnnouncement(a.id)}
                        className="font-sans text-[12px] font-bold text-dp-on-surface-variant hover:underline cursor-pointer">
                        {t('pool.declineThis')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {lapsed.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <Phone size={16} /> {t('pool.lapsedTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.lapsedBlurb')}</p>
              <div className="space-y-2">
                {lapsed.map((l) => (
                  <div key={l.commitment_id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{l.name}</p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {l.phone && <a href={`tel:${l.phone}`} className="text-dp-secondary hover:underline">{l.phone}</a>}
                      {' · '}Rs {fmt(l.amount)}/{t('pkf.month')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {shortMonths.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <AlertTriangle size={16} /> {t('pool.shortTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.shortBlurb').replace('{amt}', fmt(unrestrictedAvailable))}</p>
              <div className="space-y-2">
                {shortMonths.map((m) => (
                  <div key={m.pool_month_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-center gap-4">
                    <div className="flex-1 min-w-[200px]">
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {new Date(m.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                        {' · '}{t('pool.neededReceived').replace('{req}', fmt(m.required)).replace('{recd}', fmt(m.received))}
                      </p>
                    </div>
                    <p className="font-heading text-[18px] font-bold text-dp-secondary">{fmt(m.remaining)}</p>
                    <button onClick={() => openCover(m)}
                      className="bg-dp-primary text-white font-sans text-[12.5px] font-bold px-4 py-2 rounded-lg hover:opacity-90 cursor-pointer">
                      {t('pool.coverIt')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {covers.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <RotateCcw size={16} /> {t('pool.coversTitle')}
              </h3>
              <div className="space-y-2">
                {covers.map((c, i) => (
                  <div key={i} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">{new Date(c.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface">Rs {fmt(c.amount)}</p>
                    <p className="font-mono text-[11.5px] text-dp-secondary">{c.voucher_no ?? '—'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {announcements.length === 0 && lapsed.length === 0 && shortMonths.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.collections.allClear')}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Annual re-verification ───────────────────────────────────────
          A father finds work, a brother finishes his own studies — none of
          that shows up on its own. Once a year the committee goes back and
          asks, with the same weight as the first visit: two names, one
          form, one decision. */}
      {!loading && tab === 'reverify' && (
        <div className="space-y-3">
          {dueList.length === 0 ? (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.reverify.allDone')}</p>
            </div>
          ) : dueList.map((d) => (
            <div key={d.child_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">
                  {d.name} <span className="font-mono text-[11px] text-dp-on-surface-variant">{d.code}</span>
                </p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                  {t('kf.guardian')}: {d.guardian}{d.guardian_phone ? ` · ${d.guardian_phone}` : ''}
                  {d.current_class ? ` · ${t('kf.class')} ${d.current_class}` : ''}
                </p>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">
                  {d.last_verified ? t('kf.reverify.lastChecked').replace('{y}', d.last_verified) : t('kf.reverify.neverChecked')}
                </p>
              </div>
              <button onClick={() => openReverify(d)}
                className="px-3.5 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer shrink-0">
                {t('kf.reverify.recordVisit')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Add a child ─────────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => { setShowForm(false); setRegisteringNomination(null) }}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('kf.addChild')}</h2>
              <button onClick={() => { setShowForm(false); setRegisteringNomination(null) }} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            {registeringNomination && (
              <div className="bg-sky-50 border border-sky-200 rounded-lg px-4 py-3 mb-4">
                <p className="font-sans text-[12.5px] font-bold text-sky-800">Registering from a nomination</p>
                <p className="font-sans text-[12px] text-sky-800 mt-0.5 italic">&ldquo;{registeringNomination.reason}&rdquo;</p>
                <p className="font-sans text-[11.5px] text-sky-700 mt-1">Saving will mark that nomination Accepted and link it to this child.</p>
              </div>
            )}

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.firstName')}</label>
                  <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} className="input-field" />
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('kf.f.firstNameHint')}</p>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
                  <input value={form.first_name_ur} onChange={(e) => setForm({ ...form, first_name_ur: e.target.value })}
                    className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.fullName')}</label>
                  <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardian')}</label>
                  <input value={form.guardian_name} onChange={(e) => setForm({ ...form, guardian_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardianRelation')}</label>
                  <select value={form.guardian_relation} onChange={(e) => setForm({ ...form, guardian_relation: e.target.value })} className="input-field">
                    {['mother', 'father', 'grandparent', 'uncle', 'aunt', 'sibling', 'other'].map((r) => (
                      <option key={r} value={r}>{t(`kf.grel.${r}`)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.phone')}</label>
                  <input value={form.guardian_phone} onChange={(e) => setForm({ ...form, guardian_phone: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.dob')}</label>
                  <input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.gender')}</label>
                  <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input-field">
                    <option value="male">{t('kf.boy')}</option>
                    <option value="female">{t('kf.girl')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.class')}</label>
                  <input value={form.current_class}
                    onChange={(e) => { setForm({ ...form, current_class: e.target.value }); previewFee(form.school_id, e.target.value) }}
                    className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.schoolLocation')}</label>
                  <select value={form.school_location} onChange={(e) => setForm({ ...form, school_location: e.target.value })} className="input-field">
                    <option value="village">{t('kf.loc.village')}</option>
                    <option value="chakwal">{t('kf.loc.chakwal')}</option>
                    <option value="other">{t('kf.loc.other')}</option>
                  </select>
                </div>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant -mt-2">{t('kf.f.transportHint')}</p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.rollNo')}</label>
                  <input value={form.roll_no} onChange={(e) => setForm({ ...form, roll_no: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.section')}</label>
                  <input value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.uniformMode')}</label>
                  <select value={form.uniform_mode} onChange={(e) => setForm({ ...form, uniform_mode: e.target.value })} className="input-field">
                    <option value="both">{t('kf.uniform.both')}</option>
                    <option value="staggered">{t('kf.uniform.staggered')}</option>
                    <option value="cash">{t('kf.uniform.cash')}</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.school')}</label>
                <select value={form.school_id}
                  onChange={(e) => {
                    const sc = schools.find((x) => x.id === e.target.value)
                    setForm({
                      ...form, school_id: e.target.value,
                      school_name: sc?.name ?? form.school_name,
                      // The school knows where it is; the child's location
                      // follows from it rather than being asked twice.
                      school_location: sc?.location ?? form.school_location,
                    })
                    previewFee(e.target.value, form.current_class)
                  }}
                  className="input-field">
                  <option value="">{t('kf.f.schoolNotListed')}</option>
                  {schools.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.name} — {t(`sc.kind.${sc.kind}`)}{Number(sc.monthly_fee_pkr) > 0 ? ` · Rs ${fmt(sc.monthly_fee_pkr)}/${t('sc.month')}` : ''}
                    </option>
                  ))}
                </select>

                {!form.school_id && (
                  <input value={form.school_name} onChange={(e) => setForm({ ...form, school_name: e.target.value })}
                    placeholder={t('kf.f.schoolTypeName')} className="input-field mt-2" />
                )}

                {feePreview && (
                  <div className="mt-2 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">
                      {t('kf.f.feeForClass')} <strong>Rs {fmt(Number(feePreview.monthly_fee ?? 0))}</strong>/{t('sc.month')}
                      {' × '}{String(feePreview.months_charged ?? 12)}
                      {' = '}<strong>Rs {fmt(Number(feePreview.annual_fee ?? 0) + Number(feePreview.annual_charges ?? 0))}</strong>/{t('es.year')}
                      {feePreview.tier ? ` · ${String(feePreview.tier)}` : ''}
                    </p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('kf.f.feePreviewHint')}</p>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
                <input type="checkbox" checked={form.is_orphan} onChange={(e) => setForm({ ...form, is_orphan: e.target.checked })} className="accent-dp-secondary" />
                {t('kf.f.isOrphan')}
              </label>
              {form.is_orphan && (
                <select value={form.orphan_type} onChange={(e) => setForm({ ...form, orphan_type: e.target.value })} className="input-field">
                  <option value="father_deceased">{t('kf.orphan.father')}</option>
                  <option value="mother_deceased">{t('kf.orphan.mother')}</option>
                  <option value="both_deceased">{t('kf.orphan.both')}</option>
                </select>
              )}

              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 space-y-2">
                <p className="font-sans text-[12.5px] font-bold text-dp-on-surface">{t('kf.consentHeading')}</p>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={form.guardian_consent_signed}
                    onChange={(e) => setForm({ ...form, guardian_consent_signed: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  <span>{t('kf.f.consentSigned')}</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={form.photo_consent}
                    onChange={(e) => setForm({ ...form, photo_consent: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  <span>{t('kf.f.photoConsent')}</span>
                </label>
              </div>

              <button disabled={busy} onClick={addChild}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {busy ? t('action.saving') : t('kf.addChild')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── The package, line by line ───────────────────────────────────── */}
      {packageChild && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPackageChild(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('kf.packageTitle')}</h2>
              <button onClick={() => setPackageChild(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {packageChild.code} · {packageChild.first_name} · {currentAcademicYear()}
            </p>

            <div className="space-y-2 mb-4">
              {editLines.map((l, idx) => (
                <div key={l.category} className="grid grid-cols-[1fr_140px] gap-2 items-center">
                  <label className="font-sans text-[13.5px] text-dp-on-surface">{t(`kf.cat.${l.category}`)}</label>
                  <input type="number" min={0} value={l.annual_amount_pkr || ''}
                    onChange={(e) => {
                      const next = [...editLines]
                      next[idx] = { ...l, annual_amount_pkr: +e.target.value }
                      setEditLines(next)
                    }}
                    className="input-field !py-2 text-end tabular-nums" />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-dp-outline-variant pt-3 mb-4">
              <span className="font-sans text-[13px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant">{t('kf.annualTotal')}</span>
              <span className="font-heading text-[22px] font-bold text-dp-primary">
                Rs {fmt(editLines.reduce((s, l) => s + (l.annual_amount_pkr || 0), 0))}
              </span>
            </div>

            <button disabled={busy} onClick={savePackage}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Plus size={16} /> {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {endTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setEndTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('kf.endTitle')}</h2>
              <button onClick={() => setEndTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {t('kf.endBlurb').replace('{name}', endTarget.first_name)}
            </p>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.endReason')}</label>
            <select value={endForm.status} onChange={(e) => setEndForm({ ...endForm, status: e.target.value })}
              className="input-field mb-3">
              <option value="graduated">{t('kf.status.graduated')}</option>
              <option value="left_village">{t('kf.status.left_village')}</option>
              <option value="withdrawn">{t('kf.status.withdrawn')}</option>
            </select>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.note')}</label>
            <textarea value={endForm.reason} rows={2}
              onChange={(e) => setEndForm({ ...endForm, reason: e.target.value })} className="input-field mb-4" />

            <button disabled={busy} onClick={endSponsorship}
              className="w-full bg-dp-primary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? t('action.saving') : t('kf.confirmEnd')}
            </button>
          </div>
        </div>
      )}

      {/* ── Handing over a uniform ────────────────────────────────────── */}
      {issuingUniform && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setIssuingUniform(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[17px] font-bold text-dp-primary">{t('kf.issueTitle')}</h2>
              <button onClick={() => setIssuingUniform(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {issuingUniform.child_name} · {t('kf.uniformIssue')} {issuingUniform.issue_no}/2 · Rs {fmt(issuingUniform.amount)}
            </p>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.receivedBy')}</label>
            <input value={uniformForm.received_by} onChange={(e) => setUniformForm({ ...uniformForm, received_by: e.target.value })}
              placeholder={issuingUniform.guardian} className="input-field mb-3" />

            {issuingUniform.uniform_mode === 'cash' && (
              <>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.method')}</label>
                <select value={uniformForm.method} onChange={(e) => setUniformForm({ ...uniformForm, method: e.target.value })} className="input-field mb-3">
                  <option value="cash">{t('pool.method.cash')}</option>
                  <option value="bank">{t('pool.method.bank')}</option>
                </select>
              </>
            )}

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.note')}</label>
            <textarea value={uniformForm.signed_note} rows={2}
              onChange={(e) => setUniformForm({ ...uniformForm, signed_note: e.target.value })} className="input-field mb-4" />

            <button disabled={busy} onClick={issueUniform}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? t('action.saving') : t('kf.confirmIssue')}
            </button>
          </div>
        </div>
      )}

      {/* ── Paying a monthly disbursement ────────────────────────────────
          Transport insists on a driver's name; pocket money does not need
          one, since it goes to the guardian who is already on file. */}
      {payingDisbursement && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayingDisbursement(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[17px] font-bold text-dp-primary">{t('kf.payTitle')}</h2>
              <button onClick={() => setPayingDisbursement(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {payingDisbursement.child_name} · {t(`kf.cat.${payingDisbursement.category}`)} · Rs {fmt(payingDisbursement.amount)}
            </p>

            {payingDisbursement.category === 'transport' && (
              <>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.driverName')}</label>
                <input value={disbursementForm.driver_name}
                  onChange={(e) => setDisbursementForm({ ...disbursementForm, driver_name: e.target.value })} className="input-field mb-3" />
              </>
            )}

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.method')}</label>
            <select value={disbursementForm.method} onChange={(e) => setDisbursementForm({ ...disbursementForm, method: e.target.value })} className="input-field mb-3">
              <option value="cash">{t('pool.method.cash')}</option>
              <option value="bank">{t('pool.method.bank')}</option>
              <option value="jazzcash">JazzCash</option>
              <option value="easypaisa">EasyPaisa</option>
            </select>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.receivedBy')}</label>
            <input value={disbursementForm.signed_by}
              onChange={(e) => setDisbursementForm({ ...disbursementForm, signed_by: e.target.value })} className="input-field mb-3" />

            <button disabled={busy} onClick={payDisbursement}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
              {busy ? t('action.saving') : t('kf.confirmPay')}
            </button>
          </div>
        </div>
      )}

      {/* ── The annual re-verification visit ─────────────────────────────
          A committee member types this up after the visit. The signatures —
          the verifier's and the co-signer's — are on the paper form, not in
          this database; only the names go here. */}
      {reverifyTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setReverifyTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('kf.reverify.title')}</h2>
              <button onClick={() => setReverifyTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {reverifyTarget.name} · {reverifyTarget.code}
            </p>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.homeVisited')}</label>
                  <select value={reverifyForm.home_visited} onChange={(e) => setReverifyForm({ ...reverifyForm, home_visited: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.householdMatches')}</label>
                  <select value={reverifyForm.household_matches} onChange={(e) => setReverifyForm({ ...reverifyForm, household_matches: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option><option value="na">{t('g.na')}</option>
                  </select>
                </div>
              </div>
              <textarea placeholder={t('kf.reverify.householdNote')} value={reverifyForm.household_note} rows={2}
                onChange={(e) => setReverifyForm({ ...reverifyForm, household_note: e.target.value })} className="input-field" />

              <div className="bg-dp-surface-container-low rounded-lg p-3 space-y-2.5">
                <p className="font-sans text-[12.5px] font-bold text-dp-on-surface">{t('kf.reverify.whatChanged')}</p>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={reverifyForm.father_employment_changed}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, father_employment_changed: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  {t('kf.reverify.fatherEmploymentChanged')}
                </label>
                {reverifyForm.father_employment_changed && (
                  <input value={reverifyForm.father_employment_note} placeholder={t('kf.f.note')}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, father_employment_note: e.target.value })} className="input-field !py-2" />
                )}
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={reverifyForm.siblings_employment_changed}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, siblings_employment_changed: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  {t('kf.reverify.siblingsEmploymentChanged')}
                </label>
                {reverifyForm.siblings_employment_changed && (
                  <input value={reverifyForm.siblings_employment_note} placeholder={t('kf.f.note')}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, siblings_employment_note: e.target.value })} className="input-field !py-2" />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.incomeVerified')}</label>
                  <select value={reverifyForm.income_verified} onChange={(e) => setReverifyForm({ ...reverifyForm, income_verified: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option><option value="na">{t('g.na')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.observedIncome')}</label>
                  <input type="number" min={0} value={reverifyForm.observed_monthly_income_pkr || ''}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, observed_monthly_income_pkr: +e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.schoolContinuing')}</label>
                  <select value={reverifyForm.school_continuing} onChange={(e) => setReverifyForm({ ...reverifyForm, school_continuing: e.target.value })} className="input-field">
                    <option value="yes">{t('g.yes')}</option><option value="no">{t('g.no')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.class')}</label>
                  <input value={reverifyForm.current_class}
                    onChange={(e) => setReverifyForm({ ...reverifyForm, current_class: e.target.value })} className="input-field" />
                </div>
              </div>

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.coVerifiers')}</label>
                <input value={reverifyForm.co_verifier_names} placeholder={t('kf.reverify.coVerifiersPlaceholder')}
                  onChange={(e) => setReverifyForm({ ...reverifyForm, co_verifier_names: e.target.value })} className="input-field" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('kf.reverify.coVerifiersHint')}</p>
              </div>

              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.reverify.recommendation')}</label>
                <select value={reverifyForm.recommendation} onChange={(e) => setReverifyForm({ ...reverifyForm, recommendation: e.target.value })} className="input-field">
                  <option value="continue">{t('kf.reverify.rec.continue')}</option>
                  <option value="adjust">{t('kf.reverify.rec.adjust')}</option>
                  <option value="graduate">{t('kf.reverify.rec.graduate')}</option>
                  <option value="end">{t('kf.reverify.rec.end')}</option>
                </select>
              </div>
              {reverifyForm.recommendation !== 'continue' && (
                <textarea placeholder={t('kf.reverify.recommendationNote')} value={reverifyForm.recommended_note} rows={2}
                  onChange={(e) => setReverifyForm({ ...reverifyForm, recommended_note: e.target.value })} className="input-field" />
              )}

              <textarea placeholder={t('kf.reverify.overallNote')} value={reverifyForm.overall_note} rows={2}
                onChange={(e) => setReverifyForm({ ...reverifyForm, overall_note: e.target.value })} className="input-field" />

              <button disabled={busy} onClick={submitReverify}
                className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50">
                {busy ? t('action.saving') : t('kf.reverify.submit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Committee covers a shortfall ──────────────────────────────── */}
      {covering && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setCovering(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pool.coverTitle')}</h2>
              <button onClick={() => setCovering(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <Info size={15} className="text-dp-secondary shrink-0 mt-0.5" />
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('pool.coverExplain')}</p>
            </div>
            <label className="block font-sans text-[12.5px] font-bold text-dp-primary mb-1.5">{t('pool.coverAmount')}</label>
            <input type="number" min={1} max={covering.remaining} value={coverAmount}
              onChange={(e) => setCoverAmount(Number(e.target.value))} className="input-field mb-1.5" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-3.5">{t('pool.availableIs').replace('{amt}', fmt(unrestrictedAvailable))}</p>
            <label className="block font-sans text-[12.5px] font-bold text-dp-primary mb-1.5">{t('pool.coverNote')}</label>
            <textarea value={coverNote} onChange={(e) => setCoverNote(e.target.value)} rows={2} className="input-field mb-4" />
            <button onClick={submitCover} disabled={busy}
              className="w-full bg-dp-primary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer">
              {busy ? t('action.saving') : t('pool.confirmCover')}
            </button>
          </div>
        </div>
      )}

      {/* ── Paying a fee/books/medical/exam-fee/tuition line ────────────
          The one where the slip actually gets attached. */}
      {payingFee && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayingFee(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[17px] font-bold text-dp-primary">{t('kf.fees.payTitle')}</h2>
              <button onClick={() => setPayingFee(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {payingFee.child_name} · {t(`kf.cat.${payingFee.category}`)}
            </p>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pool.amount')}</label>
            <input type="number" min={1} value={feeForm.amount}
              onChange={(e) => setFeeForm({ ...feeForm, amount: Number(e.target.value) })} className="input-field mb-3" />

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.method')}</label>
            <select value={feeForm.method} onChange={(e) => setFeeForm({ ...feeForm, method: e.target.value })} className="input-field mb-3">
              <option value="cash">{t('pool.method.cash')}</option>
              <option value="bank">{t('pool.method.bank')}</option>
              <option value="jazzcash">JazzCash</option>
              <option value="easypaisa">EasyPaisa</option>
            </select>

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.fees.paidTo')}</label>
            <input value={feeForm.paid_to} placeholder={t('kf.fees.paidToPlaceholder')}
              onChange={(e) => setFeeForm({ ...feeForm, paid_to: e.target.value })} className="input-field mb-3" />

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.receivedBy')}</label>
            <input value={feeForm.signed_by} onChange={(e) => setFeeForm({ ...feeForm, signed_by: e.target.value })} className="input-field mb-3" />

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.fees.slip')}</label>
            <ImageUpload bucket="images" currentUrl={feeForm.proof_url || undefined}
              onUpload={(url) => setFeeForm({ ...feeForm, proof_url: url })} label={t('kf.fees.slipUpload')} />

            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5 mt-3">{t('kf.f.note')}</label>
            <textarea value={feeForm.note} rows={2} onChange={(e) => setFeeForm({ ...feeForm, note: e.target.value })} className="input-field mb-4" />

            <button disabled={busy} onClick={submitPayFee}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer">
              {busy ? t('action.saving') : t('kf.confirmPay')}
            </button>
          </div>
        </div>
      )}

      {monthlyChild && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setMonthlyChild(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-heading text-[17px] font-bold text-dp-primary">{t('kf.monthly.title')}</h2>
              <button onClick={() => setMonthlyChild(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {monthlyChild.first_name} ({monthlyChild.code})
            </p>

            {!monthlyData ? (
              <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[13px]">{t('action.loading')}</p>
            ) : monthlyItems.length === 0 && monthlyOthers.length === 0 ? (
              <p className="text-center py-6 text-dp-on-surface-variant font-sans text-[13px]">{t('kf.monthly.nothingDue')}</p>
            ) : null}

            {monthlyData && (
              <>
                {['fee', 'disbursement', 'uniform'].map((kind) => {
                  const rows = monthlyItems.map((it, idx) => ({ it, idx })).filter((r) => r.it.kind === kind)
                  if (rows.length === 0) return null
                  const heading = kind === 'fee' ? t('kf.monthly.budgeted') : kind === 'disbursement' ? t('kf.monthly.dueThisMonth') : t('kf.monthly.uniform')
                  return (
                    <div key={kind} className="mb-4">
                      <p className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2">{heading}</p>
                      <div className="space-y-3">
                        {rows.map(({ it, idx }) => (
                          <div key={idx} className={`border rounded-lg p-3 ${it.selected ? 'border-dp-secondary bg-dp-secondary-container/10' : 'border-dp-outline-variant'}`}>
                            <label className="flex items-center gap-2 cursor-pointer mb-2">
                              <input type="checkbox" checked={it.selected} className="accent-dp-secondary cursor-pointer"
                                onChange={(e) => updateMonthlyItem(idx, { selected: e.target.checked })} />
                              <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface flex-1">{it.label}</span>
                            </label>
                            {kind === 'fee' && monthlyData.fee_items.find((f) => f.line_id === it.ref_id)?.covered_until && (
                              <p className="font-sans text-[11.5px] text-dp-secondary mb-2 ms-6">
                                {t('kf.monthly.coveredUntil').replace('{date}', new Date(monthlyData.fee_items.find((f) => f.line_id === it.ref_id)!.covered_until!).toLocaleDateString())}
                              </p>
                            )}
                            {it.selected && (
                              <div className="ms-6 grid grid-cols-2 gap-2">
                                <div>
                                  <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">{t('pool.amount')}</label>
                                  <input type="number" min={1} value={it.amount}
                                    onChange={(e) => updateMonthlyItem(idx, { amount: Number(e.target.value) })} className="input-field !py-1.5 text-[13.5px]" />
                                </div>
                                {(kind === 'fee' || kind === 'disbursement') && (
                                  <div>
                                    <label className="block font-sans text-[11px] font-semibold text-dp-on-surface-variant mb-1">{t('kf.monthly.months')}</label>
                                    <input type="number" min={1} max={12} value={it.months_covered}
                                      onChange={(e) => updateMonthlyItem(idx, { months_covered: Math.max(Number(e.target.value), 1) })} className="input-field !py-1.5 text-[13.5px]" />
                                  </div>
                                )}
                                <div className="col-span-2">
                                  <ImageUpload bucket="images" currentUrl={it.attachment_url || undefined}
                                    onUpload={(url) => updateMonthlyItem(idx, { attachment_url: url })} label={t('kf.monthly.attachment')} />
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}

                <div className="mb-2">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-sans text-[11px] font-bold uppercase tracking-wide text-dp-on-surface-variant">{t('kf.monthly.other')}</p>
                    <button onClick={addOtherRow} className="font-sans text-[12.5px] font-semibold text-dp-secondary cursor-pointer hover:underline">{t('kf.monthly.addOther')}</button>
                  </div>
                  <div className="space-y-3">
                    {monthlyOthers.map((o, idx) => (
                      <div key={idx} className="border border-dp-outline-variant rounded-lg p-3">
                        <div className="flex items-start gap-2 mb-2">
                          <select value={o.category} onChange={(e) => updateOtherRow(idx, { category: e.target.value as MonthlyOtherEntry['category'] })}
                            className="input-field !py-1.5 text-[13.5px] w-auto">
                            <option value="admission_fee">{t('kf.cat.admission_fee')}</option>
                            <option value="other">{t('kf.cat.other')}</option>
                          </select>
                          <input value={o.description} placeholder={t('kf.monthly.description')}
                            onChange={(e) => updateOtherRow(idx, { description: e.target.value })} className="input-field !py-1.5 text-[13.5px] flex-1" />
                          <button onClick={() => removeOtherRow(idx)} className="text-dp-on-surface-variant cursor-pointer p-1.5"><X size={16} /></button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input type="number" min={1} value={o.amount || ''} placeholder={t('pool.amount')}
                            onChange={(e) => updateOtherRow(idx, { amount: Number(e.target.value) })} className="input-field !py-1.5 text-[13.5px]" />
                          <input value={o.paid_to} placeholder={t('kf.monthly.paidTo')}
                            onChange={(e) => updateOtherRow(idx, { paid_to: e.target.value })} className="input-field !py-1.5 text-[13.5px]" />
                          <div className="col-span-2">
                            <ImageUpload bucket="images" currentUrl={o.attachment_url || undefined}
                              onUpload={(url) => updateOtherRow(idx, { attachment_url: url })} label={t('kf.monthly.attachment')} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5 mt-4">{t('kf.monthly.method')}</label>
                <select value={monthlyMethod} onChange={(e) => setMonthlyMethod(e.target.value)} className="input-field mb-4">
                  <option value="cash">{t('pool.method.cash')}</option>
                  <option value="bank">{t('pool.method.bank')}</option>
                  <option value="jazzcash">JazzCash</option>
                  <option value="easypaisa">EasyPaisa</option>
                </select>

                <div className="flex items-center justify-between mb-3 px-1">
                  <span className="font-sans text-[13px] font-semibold text-dp-on-surface-variant">{t('kf.monthly.total')}</span>
                  <span className="font-heading text-[19px] font-bold text-dp-primary">Rs {fmt(monthlyTotal())}</span>
                </div>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-3">{t('kf.monthly.approvalNote')}</p>

                <button disabled={monthlyBusy} onClick={submitMonthlyPayment}
                  className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer">
                  {monthlyBusy ? t('action.saving') : t('kf.monthly.save')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── One child, printed ────────────────────────────────────────── */}
      {printingChild && record && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPrintingChild(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('kf.record.title')}</h2>
              <button onClick={() => setPrintingChild(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {record.child_name} ({record.child_code}) · {record.academic_year}
            </p>

            <div className="space-y-2 mb-4">
              {record.lines.length === 0 && (
                <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('kf.record.nothingYet')}</p>
              )}
              {record.lines.map((l, i) => (
                <div key={i} className="flex items-center justify-between border-b border-dp-outline-variant pb-2">
                  <div>
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface capitalize">{l.category.replace(/_/g, ' ')}</p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{new Date(l.paid_on).toLocaleDateString()}{l.paid_to ? ` · ${l.paid_to}` : ''}</p>
                  </div>
                  <p className="font-sans text-[13px] font-bold text-dp-on-surface">Rs {fmt(l.amount)}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-dp-outline-variant pt-3 mb-4">
              <span className="font-sans text-[13px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant">{t('kf.record.total')}</span>
              <span className="font-heading text-[22px] font-bold text-dp-primary">Rs {fmt(record.total_spent)}</span>
            </div>

            <button onClick={printRecordNow}
              className="w-full flex items-center justify-center gap-2 bg-dp-primary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 cursor-pointer">
              <Printer size={16} /> {t('kf.record.print')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
