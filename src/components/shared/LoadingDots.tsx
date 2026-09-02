// Small reusable "three bouncing dots" loading indicator — replaces the
// plain "Loading..." text that was used as-is across ~130 loading states
// throughout the app. Sized and colored to drop into any of those
// existing wrappers (a centered <div>, a <p>, a <td>) without needing to
// touch their own classNames — it's just an inline-flex span. Respects
// prefers-reduced-motion (a gentle pulse instead of a bounce) since a
// jumping animation is exactly the kind of motion that setting exists to
// suppress.
export function LoadingDots({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} role="status" aria-label="Loading">
      <span className="w-2 h-2 rounded-full bg-dp-secondary animate-bounce motion-reduce:animate-pulse [animation-delay:-0.3s]" />
      <span className="w-2 h-2 rounded-full bg-dp-secondary animate-bounce motion-reduce:animate-pulse [animation-delay:-0.15s]" />
      <span className="w-2 h-2 rounded-full bg-dp-secondary animate-bounce motion-reduce:animate-pulse" />
    </span>
  )
}
