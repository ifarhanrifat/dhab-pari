// Phase 1 of the card-based redesign, 2026-10-12. The new design's own
// `image-slot` placeholder, backed by a real image two ways: `src`
// (an existing real column -- project.before_image_url, a classified's
// photo_url, a video's thumbnail_url) or `slotImages[slotKey]` (the new
// site_card_images table, for the committee logo and the decorative
// welfare/mentor thumbnails with no natural column of their own). Either
// way this renders at exactly the size/shape its wrapping element gives
// it (absolute inset-0, matching every card slot in the design), never
// its own intrinsic size -- card dimensions stay identical whether a
// tenant has uploaded a photo yet or not.
export function ImageSlot2({
  src, shape = 'rect', placeholder, className = '',
}: {
  src?: string | null
  shape?: 'rect' | 'circle'
  placeholder?: string
  className?: string
}) {
  if (src) {
    // Plain <img>, not next/image: these slots can point at any tenant's
    // own Supabase Storage URL, which a fixed remotePatterns allowlist
    // can't cover across self-serve tenants the way it can for assets
    // this app controls itself.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={`absolute inset-0 w-full h-full object-cover ${className}`} />
  }
  return (
    <div
      className={`absolute inset-0 w-full h-full flex items-center justify-center bg-dp2-card-border/40 text-[9px] font-medium text-dp-on-surface-variant text-center px-2 ${shape === 'circle' ? 'rounded-full' : ''} ${className}`}
    >
      {placeholder}
    </div>
  )
}
