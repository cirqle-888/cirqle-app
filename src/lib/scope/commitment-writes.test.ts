/**
 * REGRESSION GUARD for commitment write paths.
 *
 * Two invariants protect historical money, and both are easy to break with a
 * one-character edit:
 *
 *   1. NEVER write `commission_percentage: 0` to mean "unset". Every reader
 *      guards with `?? 50` or `!= null`; neither catches 0, so a 0 is a REAL
 *      rate that collapses the pair's commission pool and rewrites earnings
 *      already booked against it.
 *   2. NEVER hard-DELETE a client_service_pricing row. It carries the agreed
 *      price that historical commission recompute still reads.
 *
 * These assert on source text because the failure is a silent value change in
 * production, long after any behavioural test would have passed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** Every file that writes client_service_pricing. */
const WRITE_PATHS = [
  'src/components/ui/client-edit-modal.tsx',
  'src/app/(dashboard)/dashboard/settings/settings-client.tsx',
  'src/app/(dashboard)/dashboard/settings/actions.ts',
  'src/app/(dashboard)/dashboard/pricing-matrix/pricing-matrix-client.tsx',
  'src/app/(dashboard)/dashboard/tasks/tasks-client.tsx',
  'src/app/(dashboard)/dashboard/import/import-client.tsx',
  'src/app/(dashboard)/dashboard/reports/what-if/apply-actions.ts',
]

describe('no write path coerces commission_percentage to 0', () => {
  it.each(WRITE_PATHS)('%s', file => {
    const src = read(file)
    // The exact shapes that caused the incident: a literal 0, or `|| 0` / `?? 0`
    // applied to a commission value.
    expect(src).not.toMatch(/commission_percentage:\s*0\b/)
    expect(src).not.toMatch(/commission_percentage:\s*[^,\n]*\|\|\s*0\b/)
    expect(src).not.toMatch(/commission_percentage:\s*[^,\n]*\?\?\s*0\b/)

    // The above only sees the assignment LINE, so the incident is
    // reintroducible by laundering the value through a local:
    //   const cp = Number(c.to) || 0
    //   … commission_percentage: cp
    // An audit proved that exact mutation survives. Follow one level of
    // indirection: whatever identifier is assigned, check how it was defined.
    // Terminator includes `}` and `)`: an inline object literal
    // `{ commission_percentage: cp }` has neither a comma nor a newline after
    // the identifier, and that mutation survived a narrower match.
    for (const [, ident] of src.matchAll(/commission_percentage:\s*([A-Za-z_$][\w$]*)\s*[,\n})]/g)) {
      if (ident === 'null' || ident === 'undefined') continue
      for (const [, init] of src.matchAll(
        new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*([^\\n]+)`, 'g')
      )) {
        expect(init, `${ident} feeds commission_percentage but coerces to 0`).not.toMatch(/(\|\||\?\?)\s*0\b/)
      }
    }
  })
})

describe('no write path hard-deletes a commitment row', () => {
  it.each(WRITE_PATHS)('%s', file => {
    const src = read(file)
    // Walk the FULL chain from each .from('client_service_pricing') to its
    // statement end. A fixed lookahead window (the previous `{0,80}`) is
    // walked past by inserting a few .eq() calls before the .delete() — an
    // audit confirmed that mutation survives.
    for (let i = src.indexOf("from('client_service_pricing')"); i !== -1;
         i = src.indexOf("from('client_service_pricing')", i + 1)) {
      const lines = src.slice(i).split('\n')
      const chain = [lines[0]]
      for (const line of lines.slice(1)) {
        if (!/^\s*[.)]/.test(line)) break      // chain ended
        chain.push(line)
      }
      // `\s*` before the paren: `.delete( )` with a space also survived.
      expect(chain.join('\n'), 'hard delete on a commitment row').not.toMatch(/\.delete\s*\(/)
    }
  })

  it('the import Clean-up tab special-cases pricing_matrix before its generic delete', () => {
    const src = read('src/app/(dashboard)/dashboard/import/import-client.tsx')
    const guard = src.indexOf("cleanupMode === 'pricing_matrix'")
    const genericDelete = src.indexOf("batchDelete(TABLE_FOR_MODE[cleanupMode]")
    expect(guard).toBeGreaterThan(-1)
    expect(genericDelete).toBeGreaterThan(-1)
    // The deactivation branch must come first AND return, or the generic
    // hard delete below would still run for commitments.
    expect(guard).toBeLessThan(genericDelete)
  })
})

describe('the backfill script preserves historical commission', () => {
  const src = read('scripts/seed-client-commitments.mjs')

  /**
   * The row literal passed to `.from('client_service_pricing').insert(` — the
   * only place a NEW commitment row is born, and therefore the only place the
   * DB DEFAULT 0 can apply. Extracted by brace-matching from the call site so
   * assertions cannot be satisfied by an unrelated occurrence elsewhere.
   */
  const insertObject = (() => {
    const call = src.indexOf(".from('client_service_pricing').insert(")
    expect(call).toBeGreaterThan(-1)
    const open = src.indexOf('{', src.indexOf('=> (', call))
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
    }
    throw new Error('unbalanced braces in the insert row literal')
  })()

  it('writes commission_percentage explicitly as null on new rows', () => {
    // Explicit null, never omitted: the column DEFAULTs to 0, which is the one
    // value that destroys history.
    //
    // MUST be scoped to the insert. A file-wide /commission_percentage:\s*null/
    // is satisfied by the audit payload two lines below, so deleting the null
    // from the insert — restoring the exact defect this guards — left the test
    // green. Mutation-tested: removing line 307 now fails.
    expect(insertObject).toMatch(/commission_percentage:\s*null/)
  })

  it('never inserts a literal 0 commission', () => {
    expect(src).not.toMatch(/commission_percentage:\s*0\b/)
  })

  it('deactivates rather than deletes', () => {
    expect(src).toMatch(/is_active:\s*false/)
    expect(src).not.toMatch(/\.delete\s*\(/)
  })

  it('chunks id-list updates so a large batch cannot exceed the request limit', () => {
    expect(src).toMatch(/CHUNK\s*=\s*\d+/)
    expect(src).toMatch(/for \(let i = 0; i < ids\.length; i \+= CHUNK\)/)
  })

  it('audits inside the chunk loop, not after it', () => {
    // The audit table is append-only, so a trail lost to a crash between the
    // last UPDATE and a deferred audit call can never be reconstructed — rows
    // would be silently changed with no record. The write must be audited
    // before the next chunk is attempted.
    const fn = src.indexOf('async function chunkedUpdate(')
    const body = src.slice(fn, src.indexOf('\n}', fn))
    const loop = body.indexOf('for (let i = 0')
    const audit = body.indexOf('await writeAudit(')
    // The FUNCTION's return, i.e. the last one — there is now also an early
    // `return { ... halted: true }` on a row-count mismatch, which sits before
    // the audit by design.
    const ret = body.lastIndexOf('return {')
    expect(loop).toBeGreaterThan(-1)
    expect(audit).toBeGreaterThan(loop)   // inside the loop…
    expect(audit).toBeLessThan(ret)       // …not after it
  })

  it('audits every apply path', () => {
    // create writes directly; reactivate/deactivate go through chunkedUpdate
    // and must each hand it an auditFor callback — omitting one would apply
    // hundreds of rows with no trail.
    const apply = src.slice(src.indexOf('// ── Apply'))
    expect([...apply.matchAll(/await writeAudit\(/g)]).toHaveLength(1)
    expect([...apply.matchAll(/slice => slice\.map/g)]).toHaveLength(2)
  })

  it('carries the intake-preservation guardrail', () => {
    expect(src).toMatch(/intake[- ]preservation guardrail/i)
    expect(src).toMatch(/intakeKind/)
  })
})

/**
 * SAFETY MECHANISMS OF THE BACKFILL.
 *
 * Every assertion here exists because a mutation SURVIVED without it — the
 * protection was real in the code but nothing stopped a future edit from
 * silently removing it. Each `it` names the mutation it now catches.
 */
describe('backfill safety mechanisms are locked in', () => {
  const src = read('scripts/seed-client-commitments.mjs')

  const fnBody = (name: string) => {
    const i = src.indexOf(`function ${name}(`)
    expect(i, `${name} not found`).toBeGreaterThan(-1)
    return src.slice(i, src.indexOf('\n}', i))
  }
  /**
   * Comments quote the very defects these tests forbid (e.g. the comment
   * explaining why `ok += slice.length` was wrong). Assert on CODE only, or a
   * negative assertion matches the prose describing the bug it guards against.
   */
  const code = (s: string) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  it('CHUNK stays within the PostgREST request-header limit', () => {
    // Mutation that survived: CHUNK 200 -> 5000. The old test asserted only
    // that `CHUNK = <digits>` existed, never the VALUE — but a .in() list past
    // ~400 ids overflows the 16KB request line and PostgREST answers 400.
    const m = src.match(/const CHUNK = (\d+)/)
    expect(m).toBeTruthy()
    const chunk = Number(m![1])
    expect(chunk).toBeGreaterThan(0)
    expect(chunk).toBeLessThanOrEqual(400)
  })

  it('paginates with a stable order', () => {
    // Mutation that survived: deleting `.order('id')` from fetchAll. An
    // unordered range() scan may return rows in a different order per page,
    // so rows get skipped or duplicated — silently producing the WRONG
    // deactivation set.
    const body = fnBody('fetchAll')
    expect(body).toMatch(/\.order\(\s*['"]id['"]/)
    expect(body).toMatch(/\.range\(/)
  })

  it('verifies how many rows an update actually changed', () => {
    // Mutation that survived: dropping `.select('id')` and counting the
    // REQUESTED ids instead of the returned ones. Without it the run reports
    // "625 deactivated" whether or not 625 rows moved.
    const body = code(fnBody('chunkedUpdate'))
    expect(body).toMatch(/\.select\(\s*['"]id['"]\s*\)/)
    expect(body).toMatch(/const changedIds = \(data \|\| \[\]\)\.map\(r => r\.id\)/)
    expect(body).toMatch(/const changed = changedIds\.length/)
    expect(body).toMatch(/ok \+= changed/)
    expect(body, 'must not count requested ids as changed').not.toMatch(/ok \+= slice\.length/)
  })

  it('aborts when an evidence source fails for any reason but a missing table', () => {
    // Mutation that survived: restoring `catch { return [] }`. That turns a
    // transient 5xx or an RLS change into "this source proved nothing", which
    // moves every pair it would have evidenced into the deactivate set.
    const body = code(fnBody('tryFetch'))
    expect(body).toMatch(/does not exist|42P01|PGRST205/)   // missing table tolerated
    expect(body).toMatch(/process\.exit\(1\)/)              // anything else aborts
    expect(body, 'bare swallow-all catch').not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*return \[\]\s*\}/)
  })

  it('preserves the last commitment of an intake kind — the loop, not just the comment', () => {
    // Mutation that survived: deleting the entire guardrail loop. The old test
    // grepped only the COMMENT text and the word `intakeKind`, both of which
    // survive deletion of the code they describe.
    expect(src).toMatch(/for \(let i = toDeactivate\.length - 1; i >= 0; i--\)/)
    expect(src).toMatch(/intakeKind\.get\(row\.service_id\)/)
    expect(src).toMatch(/stillHasKind/)
    expect(src).toMatch(/toDeactivate\.splice\(i, 1\)/)   // it is actually spared
    expect(src).toMatch(/preserved\.push\(/)
    expect(src).toMatch(/addAfter\(row\.client_id, row\.service_id\)/)  // and stays committed
  })

  it('audits the rows the DB reported changed, never the requested slice', () => {
    // A chunk of 200 that updates only 180 would otherwise write 200 audit
    // rows claiming 200 deactivations. service_scope_audit is append-only, so
    // those 20 false records are permanent and can never be corrected.
    const body = code(fnBody('chunkedUpdate'))
    expect(body).toMatch(/const changedIds = \(data \|\| \[\]\)\.map\(r => r\.id\)/)
    expect(body).toMatch(/writeAudit\(auditFor\(changedIds\)\)/)
    expect(body, 'must not audit the requested slice').not.toMatch(/auditFor\(slice\)/)
    // …and a mismatch must HALT, not warn-and-continue. Assert the mismatch
    // branch itself returns halted — `halted: true` alone also appears in the
    // audit-failure branch, so a bare match survives deleting this check.
    const mismatch = body.indexOf('if (changed !== slice.length)')
    expect(mismatch).toBeGreaterThan(-1)
    const branch = body.slice(mismatch, body.indexOf('ok += changed', mismatch))
    expect(branch).toMatch(/halted: true/)
    expect(branch).toMatch(/return \{/)
  })

  it('verifies how many rows the create actually inserted', () => {
    // Same discipline chunkedUpdate already enforces: count what the DB
    // returned, not what was asked for.
    const apply = code(src.slice(src.indexOf('// ── Apply')))
    expect(apply).toMatch(/\.select\(\s*['"]id['"]\s*\)/)
    expect(apply).toMatch(/const insertedCount = \(inserted \|\| \[\]\)\.length/)
    expect(apply, 'must not count requested rows as created').not.toMatch(/created \+= slice\.length/)
  })

  it('the recovery note does not prescribe a hard DELETE', () => {
    // The note is an operator runbook. Telling someone to DELETE the created
    // pairs contradicts the invariant the whole design rests on — the row
    // carries the agreed price historical recompute still reads.
    const note = src.slice(src.indexOf('note:'), src.indexOf('deactivateIds:'))
    expect(note).toMatch(/do NOT DELETE/i)
    expect(note).toMatch(/deactivated_at=NULL/i)   // revival must clear the stamp
  })

  it('writes the recovery file before the first mutation', () => {
    // Mutation that survived: deleting recovery generation outright. Undo
    // would then depend on the append-only audit table having succeeded, and
    // the 5 created rows carry no marker distinguishing them.
    const write = src.indexOf('writeFileSync(recoveryPath')
    expect(write).toBeGreaterThan(-1)
    expect(src).toMatch(/import \{[^}]*writeFileSync[^}]*\} from ['"]fs['"]/)

    // It must contain enough to undo everything…
    const payload = src.slice(write, src.indexOf('}, null, 2))', write))
    expect(payload).toMatch(/deactivateIds/)
    expect(payload).toMatch(/reactivateIds/)
    expect(payload).toMatch(/created/)

    // …and land before ANY write to the database.
    const firstWrite = Math.min(
      ...[/\.insert\(/, /\.update\(/, /chunkedUpdate\(/]
        .map(re => { const m = src.slice(src.indexOf('// ── Apply')).search(re); return m === -1 ? Infinity : m + src.indexOf('// ── Apply') })
    )
    expect(write).toBeLessThan(firstWrite)
  })
})

describe('audit logging reports its own failures', () => {
  const src = read('src/lib/scope/audit.ts')
  const body = src.slice(src.indexOf('export async function logScopeChanges'))

  it('inspects the error supabase-js RESOLVES with', () => {
    // Mutation that survived: replacing `if (!error)` with `if (true)`, so the
    // error is computed and discarded. supabase-js resolves rather than
    // rejects on a DB failure, so nothing else would notice.
    expect(body).toMatch(/const \{ error \} = await/)
    expect(body).toMatch(/if \(!error\) return/)
    expect(body, 'error check short-circuited').not.toMatch(/if \(true\)/)
    expect(body).toMatch(/return \{ written, error: message \}/)
  })

  it('retries per row so one illegal action cannot discard legal rows', () => {
    // A batch insert is ONE statement: a single CHECK violation rolls back
    // every row with it.
    expect(body).toMatch(/for \(const row of rows\)/)
    expect(body).toMatch(/rowError/)
  })
})
