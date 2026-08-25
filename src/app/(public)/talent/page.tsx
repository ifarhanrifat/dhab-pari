import { createClient } from '@/lib/supabase/server'
import { Sparkles } from 'lucide-react'
import { T } from '@/components/i18n/T'

export const revalidate = 300

interface Entry {
  id: string; display_name: string; talent_description: string
  needs: string | null; aspiration: string | null; photo_url: string | null; video_url: string | null
}

export default async function TalentShowcasePage() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('talent_showcases')
    .select('id, display_name, talent_description, needs, aspiration, photo_url, video_url')
    .eq('is_published', true)
    .order('created_at', { ascending: false })
  const entries = (data ?? []) as Entry[]

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10">
      <div className="text-center mb-10">
        <h1 className="font-heading text-[32px] md:text-[40px] font-bold text-dp-primary flex items-center justify-center gap-2.5">
          <Sparkles size={30} className="text-dp-secondary" /> <T k="talent.title" fallback="Talent Showcase" />
        </h1>
        <p className="font-sans text-[15px] text-dp-on-surface-variant mt-2 max-w-xl mx-auto">
          <T k="talent.subtitle" fallback="Talented villagers our community is proud of — and how you can help." />
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="text-center font-sans text-[14px] text-dp-on-surface-variant py-16">
          <T k="talent.none" fallback="No entries yet." />
        </p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {entries.map((e) => (
            <div key={e.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
              <div className="w-full h-48 bg-dp-surface-container-low flex items-center justify-center">
                {e.photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.photo_url} alt={e.display_name} className="w-full h-full object-cover" />
                ) : (
                  <Sparkles size={40} className="text-dp-secondary/40" />
                )}
              </div>
              <div className="p-5">
                <p className="font-heading text-[17px] font-bold text-dp-primary mb-1.5">{e.display_name}</p>
                <p className="font-sans text-[13.5px] text-dp-on-surface leading-relaxed mb-2">{e.talent_description}</p>
                {e.aspiration && (
                  <p className="font-sans text-[12.5px] text-dp-secondary font-semibold mb-1">
                    <T k="talent.wantsToBecome" fallback="Wants to become:" /> {e.aspiration}
                  </p>
                )}
                {e.needs && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                    <T k="talent.needs" fallback="Needs:" /> {e.needs}
                  </p>
                )}
                {e.video_url && (
                  <a href={e.video_url} target="_blank" rel="noreferrer" className="inline-block mt-3 font-sans text-[12.5px] font-semibold text-dp-secondary hover:underline">
                    <T k="talent.watchVideo" fallback="Watch video" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
