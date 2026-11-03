import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * A 'use server' module may export async functions and nothing else.
 *
 * Next.js checks this when the module loads, not at build or type-check time,
 * and the failure is not local to the offending export: the module throws, so
 * every server action bundled with it fails with a 500. `lib/templates/actions.ts`
 * exported its built-in template list, and on the Requests page that turned
 * every action — the timeline included — into an error, leaving each request's
 * Activity on "Loading…" for good. Typecheck and the tests were green throughout.
 *
 * Types are fine (they are erased), so `export type` / `export interface` pass.
 * A value that callers need belongs in a plain module beside the actions.
 */

const SRC = join(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** File-level directive: the first statement, after comments. */
function isUseServerModule(src: string): boolean {
  const body = src.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*\n|\s)*/, '')
  return /^['"]use server['"]/.test(body)
}

/** `export` lines that are not an async function or a type. */
function badExports(src: string): string[] {
  return src.split('\n').filter(line =>
    /^export\s/.test(line)
    && !/^export\s+async\s+function\b/.test(line)
    && !/^export\s+(type|interface)\b/.test(line)
    && !/^export\s+(declare\s+)?(type|interface)\b/.test(line),
  )
}

describe("'use server' modules export only async functions", () => {
  const files = walk(SRC).filter(f => isUseServerModule(readFileSync(f, 'utf8')))

  it('finds the server-action modules', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files.map(f => [relative(process.cwd(), f), f]))('%s', (_rel, file) => {
    expect(badExports(readFileSync(file, 'utf8'))).toEqual([])
  })
})
