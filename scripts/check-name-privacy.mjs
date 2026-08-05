#!/usr/bin/env node
/**
 * Employee-name privacy gate — runs before every `npm run build`.
 *
 * WHY THIS EXISTS: the ESLint rule that forbids rendering `emp.name` has been
 * in the repo for a while, but `next build` does not run ESLint, so a leak
 * could ship as long as nobody ran `npm run lint` by hand. That is exactly how
 * a name leak reached the social-calendar designer picker. This script closes
 * the loop: the build itself now fails on a name leak.
 *
 * It runs the PROJECT'S OWN ESLint config (so every documented exemption and
 * `eslint-disable-next-line` reason keeps working) and then reports only
 * `no-restricted-syntax` findings. The repo's unrelated pre-existing lint debt
 * therefore never blocks a deploy — only a privacy regression does.
 */
import { ESLint } from 'eslint'

const eslint = new ESLint({ errorOnUnmatchedPattern: false })
const results = await eslint.lintFiles(['src'])

const leaks = results.flatMap(r =>
  (r.messages || [])
    .filter(m => m.ruleId === 'no-restricted-syntax')
    .map(m => ({ file: r.filePath.replace(`${process.cwd()}/`, ''), line: m.line, column: m.column, message: m.message })),
)

if (leaks.length === 0) {
  console.log('✓ employee-name privacy gate: no leaks')
  process.exit(0)
}

console.error(`\n✖ employee-name privacy gate: ${leaks.length} leak${leaks.length === 1 ? '' : 's'}\n`)
for (const l of leaks) {
  console.error(`  ${l.file}:${l.line}:${l.column}`)
  console.error(`    ${l.message}\n`)
}
console.error('Employee names must never render. Show the CQID instead, and prefer')
console.error('not selecting `name` from the database for features that only need IDs.\n')
process.exit(1)
