import type { SVGProps } from 'react';

export type IconName =
  | 'rename' | 'cleaner' | 'a11y' | 'automator' | 'validator' | 'components'
  | 'assets' | 'export' | 'analytics' | 'qa' | 'settings'
  | 'search' | 'command' | 'close' | 'check' | 'warning' | 'error' | 'info'
  | 'chevron-right' | 'chevron-down' | 'undo' | 'play' | 'plus' | 'trash' | 'star' | 'pin'
  | 'download' | 'refresh' | 'spinner' | 'home' | 'eye' | 'eye-off';

const PATHS: Record<IconName, string> = {
  rename: 'M4 7V4h16v3M9 20h6M12 4v16',
  cleaner: 'M15 4l5 5-9 9H6v-5l9-9z M13 6l5 5',
  a11y: 'M12 4a2 2 0 100 4 2 2 0 000-4zM4 9h16M12 9v5l-3 6M12 14l3 6',
  automator: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6zM10 7h4M10 17h4M7 10v4M17 10v4',
  validator: 'M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z',
  components: 'M12 2l4 4-4 4-4-4zM2 12l4-4 4 4-4 4zM12 22l-4-4 4-4 4 4zM22 12l-4 4-4-4 4-4z',
  assets: 'M4 5h16v14H4zM4 15l4-4 3 3 5-6 4 5',
  export: 'M12 3v12M7 8l5-5 5 5M5 21h14',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  qa: 'M12 2l8 4v5c0 5-3.6 8.6-8 9-4.4-.4-8-4-8-9V6z M9 11l2 2 4-4',
  settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2L10 21h4l.5-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  command: 'M8 4a2 2 0 100 4h8a2 2 0 100-4H8zM8 16a2 2 0 100 4h8a2 2 0 100-4H8zM6 8v8M18 8v8',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  warning: 'M12 3l10 18H2zM12 10v4M12 17h.01',
  error: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 8v5M12 16h.01',
  info: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 11v6M12 7h.01',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 016 6v1',
  play: 'M6 4l14 8-14 8z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  star: 'M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z',
  pin: 'M12 2v8M8 10h8l2 4H6zM12 14v8',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  refresh: 'M4 4v6h6M20 20v-6h-6M5 15a7 7 0 0012.9 3M19 9A7 7 0 006.1 6',
  spinner: 'M12 3a9 9 0 100 18 9 9 0 000-18z',
  home: 'M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5',
  eye: 'M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  'eye-off': 'M4 4l16 16M9.9 5.4A10.8 10.8 0 0112 5.2c6.5 0 10 6.8 10 6.8a17.6 17.6 0 01-3.3 4.1M6.5 6.8C3.6 8.7 2 12 2 12s3.5 6.8 10 6.8c1.4 0 2.7-.3 3.9-.8M9.9 9.9a3 3 0 104.2 4.2',
};

export function Icon({ name, size = 16, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const spinning = name === 'spinner';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={[spinning ? 'cdt-spin' : '', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} strokeDasharray={spinning ? '40 15' : undefined} />
    </svg>
  );
}
