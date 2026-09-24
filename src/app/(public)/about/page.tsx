import type { Metadata } from 'next'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/server'
import { SITE } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'About & Committee',
  description: `Meet the ${SITE.fullName} — village history, vision, mission, and team members.`,
}

// Nothing on this page is per-visitor — committee roster, vision/mission,
// and village history all change rarely. Caching for 5 minutes turns every
// visit's full server render + DB round trip into one shared cached page.
export const revalidate = 300
import { Phone, Eye, Target } from 'lucide-react'
import { T } from '@/components/i18n/T'
import { CommitteeAnnouncementsArchive } from '@/components/home/CommitteeAnnouncementsArchive'
import { messages } from '@/lib/i18n/messages'

const initialsColors = [
  'bg-dp-primary-container text-dp-on-primary-container',
  'bg-dp-secondary text-white',
  'bg-dp-tertiary-container text-dp-on-tertiary-container',
  'bg-amber-500 text-white',
  'bg-blue-600 text-white',
  'bg-rose-500 text-white',
]

export default async function AboutPage() {
  const supabase = await createClient()

  const { data: members } = await supabase
    .from('committee_members')
    .select('*')
    .eq('is_active', true)
    .order('display_order')

  const allMembers = members ?? []

  // Ordered by when it was actually posted, not release_date — same
  // reasoning as the homepage card's identical query: keeps this archive's
  // top entry in agreement with whichever note the homepage is featuring,
  // rather than the two disagreeing whenever a release_date gets set to an
  // earlier day than a genuinely newer post.
  const { data: notesRaw } = await supabase
    .from('committee_notes')
    .select('id, body_en, body_ur, release_date, linked_project_id, link_url, link_label_en, link_label_ur, projects(title, title_ur)')
    .eq('is_published', true)
    .order('created_at', { ascending: false })

  const committeeNotes = ((notesRaw ?? []) as unknown as {
    id: string; body_en: string; body_ur: string; release_date: string; linked_project_id: string | null
    link_url: string | null; link_label_en: string | null; link_label_ur: string | null
    projects: { title: string; title_ur: string | null } | { title: string; title_ur: string | null }[] | null
  }[]).map((n) => {
    const proj = Array.isArray(n.projects) ? n.projects[0] : n.projects
    return {
      id: n.id, body_en: n.body_en, body_ur: n.body_ur, release_date: n.release_date,
      project_id: n.linked_project_id, project_title: proj?.title ?? null, project_title_ur: proj?.title_ur ?? null,
      link_url: n.link_url, link_label_en: n.link_label_en, link_label_ur: n.link_label_ur,
    }
  })

  const { data: settings } = await supabase
    .from('site_settings')
    .select('key, value')
    .in('key', ['about_text', 'about_text_ur', 'vision', 'vision_ur', 'mission', 'mission_ur', 'display_language'])

  const settingsMap: Record<string, string> = {}
  settings?.forEach((s) => { settingsMap[s.key] = s.value ?? '' })
  // Same single-language-at-a-time convention as /projects, /water/apply,
  // etc. — admin-set site-wide toggle, not per-visitor.
  const isUrdu = settingsMap.display_language === 'ur'

  // Real report, 2026-09-24: the village history paragraphs were hardcoded
  // English prose with no Urdu counterpart at all -- not a direction bug,
  // a genuine content gap. Added real Urdu translations as message keys
  // (x.villageHistoryP1/P2) with {placeholder} substitution, resolved here
  // via the same server-computed isUrdu the committee bios below already
  // use -- not the client-side <T>/useLocale() locale, which follows each
  // visitor's own toggle and could disagree with this page's site-wide
  // setting, splitting the page across two languages at once.
  const historyMsgs = messages[isUrdu ? 'ur' : 'en']
  const villageHistoryP1 = historyMsgs['x.villageHistoryP1']
    .replaceAll('{name}', isUrdu ? SITE.nameUrdu : SITE.name)
    .replaceAll('{district}', SITE.district)
    .replaceAll('{province}', SITE.province)
  const villageHistoryP2 = historyMsgs['x.villageHistoryP2'].replaceAll('{established}', SITE.established)
  const aboutHeading = historyMsgs['x.aboutHeading'].replaceAll('{name}', isUrdu ? SITE.nameUrdu : SITE.name)

  // Migration 508 added the _ur counterparts these three never had. Falls
  // back to the English value (never to a hardcoded literal — an admin who
  // edits about_text should see that change reflected even before they've
  // filled in the Urdu version) when the Urdu setting is blank, same
  // fallback convention as everywhere else in this app. isEnglishFallback
  // tracks whether that fallback actually fired, so the JSX below can wrap
  // ONLY that case in dir="ltr" -- plain English content sitting unguarded
  // in this page's RTL paragraph context bidi-reorders its own trailing
  // punctuation (a report with a screenshot: a stray "." rendered BEFORE
  // the sentence instead of after it).
  const aboutTextEn = settingsMap.about_text || 'Dedicated to the prosperity and welfare of Dhab Pari village through transparent management, modern water systems, and communal support.'
  const visionEn = settingsMap.vision || 'A self-sustaining village with clean water, quality education, and modern infrastructure for every household.'
  const missionEn = settingsMap.mission || 'To provide transparent governance, efficient water management, and community-driven development through collective effort.'
  const aboutText = isUrdu ? (settingsMap.about_text_ur || aboutTextEn) : aboutTextEn
  const vision = isUrdu ? (settingsMap.vision_ur || visionEn) : visionEn
  const mission = isUrdu ? (settingsMap.mission_ur || missionEn) : missionEn
  const aboutTextIsEnglishFallback = isUrdu && !settingsMap.about_text_ur
  const visionIsEnglishFallback = isUrdu && !settingsMap.vision_ur
  const missionIsEnglishFallback = isUrdu && !settingsMap.mission_ur

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="mb-12 text-center max-w-3xl mx-auto">
        <h1 className="font-heading text-[32px] md:text-[40px] font-bold leading-[40px] md:leading-[48px] text-dp-primary mb-4">
          {aboutHeading}
        </h1>
        <p
          className="text-dp-on-surface-variant text-[20px] mb-2"
          style={{ fontFamily: 'var(--font-urdu-ui)', lineHeight: '1.6' }}
        >
          {SITE.committeeUrdu}
        </p>
      </div>

      {/* Village History */}
      <section className="mb-16">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 md:p-12" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
          <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-6">
            <T k="x.villageHistory" />
          </h2>
          <div className="prose max-w-none">
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant mb-4">
              {villageHistoryP1}
            </p>
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant mb-4">
              {villageHistoryP2}
            </p>
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant" dir={aboutTextIsEnglishFallback ? 'ltr' : undefined}>
              {aboutText}
            </p>
          </div>
        </div>
      </section>

      {/* Vision + Mission.
          dir added here (was missing entirely before -- this section never
          flipped, unlike Village History above it), and each body paragraph
          gets its own dir="ltr" guard for the same reason as about_text:
          only when it's actually showing the English fallback, so a filled-
          in Urdu translation still reads correctly RTL. */}
      <section className="mb-16 grid grid-cols-1 md:grid-cols-2 gap-6" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
        <div className="bg-dp-primary text-white rounded-lg p-8 relative overflow-hidden">
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <Eye size={24} className="text-dp-secondary-fixed" />
              <h2 className="font-heading text-[24px] font-bold leading-[32px]">
                <T k="x.ourVision" />
              </h2>
            </div>
            <p className="font-sans text-[18px] leading-[28px] opacity-90" dir={visionIsEnglishFallback ? 'ltr' : undefined}>
              {vision}
            </p>
          </div>
          <div className="absolute -bottom-8 -right-8 w-32 h-32 bg-white/5 rounded-full blur-2xl" />
        </div>

        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 relative overflow-hidden">
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <Target size={24} className="text-dp-secondary" />
              <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary section-title">
                <T k="x.ourMission" />
              </h2>
            </div>
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant" dir={missionIsEnglishFallback ? 'ltr' : undefined}>
              {mission}
            </p>
          </div>
        </div>
      </section>

      {/* Committee Members */}
      <section>
        <div className="text-center mb-10">
          <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">
            <T k="x.committeeMembers" />
          </h2>
          <p className="text-dp-on-surface-variant font-sans text-[16px]">
            <T k="x.peopleDrivingChange" />
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {allMembers.map((member, i) => {
            const initials = member.name
              .split(' ')
              .map((w: string) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()
            const color = initialsColors[i % initialsColors.length]
            return (
              <div
                key={member.id}
                className="bg-white border border-dp-outline-variant rounded-lg p-6 text-center hover:border-dp-secondary transition-all"
              >
                {member.photo_url ? (
                  <Image src={member.photo_url} alt={member.name} width={64} height={64} className="w-16 h-16 rounded-full object-cover mx-auto mb-4" />
                ) : (
                  <div className={`w-16 h-16 rounded-full ${color} flex items-center justify-center font-bold font-sans text-[20px] mx-auto mb-4`}>
                    {initials}
                  </div>
                )}
                <h3 className="font-sans text-[18px] font-bold text-dp-on-surface leading-[28px]">
                  {member.name}
                </h3>
                {member.name_ur && (
                  <p
                    className="text-dp-on-surface-variant text-[16px] mt-1"
                    style={{ fontFamily: 'var(--font-urdu-ui)', lineHeight: '2' }}
                  >
                    {member.name_ur}
                  </p>
                )}
                <p
                  className="text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] mt-2"
                  style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}
                >
                  {isUrdu ? (member.position_ur || member.position) : member.position}
                </p>
                {member.phone && (
                  <a
                    href={`tel:${member.phone.replace(/-/g, '')}`}
                    className="inline-flex items-center gap-1 mt-3 text-dp-on-surface-variant text-[14px] font-sans hover:text-dp-primary transition-colors"
                  >
                    <Phone size={14} />
                    {member.phone}
                  </a>
                )}
                {(isUrdu ? (member.bio_ur || member.bio) : member.bio) && (
                  <p
                    className="text-dp-on-surface-variant text-[14px] font-sans mt-3 line-clamp-2"
                    dir={isUrdu ? 'rtl' : undefined}
                    style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}
                  >
                    {isUrdu ? (member.bio_ur || member.bio) : member.bio}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        {allMembers.length === 0 && (
          <div className="text-center py-16 text-dp-on-surface-variant font-sans">
            <T k="x.noCommitteeMembers" />
          </div>
        )}
      </section>

      {/* Committee Announcements — every note ever posted, date-wise, not
          just the latest one the homepage card carries. */}
      <section className="mt-16">
        <CommitteeAnnouncementsArchive notes={committeeNotes} />
      </section>
    </div>
  )
}
