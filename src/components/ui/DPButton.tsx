import Link from 'next/link'

type Variant = 'primary' | 'gold' | 'ghost' | 'white-ghost' | 'danger'

interface DPButtonProps {
  variant?: Variant
  href?: string
  children: React.ReactNode
  className?: string
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?: () => void
  external?: boolean
}

// Phase 6: the mockup's buttons are all rounded-xl (12px) and plain-case,
// not the old uppercase-tracked 4px-radius shape — `gold` is new, matching
// the mockup's secondary-emphasis CTA recipe (publish/wallet/renew actions).
const base = 'inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold rounded-xl transition-all active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2.5'

const variants: Record<Variant, string> = {
  primary: `${base} bg-dp2-primary-dark text-white hover:brightness-110`,
  gold: `${base} bg-dp2-gold text-[#0f172a] hover:brightness-105`,
  ghost: `${base} bg-transparent border-2 border-dp2-primary-dark text-dp2-primary-dark hover:bg-dp2-tint-green-50`,
  'white-ghost': `${base} bg-transparent border-2 border-white text-white hover:bg-white/10`,
  danger: `${base} bg-dp-error text-white hover:opacity-90`,
}

export function DPButton({ variant = 'primary', href, children, className = '', type = 'button', disabled, onClick, external }: DPButtonProps) {
  const cls = `${variants[variant]} ${className}`

  if (href && !disabled) {
    if (external) {
      return <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>{children}</a>
    }
    return <Link href={href} className={cls}>{children}</Link>
  }

  return <button type={type} disabled={disabled} onClick={onClick} className={cls}>{children}</button>
}
