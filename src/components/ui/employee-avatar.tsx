'use client'

/**
 * EmployeeAvatar — renders a Cirqle-branded avatar for an employee.
 *
 * avatar_url rules:
 *   null / ''          → gradient circle with initials (default)
 *   'preset:N' (1-8)   → Cirqle-branded preset illustration
 *   https://…          → user-uploaded custom photo
 */

import { useState } from 'react'

// ─── Preset definitions ──────────────────────────────────────────────────────

export const AVATAR_PRESETS = [
  { id: 'preset:1',  label: 'Violet',   group: 'male'   },
  { id: 'preset:2',  label: 'Indigo',   group: 'male'   },
  { id: 'preset:3',  label: 'Ocean',    group: 'male'   },
  { id: 'preset:4',  label: 'Slate',    group: 'male'   },
  { id: 'preset:5',  label: 'Bloom',    group: 'female' },
  { id: 'preset:6',  label: 'Rose',     group: 'female' },
  { id: 'preset:7',  label: 'Fuchsia',  group: 'female' },
  { id: 'preset:8',  label: 'Orchid',   group: 'female' },
] as const

export type PresetId = typeof AVATAR_PRESETS[number]['id']

// ─── SVG preset illustrations ────────────────────────────────────────────────
// Each preset: gradient bg + a simple, distinctive silhouette in white.

function Preset1() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7c3aed"/>
          <stop offset="100%" stopColor="#4f1dcc"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p1)"/>
      {/* Subtle geometric accent */}
      <circle cx="68" cy="12" r="22" fill="rgba(255,255,255,0.06)"/>
      <circle cx="12" cy="68" r="18" fill="rgba(255,255,255,0.06)"/>
      {/* Head */}
      <circle cx="40" cy="30" r="14" fill="rgba(255,255,255,0.88)"/>
      {/* Short hair top */}
      <rect x="27" y="18" width="26" height="10" rx="5" fill="rgba(255,255,255,0.88)"/>
      {/* Body */}
      <path d="M16 74 C16 56 30 52 40 52 C50 52 64 56 64 74 Z" fill="rgba(255,255,255,0.88)"/>
      {/* Collar */}
      <path d="M34 51 L40 60 L46 51" fill="none" stroke="rgba(124,58,237,0.5)" strokeWidth="2"/>
    </svg>
  )
}

function Preset2() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p2" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#3730a3"/>
          <stop offset="100%" stopColor="#6d28d9"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p2)"/>
      <rect x="52" y="0" width="40" height="40" rx="20" fill="rgba(255,255,255,0.05)"/>
      {/* Head */}
      <circle cx="40" cy="30" r="13" fill="rgba(255,255,255,0.88)"/>
      {/* Short textured hair */}
      <path d="M27 26 C27 16 53 16 53 26 L53 20 C53 13 27 13 27 20 Z" fill="rgba(255,255,255,0.88)"/>
      {/* Side trim lines */}
      <rect x="26" y="24" width="4" height="8" rx="2" fill="rgba(255,255,255,0.88)"/>
      <rect x="50" y="24" width="4" height="8" rx="2" fill="rgba(255,255,255,0.88)"/>
      {/* Body */}
      <path d="M15 75 C15 55 29 51 40 51 C51 51 65 55 65 75 Z" fill="rgba(255,255,255,0.88)"/>
    </svg>
  )
}

function Preset3() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p3" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1d4ed8"/>
          <stop offset="100%" stopColor="#6d28d9"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p3)"/>
      <circle cx="70" cy="10" r="30" fill="rgba(255,255,255,0.05)"/>
      {/* Head */}
      <circle cx="40" cy="30" r="13" fill="rgba(255,255,255,0.9)"/>
      {/* Spiky/textured top */}
      <path d="M30 22 L27 14 L32 20 L36 11 L38 20 L40 12 L42 20 L44 11 L48 20 L53 14 L50 22 C50 16 30 16 30 22Z" fill="rgba(255,255,255,0.9)"/>
      {/* Body */}
      <path d="M16 74 C16 56 29 52 40 52 C51 52 64 56 64 74 Z" fill="rgba(255,255,255,0.9)"/>
    </svg>
  )
}

function Preset4() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p4" x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#0284c7"/>
          <stop offset="100%" stopColor="#7c3aed"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p4)"/>
      {/* Diamond accents */}
      <rect x="10" y="10" width="16" height="16" rx="2" transform="rotate(45 18 18)" fill="rgba(255,255,255,0.06)"/>
      {/* Head */}
      <circle cx="40" cy="30" r="13" fill="rgba(255,255,255,0.88)"/>
      {/* Modern short hair with undercut */}
      <path d="M27 28 L27 18 C27 12 53 12 53 18 L53 28 C53 20 27 20 27 28Z" fill="rgba(255,255,255,0.88)"/>
      {/* Body */}
      <path d="M16 75 C16 56 30 52 40 52 C50 52 64 56 64 75 Z" fill="rgba(255,255,255,0.88)"/>
      {/* Geometric shirt detail */}
      <polygon points="40,52 34,60 46,60" fill="rgba(2,132,199,0.3)"/>
    </svg>
  )
}

function Preset5() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p5" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c026d3"/>
          <stop offset="100%" stopColor="#7c3aed"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p5)"/>
      <ellipse cx="40" cy="80" rx="45" ry="30" fill="rgba(255,255,255,0.05)"/>
      {/* Head */}
      <circle cx="40" cy="30" r="13" fill="rgba(255,255,255,0.9)"/>
      {/* Long straight hair */}
      <rect x="26" y="20" width="6" height="32" rx="3" fill="rgba(255,255,255,0.9)"/>
      <rect x="48" y="20" width="6" height="32" rx="3" fill="rgba(255,255,255,0.9)"/>
      {/* Hair top */}
      <path d="M27 24 C27 14 53 14 53 24" fill="rgba(255,255,255,0.9)"/>
      {/* Body */}
      <path d="M16 74 C16 56 29 52 40 52 C51 52 64 56 64 74 Z" fill="rgba(255,255,255,0.9)"/>
    </svg>
  )
}

function Preset6() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p6" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#e11d48"/>
          <stop offset="100%" stopColor="#9333ea"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p6)"/>
      <circle cx="10" cy="10" r="20" fill="rgba(255,255,255,0.06)"/>
      {/* Head */}
      <circle cx="40" cy="30" r="13" fill="rgba(255,255,255,0.9)"/>
      {/* Wavy/curly hair */}
      <path d="M27 26 C25 14 32 10 40 11 C48 10 55 14 53 26" fill="rgba(255,255,255,0.9)"/>
      {/* Right side long wavy hair */}
      <path d="M51 24 C56 24 58 32 55 38 C53 44 52 48 50 52" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="5" strokeLinecap="round"/>
      {/* Left side */}
      <path d="M29 24 C24 24 22 32 25 38 C27 44 28 48 30 52" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="5" strokeLinecap="round"/>
      {/* Body */}
      <path d="M16 74 C16 56 29 52 40 52 C51 52 64 56 64 74 Z" fill="rgba(255,255,255,0.9)"/>
    </svg>
  )
}

function Preset7() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p7" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#a21caf"/>
          <stop offset="100%" stopColor="#6d28d9"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p7)"/>
      <circle cx="70" cy="70" r="25" fill="rgba(255,255,255,0.06)"/>
      {/* Head */}
      <circle cx="40" cy="31" r="13" fill="rgba(255,255,255,0.9)"/>
      {/* Top bun */}
      <circle cx="40" cy="15" r="7" fill="rgba(255,255,255,0.9)"/>
      <rect x="37" y="15" width="6" height="10" fill="rgba(255,255,255,0.9)"/>
      {/* Body */}
      <path d="M16 74 C16 56 29 53 40 53 C51 53 64 56 64 74 Z" fill="rgba(255,255,255,0.9)"/>
      {/* Earrings */}
      <circle cx="27" cy="33" r="2.5" fill="rgba(255,255,255,0.7)"/>
      <circle cx="53" cy="33" r="2.5" fill="rgba(255,255,255,0.7)"/>
    </svg>
  )
}

function Preset8() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className="w-full h-full">
      <defs>
        <linearGradient id="p8" x1="100%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#7c3aed"/>
          <stop offset="100%" stopColor="#db2777"/>
        </linearGradient>
      </defs>
      <rect width="80" height="80" fill="url(#p8)"/>
      <rect x="40" y="0" width="40" height="40" rx="20" fill="rgba(255,255,255,0.05)"/>
      {/* Head */}
      <circle cx="40" cy="30" r="13" fill="rgba(255,255,255,0.9)"/>
      {/* Shoulder-length hair with side part */}
      <path d="M26 24 C26 13 54 13 54 24" fill="rgba(255,255,255,0.9)"/>
      {/* Left side shoulder-length */}
      <path d="M26 24 C22 24 20 32 22 42 C24 48 26 52 28 54" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="6" strokeLinecap="round"/>
      {/* Right side */}
      <path d="M54 24 C58 24 60 32 58 42 C56 48 54 52 52 54" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="6" strokeLinecap="round"/>
      {/* Body */}
      <path d="M16 74 C16 56 29 52 40 52 C51 52 64 56 64 74 Z" fill="rgba(255,255,255,0.9)"/>
    </svg>
  )
}

const PRESET_COMPONENTS: Record<PresetId, React.FC> = {
  'preset:1': Preset1,
  'preset:2': Preset2,
  'preset:3': Preset3,
  'preset:4': Preset4,
  'preset:5': Preset5,
  'preset:6': Preset6,
  'preset:7': Preset7,
  'preset:8': Preset8,
}

// ─── Default gradient colours for initials avatar ────────────────────────────

const CQID_COLORS = [
  ['#7c3aed', '#a855f7'],
  ['#3730a3', '#6d28d9'],
  ['#1d4ed8', '#7c3aed'],
  ['#0284c7', '#7c3aed'],
  ['#c026d3', '#7c3aed'],
  ['#e11d48', '#9333ea'],
  ['#a21caf', '#6d28d9'],
  ['#7c3aed', '#db2777'],
]

function getInitials(name: string | null, cqid: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return parts[0].slice(0, 2).toUpperCase()
  }
  if (cqid) return cqid.replace('CQID', '').slice(0, 2)
  return '?'
}

function getColorIndex(cqid: string | null): number {
  if (!cqid) return 0
  const num = parseInt(cqid.replace('CQID', ''), 10)
  return isNaN(num) ? 0 : num % CQID_COLORS.length
}

// ─── Core component ──────────────────────────────────────────────────────────

interface EmployeeAvatarProps {
  avatarUrl?: string | null
  name?: string | null
  cqid?: string | null
  size?: number          // px — controls both width and height
  className?: string
  rounded?: 'full' | 'xl' | 'lg'
}

export function EmployeeAvatar({
  avatarUrl,
  name,
  cqid,
  size = 36,
  className = '',
  rounded = 'full',
}: EmployeeAvatarProps) {
  const [imgError, setImgError] = useState(false)

  const roundedCls = rounded === 'full' ? 'rounded-full' : rounded === 'xl' ? 'rounded-xl' : 'rounded-lg'

  // Custom photo (URL)
  if (avatarUrl && avatarUrl.startsWith('http') && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt={name || cqid || 'avatar'}
        width={size}
        height={size}
        onError={() => setImgError(true)}
        className={`object-cover shrink-0 ${roundedCls} ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  // Preset illustration
  if (avatarUrl && avatarUrl.startsWith('preset:')) {
    const PresetComp = PRESET_COMPONENTS[avatarUrl as PresetId]
    if (PresetComp) {
      return (
        <div
          className={`shrink-0 overflow-hidden ${roundedCls} ${className}`}
          style={{ width: size, height: size }}
        >
          <PresetComp />
        </div>
      )
    }
  }

  // Default: gradient circle with initials
  const initials = getInitials(name ?? null, cqid ?? null)
  const ci = getColorIndex(cqid ?? null)
  const [c1, c2] = CQID_COLORS[ci]

  return (
    <div
      className={`shrink-0 flex items-center justify-center font-bold text-white select-none ${roundedCls} ${className}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${c1}, ${c2})`,
        fontSize: Math.max(10, Math.round(size * 0.35)),
      }}
    >
      {initials}
    </div>
  )
}

// ─── Avatar Picker ────────────────────────────────────────────────────────────

interface AvatarPickerProps {
  value: string | null
  onChange: (url: string | null) => void
  name?: string | null
  cqid?: string | null
  onUpload?: (file: File) => Promise<string>   // returns the uploaded URL
}

export function AvatarPicker({ value, onChange, name, cqid, onUpload }: AvatarPickerProps) {
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { setUploadErr('Photo must be under 5 MB.'); return }
    if (!file.type.startsWith('image/')) { setUploadErr('Please choose an image file.'); return }
    if (!onUpload) { setUploadErr('Upload not configured.'); return }
    setUploadErr('')
    setUploading(true)
    try {
      const url = await onUpload(file)
      onChange(url)
    } catch (err: any) {
      setUploadErr(err?.message || 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  const malePresets   = AVATAR_PRESETS.filter(p => p.group === 'male')
  const femalePresets = AVATAR_PRESETS.filter(p => p.group === 'female')

  function PresetBtn({ preset }: { preset: typeof AVATAR_PRESETS[number] }) {
    const selected = value === preset.id
    return (
      <button
        type="button"
        onClick={() => onChange(preset.id)}
        title={preset.label}
        className={`relative rounded-xl overflow-hidden transition-all ${
          selected
            ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
            : 'ring-1 ring-border hover:ring-primary/50 hover:scale-105'
        }`}
        style={{ width: 52, height: 52 }}
      >
        <EmployeeAvatar avatarUrl={preset.id} name={name} cqid={cqid} size={52} rounded="lg" />
        {selected && (
          <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
            <svg className="w-5 h-5 text-white drop-shadow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </button>
    )
  }

  return (
    <div className="space-y-4">
      {/* Preview */}
      <div className="flex items-center gap-4">
        <EmployeeAvatar avatarUrl={value} name={name} cqid={cqid} size={64} rounded="xl" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">Profile photo</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose a preset or upload your own photo (optional)
          </p>
        </div>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
          >
            Remove
          </button>
        )}
      </div>

      {/* Male-style presets */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
          Style A
        </p>
        <div className="flex gap-2 flex-wrap">
          {malePresets.map(p => <PresetBtn key={p.id} preset={p} />)}
        </div>
      </div>

      {/* Female-style presets */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
          Style B
        </p>
        <div className="flex gap-2 flex-wrap">
          {femalePresets.map(p => <PresetBtn key={p.id} preset={p} />)}
        </div>
      </div>

      {/* Custom upload */}
      {onUpload && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
            Custom photo
          </p>
          <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
            </svg>
            {uploading ? 'Uploading…' : 'Upload photo (JPG, PNG — max 5 MB)'}
            <input type="file" accept="image/*" className="sr-only" onChange={handleFile} disabled={uploading} />
          </label>
          {uploadErr && (
            <p className="text-xs text-destructive mt-1">{uploadErr}</p>
          )}
        </div>
      )}
    </div>
  )
}
