import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

/**
 * CI guard: a read-only server action must not sit behind the WRITE guard.
 *
 * requirePermission refuses everything while an admin previews an employee
 * (view-as). That is correct for mutations and wrong for reads, and when a
 * read is caught by it the preview does not show less — it shows the app
 * BROKEN. The invoice panel spun on "Loading line items…" forever and its PDF
 * rendered a total with no line items, which is a document that must never
 * exist. Someone reasonably concluded the previewed role could not see
 * invoices; it holds billing.view_invoices and can.
 *
 * A preview that lies is worse than no preview, because people act on it. This
 * test is what keeps the next read-only action from re-introducing that.
 */

const ROOT = process.cwd()

/** Functions that read from the caller's side but hand out a WRITE capability.
 *  A signed upload URL is a write with a delay, so it stays on requirePermission. */
const ALLOWED_ON_WRITE_GUARD = new Set([
  'getRefUploadUrl',           // storage upload URL — social calendar references
  'getProductImageUploadUrl',  // storage upload URL — catalog product photos
])

const READ_NAME = /^(get|list|fetch|load|search|count)[A-Z]/
const WRITE_CALL = /\.(insert|update|upsert|delete)\s*\(|logActivity|createNotification|sendWebPush|revalidate(Path|Tag)|sendEmail/
const WRITE_GUARD = /await\s+require(Permission|AnyPermission)\(/
const FN = /^export async function\s+(\w+)/

function actionFiles(): string[] {
  return execFileSync('grep', ['-rl', 'requirePermission\\|requireAnyPermission', 'src', '--include=*.ts'],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
}

describe('read-only actions use the read guard', () => {
  it('no purely-reading action is behind requirePermission', () => {
    const offenders: string[] = []

    for (const file of actionFiles()) {
      const lines = readFileSync(`${ROOT}/${file}`, 'utf8').split('\n')
      const starts = lines.flatMap((l, i) => (FN.test(l) ? [i] : []))

      starts.forEach((start, n) => {
        const name = FN.exec(lines[start])![1]
        if (!READ_NAME.test(name) || ALLOWED_ON_WRITE_GUARD.has(name)) return
        const body = lines.slice(start, starts[n + 1] ?? lines.length).join('\n')
        if (!WRITE_GUARD.test(body)) return
        // Writes somewhere in the body mean it is not a read after all.
        if (WRITE_CALL.test(body)) return
        offenders.push(`${file}: ${name}`)
      })
    }

    expect(
      offenders,
      'These only read, but the write guard refuses them during a view-as preview,\n' +
      'which makes the preview show a broken app instead of a narrower one.\n' +
      'Switch to requireReadPermission / requireAnyReadPermission — or, if the\n' +
      'action hands out a write capability (e.g. a signed upload URL), add it to\n' +
      'ALLOWED_ON_WRITE_GUARD with the reason:\n  ' + offenders.join('\n  '),
    ).toEqual([])
  })

  it('mutations still go through the write guard', () => {
    // The other half: if someone "fixes" a failing preview by moving a real
    // mutation onto the read guard, view-as stops being read-only.
    const offenders: string[] = []
    for (const file of actionFiles()) {
      const lines = readFileSync(`${ROOT}/${file}`, 'utf8').split('\n')
      const starts = lines.flatMap((l, i) => (FN.test(l) ? [i] : []))
      starts.forEach((start, n) => {
        const name = FN.exec(lines[start])![1]
        const body = lines.slice(start, starts[n + 1] ?? lines.length).join('\n')
        if (!/await\s+require(Read|AnyRead)Permission\(/.test(body)) return
        if (WRITE_CALL.test(body)) offenders.push(`${file}: ${name}`)
      })
    }
    expect(
      offenders,
      'These use the READ guard but write. That makes view-as no longer read-only:\n  '
        + offenders.join('\n  '),
    ).toEqual([])
  })
})
