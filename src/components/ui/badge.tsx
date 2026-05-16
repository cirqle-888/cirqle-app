import { cn } from '@/lib/utils'

interface BadgeProps {
  children: React.ReactNode
  className?: string
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'
}

const variants = {
  default: 'bg-secondary text-secondary-foreground',
  success: 'bg-green-500/15 text-green-400',
  warning: 'bg-yellow-500/15 text-yellow-400',
  danger: 'bg-red-500/15 text-red-400',
  info: 'bg-blue-500/15 text-blue-400',
  purple: 'bg-purple-500/15 text-purple-400',
}

export function Badge({ children, className, variant = 'default' }: BadgeProps) {
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  )
}
