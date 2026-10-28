import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { PROMPT_SKILLS } from './skills'

const DIR = join(process.cwd(), 'skills')

describe('Prompt Studio skills', () => {
  it('skills.ts matches skills exactly (run node scripts/sync-prompt-skills.mjs)', () => {
    const folders = readdirSync(DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(DIR, d.name, 'SKILL.md')))
      .map(d => d.name).sort()
    expect(PROMPT_SKILLS.map(s => s.name).sort()).toEqual(folders)
    for (const s of PROMPT_SKILLS) {
      expect(s.content, s.name).toBe(readFileSync(join(DIR, s.name, 'SKILL.md'), 'utf8'))
    }
  })

  it('each skill has frontmatter whose name matches its folder and a description', () => {
    for (const s of PROMPT_SKILLS) {
      expect(s.content.startsWith('---\n'), s.name).toBe(true)
      expect(s.content).toMatch(new RegExp(`^name: ${s.name}$`, 'm'))
      expect(s.content).toMatch(/^description: .{20,1024}$/m)
    }
  })
})
