// Regenerates src/lib/prompt-studio/skills.ts from skills/<name>/SKILL.md.
// Keeps title/summary from the existing skills.ts; a new skill folder gets its
// frontmatter name as title and its description as summary (edit after).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const DIR = join(ROOT, 'skills')
const OUT = join(ROOT, 'src/lib/prompt-studio/skills.ts')

const old = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
const meta = {}
for (const m of old.matchAll(/name: ("[^"]+"), title: ("(?:[^"\\]|\\.)*"), summary: ("(?:[^"\\]|\\.)*")/g)) {
  meta[JSON.parse(m[1])] = { title: JSON.parse(m[2]), summary: JSON.parse(m[3]), order: Object.keys(meta).length }
}
const names = readdirSync(DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(DIR, d.name, 'SKILL.md')))
  .map(d => d.name)
  .sort((a, b) => (meta[a]?.order ?? 999) - (meta[b]?.order ?? 999) || a.localeCompare(b))

const rows = names.map(n => {
  const md = readFileSync(join(DIR, n, 'SKILL.md'), 'utf8')
  const desc = (md.match(/^description:\s*(.+)$/m) || [])[1] || ''
  const { title = n, summary = desc } = meta[n] || {}
  return `  { name: ${JSON.stringify(n)}, title: ${JSON.stringify(title)}, summary: ${JSON.stringify(summary)},\n    content: ${JSON.stringify(md)} },`
})

const head = old.slice(0, old.indexOf('export const PROMPT_SKILLS')) ||
  "export interface PromptSkill { name: string; title: string; summary: string; content: string }\n\n"
writeFileSync(OUT, `${head}export const PROMPT_SKILLS: PromptSkill[] = [\n${rows.join('\n')}\n]\n`)
console.log(`skills.ts: ${names.length} skills`)
