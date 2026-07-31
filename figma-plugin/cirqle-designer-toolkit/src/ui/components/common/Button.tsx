import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: IconName;
  iconTrailing?: IconName;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  icon,
  iconTrailing,
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={['cdt-btn', `cdt-btn--${variant}`, className].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Icon name="spinner" size={14} /> : icon ? <Icon name={icon} size={14} /> : null}
      {children ? <span>{children}</span> : null}
      {iconTrailing ? <Icon name={iconTrailing} size={14} /> : null}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  ...rest
}: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={['cdt-icon-btn', className].filter(Boolean).join(' ')} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={16} />
    </button>
  );
}
