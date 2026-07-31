import type { InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

export function SearchInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={['cdt-search', className].filter(Boolean).join(' ')}>
      <Icon name="search" size={14} />
      <input type="text" {...rest} />
    </div>
  );
}
