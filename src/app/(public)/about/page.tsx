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

  const { data: notesRaw } = await supabase
    .from('committee_notes')
    .select('id, body_en, body_ur, release_date, linked_project_id, projects(title, title_ur)')
    .eq('is_published', true)
    .order('release_date', { ascending: false })
    .order('created_at', { ascending: false })

  const committeeNotes = ((notesRaw ?? []) as unknown as {
    id: string; body_en: string; body_ur: string; release_date: string; linked_project_id: string | null
    projects: { title: string; title_ur: string | null } | { title: string; title_ur: string | null }[] | null
  }[]).map((n) => {
    const proj = Array.isArray(n.projects) ? n.projects[0] : n.projects
    return {
      id: n.id, body_en: n.body_en, body_ur: n.body_ur, release_date: n.release_date,
      project_id: n.linked_project_id, project_title: proj?.title ?? null, project_title_ur: proj?.title_ur ?? null,
    }
  })

  const { data: settings } = await supabase
    .from('site_settings')
    .select('key, value')
    .in('key', ['about_text', 'vision', 'mission', 'display_language'])

  const settingsMap: Record<string, string> = {}
  settings?.forEach((s) => { settingsMap[s.key] = s.value ?? '' })
  // Same single-language-at-a-time convention as /projects, /water/apply,
  // etc. — admin-set site-wide toggle, not per-visitor.
  const isUrdu = settingsMap.display_language === 'ur'

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="mb-12 text-center max-w-3xl mx-auto">
        <h1 className="font-heading text-[32px] md:text-[40px] font-bold leading-[40px] md:leading-[48px] text-dp-primary mb-4">
          About {SITE.name}
        </h1>
        <p
          className="text-dp-on-surface-variant text-[20px] mb-2"
          style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
        >
          {SITE.committeeUrdu}
        </p>
      </div>

      {/* Village History */}
      <section className="mb-16">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 md:p-12">
          <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-6">
            <T k="x.villageHistory" />
          </h2>
          <div className="prose max-w-none">
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant mb-4">
              {SITE.name} is a historic village located in District {SITE.district}, {SITE.province}, Pakistan.
              Nestled in the Potohar Plateau, the village has been home to resilient communities
              for generations, with agriculture and livestock as the backbone of its economy.
            </p>
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant mb-4">
              In {SITE.established}, a group of dedicated villagers established the Water & Welfare Committee
              to address critical infrastructure needs — starting with clean water supply, street
              lighting, and road construction. What began as a small initiative has grown into a
              community-driven transparency portal serving hundreds of households.
            </p>
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant">
              {settingsMap.about_text || `Dedicated to the prosperity and welfare of ${SITE.name} village through transparent management, modern water systems, and communal support.`}
            </p>
          </div>
        </div>
      </section>

      {/* Vision + Mission */}
      <section className="mb-16 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-dp-primary text-white rounded-lg p-8 relative overflow-hidden">
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <Eye size={24} className="text-dp-secondary-fixed" />
              <h2 className="font-heading text-[24px] font-bold leading-[32px]">
                <T k="x.ourVision" />
              </h2>
            </div>
            <p className="font-sans text-[18px] leading-[28px] opacity-90">
              {settingsMap.vision || 'A self-sustaining village with clean water, quality education, and modern infrastructure for every household.'}
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
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant">
              {settingsMap.mission || 'To provide transparent governance, efficient water management, and community-driven development through collective effort.'}
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
                    style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2' }}
                  >
                    {member.name_ur}
                  </p>
                )}
                <p
                  className="text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] mt-2"
                  style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
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
                    style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
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
