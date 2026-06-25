import Link from 'next/link'

type Variant = 'primary' | 'ghost' | 'white-ghost' | 'danger'

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

const base = 'inline-flex items-center justify-center gap-2 font-sans text-[14px] font-semibold tracking-[0.05em] rounded transition-all active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2.5'

const variants: Record<Variant, string> = {
  primary: `${base} bg-dp-secondary text-white hover:bg-dp-primary`,
  ghost: `${base} bg-transparent border-2 border-dp-secondary text-dp-secondary hover:bg-[#f0faf5]`,
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
