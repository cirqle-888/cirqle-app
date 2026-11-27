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
 *
 * It then runs a second, stronger check (scripts/name-reads.mjs): no file may
 * READ an employee's name from the database unless it is on the short list
 * below. Rendering is the last place a leak can be caught; loading is the first.
 */
import { ESLint } from 'eslint'
import { findNameReads } from './name-reads.mjs'

const eslint = new ESLint({ errorOnUnmatchedPattern: false })
const results = await eslint.lintFiles(['src'])

const leaks = results.flatMap(r =>
  (r.messages || [])
    .filter(m => m.ruleId === 'no-restricted-syntax')
    .map(m => ({ file: r.filePath.replace(`${process.cwd()}/`, ''), line: m.line, column: m.column, message: m.message })),
)

// ── Second gate: nobody may LOAD a name ──────────────────────────────────────
//
// The lint above only sees a name at the moment it is rendered, and only in
// the shapes it knows. A name that has been loaded can still leak as a prop
// called `firstName`, a toast, a notification, an export — which is how
// "Nothing assigned to you yet, <name>" reached My Work. So the build also
// fails when any file READS an employee's name from the database, unless that
// file is listed here with the reason it genuinely needs one.
//
// The app identifies people by CQID. To label a person, select `cqid`. If a
// consumer insists on a `name` key, `name:cqid` in the select gives it the
// CQID under that key. Do not add a file to this list to make the build pass:
// every entry is a place a real name exists, and the list is meant to shrink.
//
// `reads` is the exact number of name reads allowed in that file, so a second
// read added to an already-listed file is caught too.
const NAME_READ_ALLOWED = [
  { file: 'src/app/(auth)/register/[token]/page.tsx', reads: 2,
    why: 'The invitee completing their own registration sees and confirms their own record.' },
  { file: 'src/app/(dashboard)/dashboard/employees/[id]/page.tsx', reads: 1,
    why: 'The HR record page for one employee — the record is the name.' },
  { file: 'src/app/(dashboard)/dashboard/settings/page.tsx', reads: 1,
    why: 'Settings → Employees: the form where an admin creates and edits staff records.' },
  { file: 'src/app/(dashboard)/dashboard/settings/actions.ts', reads: 2,
    why: 'Saving an employee record returns the saved row to that same form.' },
  { file: 'src/app/(dashboard)/dashboard/import/employee-data-actions.ts', reads: 3,
    why: 'Admin export / import of the full employee records.' },
  { file: 'src/app/(dashboard)/dashboard/payroll/page.tsx', reads: 1,
    why: 'Reads every pay column; the name is stripped on the server before the list is passed on.' },
  { file: 'src/lib/payslip/actions.ts', reads: 1,
    why: 'A payslip is a personal document addressed to the employee.' },
  { file: 'src/lib/payslip/build-payslip.ts', reads: 1,
    why: 'A payslip is a personal document addressed to the employee.' },
  { file: 'src/lib/whatsapp-listener/insights-run.ts', reads: 1,
    why: 'Matches a name a client typed in WhatsApp to the employee to alert. Compared on the server, never output.' },
]

const allowed = new Map(NAME_READ_ALLOWED.map(a => [a.file, a]))
const readsByFile = new Map()
for (const r of findNameReads()) (readsByFile.get(r.file) ?? readsByFile.set(r.file, []).get(r.file)).push(r)

const nameReads = []
for (const [file, list] of readsByFile) {
  const rule = allowed.get(file)
  if (!rule) nameReads.push(...list)
  else if (list.length > rule.reads) {
    nameReads.push(...list.map(r => ({ ...r, detail: `${r.detail}  [${list.length} reads here, ${rule.reads} allowed]` })))
  }
}
// An entry whose file no longer reads a name should be deleted, so the list
// only ever describes what is true.
const stale = NAME_READ_ALLOWED.filter(a => !readsByFile.has(a.file))

if (nameReads.length > 0 || stale.length > 0) {
  if (nameReads.length > 0) {
    console.error(`\n✖ employee-name privacy gate: ${nameReads.length} place${nameReads.length === 1 ? '' : 's'} read an employee's real name\n`)
    for (const r of nameReads) console.error(`  ${r.file}:${r.line}\n    ${r.detail}\n`)
    console.error('People are identified by CQID. Select `cqid` (or `name:cqid`) instead of `name`.')
    console.error('Only a feature that truly needs the real name may be added to NAME_READ_ALLOWED')
    console.error('in scripts/check-name-privacy.mjs, with the reason.\n')
  }
  if (stale.length > 0) {
    console.error('\n✖ employee-name privacy gate: these allow-list entries no longer read a name — remove them:\n')
    for (const a of stale) console.error(`  ${a.file}`)
    console.error('')
  }
  process.exit(1)
}

if (leaks.length === 0) {
  console.log(`✓ employee-name privacy gate: no leaks (names are read in ${NAME_READ_ALLOWED.length} listed files only)`)
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
