'use client'

import { forwardRef } from 'react'
import type { BrandingSettings } from '@/lib/branding'

type Category = 'miscellaneous' | 'donation_projects' | 'medical' | 'tree_plantation' | 'water_supply'
const CATEGORY_ORDER: Category[] = ['miscellaneous', 'donation_projects', 'medical', 'tree_plantation', 'water_supply']
const CATEGORY_LABEL_UR: Record<Category, string> = {
  miscellaneous: 'متفرق امور', donation_projects: 'عطیات و منصوبے', medical: 'طبی امداد',
  tree_plantation: 'شجرکاری', water_supply: 'واٹر سپلائی',
}

export interface AgendaMinutesTask {
  textUr: string
  dueDate: string | null
  status: 'pending' | 'in_progress' | 'done'
  assigneeNames: string[]
  doneByName: string | null
  category: Category
}
export interface AgendaMinutesSuggestion { textUr: string; raisedByName: string | null; isFromWebsite: boolean; replyText: string | null }
export interface AgendaMinutesEmergencyJob {
  textUr: string
  status: 'pending' | 'in_progress' | 'done'
  calledByName: string
  completedByName: string | null
}
export interface AgendaMinutesComplaint {
  complaintNumber: string | null
  complainantName: string | null
  sector: string | null
  text: string
  status: 'open' | 'awaiting_verification' | 'verified'
  inchargeName: string | null
}
export interface AgendaMinutesProjectDiscussion {
  title: string
  status: string
  voteCount: number
  voteTarget: number | null
  comments: { authorName: string | null; text: string; isSystem: boolean }[]
}
export interface AgendaMinutesActivityEntry {
  eventType: string; label: string; title: string; detail: string | null; actorName: string | null
}
export interface AgendaMinutesProjectCommentGroup {
  projectTitle: string
  comments: { authorName: string | null; text: string; isSystem: boolean }[]
}
export interface AgendaMinutesData {
  meetingDateLabel: string
  title: string | null
  runByName: string
  tasks: AgendaMinutesTask[]
  suggestions: AgendaMinutesSuggestion[]
  emergencyJobs: AgendaMinutesEmergencyJob[]
  complaints: AgendaMinutesComplaint[]
  projectDiscussions: AgendaMinutesProjectDiscussion[]
  recentActivity: AgendaMinutesActivityEntry[]
  projectComments: AgendaMinutesProjectCommentGroup[]
}

interface Props { data: AgendaMinutesData; branding: Partial<BrandingSettings> }

const statusLabelUr: Record<AgendaMinutesTask['status'], string> = {
  pending: 'زیرِ التوا', in_progress: 'جاری ہے', done: 'مکمل',
}
const complaintStatusLabelUr: Record<AgendaMinutesComplaint['status'], string> = {
  open: 'زیرِ التوا', awaiting_verification: 'حل کیا گیا، تصدیق باقی', verified: 'مکمل طور پر حل شدہ',
}

// Blank ruled lines under every printed point, for handwritten notes/replies
// taken at the physical meeting table — CSS-only, no interactivity.
function ReplySpace() {
  return (
    <div className="mt-2 pt-1">
      <div className="border-b border-dotted border-dp-outline-variant h-[18px]" />
      <div className="border-b border-dotted border-dp-outline-variant h-[18px]" />
    </div>
  )
}

// Urdu RTL letterhead — same reasoning as HiringRequestDocument (a document
// meant to be handed to/read by the committee, not an internal back-office
// record), printed via window-open + nodeToPdfBlob like every other document
// in this app. Tasks group by category in a fixed print order; suggestions
// split into committee-member-raised (first) and website-raised (last).
export const AgendaMinutesDocument = forwardRef<HTMLDivElement, Props>(function AgendaMinutesDocument({ data, branding }, ref) {
  const companyNameEn = branding.companyNameEn || 'Dhab Pari'
  const companyNameUr = branding.companyNameUr || companyNameEn

  const memberSuggestions = data.suggestions.filter((s) => !s.isFromWebsite)
  const websiteSuggestions = data.suggestions.filter((s) => s.isFromWebsite)
  let taskCounter = 0

  return (
    <div ref={ref} className="relative bg-white p-8 w-[640px] text-dp-on-surface" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>
      <div className="relative text-center mb-5 pb-3 border-b-2 border-dp-primary">
        {branding.logoUrl && (
          <img src={branding.logoUrl} alt="Logo" className="absolute right-0 top-0 object-contain" style={{ width: branding.logoWidth ?? 48, height: branding.logoWidth ?? 48 }} />
        )}
        <p className="text-[20px] font-bold">{companyNameUr}</p>
        <p className="text-[14px] text-dp-on-surface-variant mt-1">اجلاس کی کارروائی</p>
      </div>

      <div className="flex justify-between items-start mb-5 text-[14px]">
        <div className="text-right">
          <p className="text-dp-on-surface-variant">تاریخ</p>
          <p className="font-bold">{data.meetingDateLabel}</p>
        </div>
        <div className="text-left" dir="ltr">
          <p className="text-dp-on-surface-variant text-right" dir="rtl">صدارت</p>
          <p className="font-bold text-right" dir="rtl">{data.runByName}</p>
        </div>
      </div>

      {data.title && <p className="text-[15px] font-bold mb-4">{data.title}</p>}

      <p className="text-[13px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2">ایجنڈا پوائنٹس</p>
      {data.tasks.length === 0 && <p className="text-[13px] text-dp-on-surface-variant mb-6">کوئی پوائنٹ درج نہیں۔</p>}
      {CATEGORY_ORDER.map((cat) => {
        const catTasks = data.tasks.filter((t) => t.category === cat)
        if (catTasks.length === 0) return null
        return (
          <div key={cat} className="mb-5">
            <p className="text-[13px] font-bold text-dp-primary mb-2">{CATEGORY_LABEL_UR[cat]}</p>
            <div className="space-y-2.5">
              {catTasks.map((t, i) => {
                taskCounter += 1
                return (
                  <div key={i} className="border border-dp-outline-variant rounded-lg p-3">
                    <div className="flex justify-between items-start gap-2">
                      <p className="text-[14px] flex-1">{taskCounter}. {t.textUr}</p>
                      <span className="text-[11px] font-bold shrink-0 px-2 py-0.5 rounded-full bg-dp-surface-container-low">{statusLabelUr[t.status]}</span>
                    </div>
                    <p className="text-[12px] text-dp-on-surface-variant mt-1">
                      ذمہ دار: {t.assigneeNames.join('، ') || 'کوئی نہیں'}
                      {t.dueDate && ` · آخری تاریخ: ${t.dueDate}`}
                      {t.status === 'done' && t.doneByName && ` · مکمل کیا: ${t.doneByName}`}
                    </p>
                    <ReplySpace />
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      <p className="text-[13px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2 mt-2">تجاویز</p>

      <p className="text-[13px] font-bold text-dp-primary mb-2">کمیٹی اراکین کی تجاویز</p>
      {memberSuggestions.length === 0 ? (
        <p className="text-[13px] text-dp-on-surface-variant mb-5">کوئی تجویز موصول نہیں ہوئی۔</p>
      ) : (
        <div className="space-y-2.5 mb-5">
          {memberSuggestions.map((s, i) => (
            <div key={i} className="border border-dp-outline-variant rounded-lg p-3">
              <p className="text-[14px]">{i + 1}. {s.textUr}</p>
              {s.raisedByName && <p className="text-[12px] text-dp-on-surface-variant mt-1">تجویز دہندہ: {s.raisedByName}</p>}
              {s.replyText && <p className="text-[12.5px] text-dp-secondary mt-1.5">جواب: {s.replyText}</p>}
              <ReplySpace />
            </div>
          ))}
        </div>
      )}

      <p className="text-[13px] font-bold text-dp-primary mb-2">ویب سائٹ سے موصول تجاویز</p>
      {websiteSuggestions.length === 0 ? (
        <p className="text-[13px] text-dp-on-surface-variant">کوئی تجویز موصول نہیں ہوئی۔</p>
      ) : (
        <div className="space-y-2.5">
          {websiteSuggestions.map((s, i) => (
            <div key={i} className="border border-dp-outline-variant rounded-lg p-3">
              <p className="text-[14px]">{i + 1}. {s.textUr}</p>
              {s.raisedByName && <p className="text-[12px] text-dp-on-surface-variant mt-1">تجویز دہندہ: {s.raisedByName}</p>}
              {s.replyText && <p className="text-[12.5px] text-dp-secondary mt-1.5">جواب: {s.replyText}</p>}
              <ReplySpace />
            </div>
          ))}
        </div>
      )}

      {data.emergencyJobs.length > 0 && (
        <>
          <p className="text-[13px] font-bold uppercase tracking-wide text-red-700 mb-2 mt-6">ایمرجنسی کام</p>
          <div className="space-y-2.5">
            {data.emergencyJobs.map((e, i) => (
              <div key={i} className="border border-red-200 rounded-lg p-3">
                <div className="flex justify-between items-start gap-2">
                  <p className="text-[14px] flex-1">{i + 1}. {e.textUr}</p>
                  <span className="text-[11px] font-bold shrink-0 px-2 py-0.5 rounded-full bg-dp-surface-container-low">{statusLabelUr[e.status]}</span>
                </div>
                <p className="text-[12px] text-dp-on-surface-variant mt-1">
                  بلایا: {e.calledByName}
                  {e.status === 'done' && e.completedByName && ` · مکمل کیا: ${e.completedByName}`}
                </p>
                <ReplySpace />
              </div>
            ))}
          </div>
        </>
      )}

      {data.complaints.length > 0 && (
        <>
          <p className="text-[13px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2 mt-6">شکایات کی صورتحال</p>
          <div className="space-y-2.5">
            {data.complaints.map((c, i) => (
              <div key={i} className="border border-dp-outline-variant rounded-lg p-3">
                <div className="flex justify-between items-start gap-2">
                  <p className="text-[14px] flex-1">
                    {i + 1}. {c.complaintNumber ? `${c.complaintNumber} — ` : ''}{c.complainantName ?? 'نامعلوم'}{c.sector ? ` (سیکٹر ${c.sector})` : ''}
                  </p>
                  <span className="text-[11px] font-bold shrink-0 px-2 py-0.5 rounded-full bg-dp-surface-container-low">{complaintStatusLabelUr[c.status]}</span>
                </div>
                <p className="text-[12.5px] text-dp-on-surface-variant mt-1">{c.text}</p>
                <p className="text-[12px] text-dp-on-surface-variant mt-1">انچارج: {c.inchargeName ?? 'تاحال متعین نہیں'}</p>
                <ReplySpace />
              </div>
            ))}
          </div>
        </>
      )}

      {data.projectDiscussions.length > 0 && (
        <>
          <p className="text-[13px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2 mt-6">منصوبہ جات کی تجاویز اور رائے</p>
          <div className="space-y-2.5">
            {data.projectDiscussions.map((p, i) => (
              <div key={i} className="border border-dp-outline-variant rounded-lg p-3">
                <div className="flex justify-between items-start gap-2">
                  <p className="text-[14px] flex-1 font-semibold">{i + 1}. {p.title}</p>
                  <span className="text-[11px] font-bold shrink-0 px-2 py-0.5 rounded-full bg-dp-surface-container-low">
                    {p.status === 'upcoming' ? `${p.voteCount}/${p.voteTarget ?? '?'} ووٹ` : 'کمیٹی زیرِ غور'}
                  </span>
                </div>
                {p.comments.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {p.comments.map((c, j) => (
                      <p key={j} className="text-[12px] text-dp-on-surface-variant">
                        <span className="font-semibold">{c.authorName ?? 'نامعلوم'}:</span> {c.text}
                      </p>
                    ))}
                  </div>
                )}
                <ReplySpace />
              </div>
            ))}
          </div>
        </>
      )}

      {data.projectComments.length > 0 && (
        <>
          <p className="text-[13px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2 mt-6">پراجیکٹس پر نئے تبصرے</p>
          <div className="space-y-3">
            {data.projectComments.map((g, i) => (
              <div key={i} className="border border-dp-outline-variant rounded-lg p-3">
                <p className="text-[14px] font-semibold mb-1.5">{i + 1}. {g.projectTitle}</p>
                <div className="space-y-2">
                  {g.comments.map((c, j) => (
                    <div key={j}>
                      <p className="text-[12.5px] text-dp-on-surface-variant">
                        <span className="font-semibold">{c.authorName ?? 'نامعلوم'}:</span> {c.text}
                      </p>
                      <ReplySpace />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {data.recentActivity.length > 0 && (
        <>
          <p className="text-[13px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-2 mt-6">پچھلے اجلاس کے بعد کی سرگرمیاں</p>
          <div className="space-y-2">
            {data.recentActivity.map((a, i) => (
              <div key={i} className="border border-dp-outline-variant rounded-lg p-2.5">
                <p className="text-[13px]"><span className="font-semibold">{a.actorName ?? 'نامعلوم'}</span> — {a.title}</p>
                {a.detail && <p className="text-[11.5px] text-dp-on-surface-variant mt-0.5">{a.detail}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
})
