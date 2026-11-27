/**
 * Finds every place the code READS an employee's real name from the database.
 *
 * WHY: employee names are private — the app identifies people by CQID only.
 * The render-time lint (eslint.privacy.mjs) catches `{emp.name}` in JSX, but a
 * name that has been loaded can leak a hundred other ways: a prop called
 * `firstName`, a toast, a notification title, a WhatsApp message, an export.
 * That is how "Nothing assigned to you yet, Farooq" shipped. The only guarantee
 * that holds is upstream: code that never loads a name cannot show one.
 *
 * So this scans query strings, not renders. It reports:
 *   1. `.from('employees').select('… name …')`, `select('*')` and `select()`
 *   2. joined lookups that pull a name through an employee link, e.g.
 *      `sender:sender_id(name, cqid)` or `employee:employees(id, name)`
 *
 * A join counts as an employee join when it targets `employees`, when it also
 * selects `cqid` (only employees have one), or when its alias / foreign key is
 * named for a person (sender, assignee, created_by, …).
 *
 * Used by scripts/check-name-privacy.mjs (the build gate) and runnable alone:
 *   node scripts/name-reads.mjs          → prints every read
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const PERSON_LINK = /(employee|\bemp\b|user|person|worker|agent|sender|assignee|assigned|created_by|updated_by|deleted_by|author|actor|owner|designer|member|approved_by|approver|requested_by|decided_by|reviewer|reviewed_by|staff|recipient|uploaded_by|paid_by|recorded_by|submitted_by|captured_by|posted_by|closed_by|started_by|completed_by|invited_by|added_by|handled_by|manager|lead_owner|salesperson|referrer_employee|reporter|interviewer)/i

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Body of the parenthesis that opens at `open`, or null when unbalanced. */
function parenBody(src, open) {
  let depth = 0
  for (let i = open; i < Math.min(src.length, open + 6000); i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  return null
}

/** Column names at the top level of a select list (nested joins skipped). */
function topLevelColumns(body) {
  const cols = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; continue }
    if (depth === 0 && ch !== ')') cur += ch
  }
  cols.push(cur)
  return cols.map(c => c.replace(/\s+/g, '')).filter(Boolean)
}

/** True when a top-level column is the bare `name` (or `*`, or an alias of name). */
const readsName = cols => cols.some(c => c === 'name' || c === '*' || c.endsWith(':name'))
const lineOf = (src, index) => src.slice(0, index).split('\n').length

export function findNameReads(root = 'src', cwd = process.cwd()) {
  const reads = []
  for (const file of walk(join(cwd, root))) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(cwd, file)
    const seen = new Set()
    const add = (index, kind, detail, span) => {
      const line = lineOf(src, index)
      const key = `${line}:${kind}`
      if (seen.has(key)) return
      seen.add(key)
      reads.push({ file: rel, line, kind, detail: detail.replace(/\s+/g, ' ').trim().slice(0, 90), span })
    }

    // 1. Direct reads of the employees table.
    for (const m of src.matchAll(/from\(\s*['"`]employees['"`]\s*\)/g)) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 700)
      // Only the select that belongs to THIS chain — stop at the next statement.
      const chain = after.split(/\n\s*\n|;\s*\n|\bawait\b/)[0]
      const sel = chain.match(/\.select\(\s*(?:([`'"])([\s\S]*?)\1)?\s*(?:,[^)]*)?\)/)
      if (!sel) continue
      if (sel[2] === undefined) {
        // `.select()` with no argument returns every column; a variable is unknown.
        if (/\.select\(\s*\)/.test(sel[0])) add(m.index, 'table', 'select() — every column')
        continue
      }
      if (readsName(topLevelColumns(sel[2]))) {
        const start = m.index + m[0].length + chain.indexOf(sel[0]) + sel[0].indexOf(sel[2])
        add(m.index, 'table', sel[2], [start, start + sel[2].length])
      }
    }
    // A select list held in a variable: flag the variable's own definition.
    for (const m of src.matchAll(/from\(\s*['"`]employees['"`]\s*\)[\s\S]{0,200}?\.select\(\s*([A-Za-z_$][\w$.]*)\s*[,)]/g)) {
      add(m.index, 'table', `select(${m[1]}) — column list in a variable`)
    }

    // 2. Joined lookups: alias:target!hint( … ) / target( … )
    for (const m of src.matchAll(/(?:([A-Za-z_][\w]*)\s*:\s*)?([A-Za-z_][\w]*)((?:![A-Za-z_][\w]*)*)\s*\(/g)) {
      const [whole, alias = '', target, hint = ''] = m
      const open = m.index + whole.length - 1
      // Must sit inside a string (a select list), not be a function call.
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const before = src.slice(lineStart, m.index)
      const inTemplate = (src.slice(0, m.index).split('`').length - 1) % 2 === 1
      const inQuote = ((before.split("'").length - 1) % 2 === 1) || ((before.split('"').length - 1) % 2 === 1)
      if (!inTemplate && !inQuote) continue
      const body = parenBody(src, open)
      if (body === null || /[;{}=]|=>/.test(body)) continue
      const cols = topLevelColumns(body)
      if (!cols.length || !cols.every(c => /^[\w:*!.>-]+$/.test(c))) continue
      if (!readsName(cols)) continue
      // A plain table name (ownership_programs, designations) is judged by what
      // it is, not by an alias that happens to contain "owner". Only a foreign
      // key column (`sender_id`, `created_by`, `assigned_to`) is judged by name.
      const isFk = /(_id|_by|_to)$/.test(target)
      const label = `${alias} ${target} ${hint}`
      const isEmployee = target === 'employees' || cols.includes('cqid')
        || (isFk && PERSON_LINK.test(label) && !/designation|program|client|service|categor|department|brand|account/i.test(target))
      if (!isEmployee) continue
      add(m.index, 'join', `${alias ? `${alias}:` : ''}${target}${hint}(${body})`, [open + 1, open + 1 + body.length])
    }
  }
  return reads.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reads = findNameReads()
  let last = ''
  for (const r of reads) {
    if (r.file !== last) { console.log(r.file); last = r.file }
    console.log(`  ${String(r.line).padStart(5)}  ${r.kind.padEnd(5)}  ${r.detail}`)
  }
  console.log(`\n${reads.length} reads in ${new Set(reads.map(r => r.file)).size} files`)
}
