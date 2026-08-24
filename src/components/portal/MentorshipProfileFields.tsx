'use client'

// Shared by both /portal/signup and /portal/profile — the profession/
// education/gender/mentorship-intent block, plus the registration-time
// explainer note. One component so the two forms can't drift apart.
import { GraduationCap, Lock, ShieldCheck } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PROFESSION_OPTIONS, PROFESSION_LABELS, EDUCATION_LEVEL_OPTIONS, EDUCATION_LEVEL_LABELS } from '@/lib/mentorshipOptions'

export interface MentorshipFieldsValue {
  gender: string
  profession: string
  profession_other: string
  education_level: string
  education_details: string
  is_currently_studying: boolean
  seeking_mentorship: boolean
  is_minor: boolean
  guardian_name: string
  guardian_mobile: string
  phone_private: boolean
}

export function MentorshipProfileFields({
  value, onChange,
}: {
  value: MentorshipFieldsValue
  onChange: (patch: Partial<MentorshipFieldsValue>) => void
}) {
  const { t, isUrdu } = useLocale()
  const label = (info: Record<string, { en: string; ur: string }>, key: string) => (isUrdu ? info[key]?.ur : info[key]?.en) ?? key

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.gender')}</label>
          <select value={value.gender} onChange={(e) => onChange({ gender: e.target.value })} className="input-field">
            <option value="">{t('m.notSaying')}</option>
            <option value="male">{t('m.male')}</option>
            <option value="female">{t('m.female')}</option>
          </select>
        </div>
        <div>
          <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.profession')}</label>
          <select value={value.profession} onChange={(e) => onChange({ profession: e.target.value })} className="input-field">
            <option value="">{t('m.selectOne')}</option>
            {PROFESSION_OPTIONS.map((p) => <option key={p} value={p}>{label(PROFESSION_LABELS, p)}</option>)}
          </select>
        </div>
      </div>
      {value.profession === 'other' && (
        <div>
          <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.professionOther')}</label>
          <input value={value.profession_other} onChange={(e) => onChange({ profession_other: e.target.value })} className="input-field" />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.educationLevel')}</label>
          <select value={value.education_level} onChange={(e) => onChange({ education_level: e.target.value })} className="input-field">
            <option value="">{t('m.selectOne')}</option>
            {EDUCATION_LEVEL_OPTIONS.map((lvl) => <option key={lvl} value={lvl}>{label(EDUCATION_LEVEL_LABELS, lvl)}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.currentlyStudying')}</label>
          <select value={value.is_currently_studying ? 'yes' : 'no'} onChange={(e) => onChange({ is_currently_studying: e.target.value === 'yes' })} className="input-field">
            <option value="yes">{t('g.yes')}</option>
            <option value="no">{t('g.no')}</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.educationDetails')}</label>
        <input value={value.education_details} onChange={(e) => onChange({ education_details: e.target.value })} placeholder={t('m.educationDetailsHint')} className="input-field" />
      </div>

      {/* ── The registration-time explainer note ─────────────────────────
          Content matches what was actually asked for: courses, institute
          directory, Wazifa, mentor chat, training programs. Marked "coming
          soon" honestly — only the profile fields on this page are live
          today; the rest ship in later phases and these become real links
          then, not before. */}
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-dp-secondary/5 border border-dp-secondary/20 rounded-lg p-4">
        <p className="font-sans text-[13px] font-bold text-dp-primary flex items-center gap-1.5 mb-1.5">
          <GraduationCap size={15} /> {t('m.noteTitle')}
        </p>
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('m.noteBody')}</p>
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={value.seeking_mentorship} onChange={(e) => onChange({ seeking_mentorship: e.target.checked })} className="mt-0.5 w-4 h-4 accent-dp-secondary shrink-0" />
        <span className="font-sans text-[13px] text-dp-on-surface leading-snug">{t('m.seekingMentorshipLabel')}</span>
      </label>

      {value.seeking_mentorship && (
        <div className="pl-6 space-y-3 border-l-2 border-dp-secondary/20">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={value.is_minor} onChange={(e) => onChange({ is_minor: e.target.checked })} className="mt-0.5 w-4 h-4 accent-dp-secondary shrink-0" />
            <span className="font-sans text-[13px] text-dp-on-surface leading-snug flex items-start gap-1.5"><ShieldCheck size={14} className="shrink-0 mt-0.5 text-dp-secondary" /> {t('m.isMinorLabel')}</span>
          </label>
          {value.is_minor && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.guardianName')}</label>
                <input value={value.guardian_name} onChange={(e) => onChange({ guardian_name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block text-[13px] font-bold text-dp-on-surface-variant mb-1.5 tracking-[0.06em] uppercase font-sans">{t('m.guardianMobile')}</label>
                <input type="tel" value={value.guardian_mobile} onChange={(e) => onChange({ guardian_mobile: e.target.value })} className="input-field" />
              </div>
            </div>
          )}
        </div>
      )}

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={value.phone_private} onChange={(e) => onChange({ phone_private: e.target.checked })} className="mt-0.5 w-4 h-4 accent-dp-secondary shrink-0" />
        <span className="font-sans text-[13px] text-dp-on-surface leading-snug flex items-start gap-1.5"><Lock size={14} className="shrink-0 mt-0.5 text-dp-secondary" /> {t('m.phonePrivateLabel')}</span>
      </label>
    </div>
  )
}
