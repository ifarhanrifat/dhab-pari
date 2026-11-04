// Tiny, deliberately dumb — the parent wraps its own icon in a
// `relative` wrapper and drops this inside; all the real logic lives
// in useChatUnread.
export function UnreadDot({ show }: { show: boolean }) {
  if (!show) return null
  return <span className="absolute -top-1 -end-1 w-2.5 h-2.5 rounded-full bg-red-500 border-2 border-white pointer-events-none" />
}
