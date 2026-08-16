export function resolveBrandingUrl(val: string | null | undefined): string {
  if (!val) return ''
  if (val.startsWith('data:image/')) return val
  if (val.startsWith('http://') || val.startsWith('https://')) return val
  if (val.startsWith('storage:')) {
    const path = val.replace('storage:', '')
    // Assuming format: bucket/path/to/file
    const parts = path.split('/')
    const bucket = parts[0]
    const file = parts.slice(1).join('/')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    return `${url}/storage/v1/object/public/${bucket}/${file}`
  }
  return val
}
