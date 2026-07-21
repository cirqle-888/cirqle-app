#!/usr/bin/env node
/**
 * Import the produce library (Malayalam + English names, transparent/shadow
 * cut-outs) from the shared Google Sheet into product_catalog.
 *
 * DRY RUN BY DEFAULT — prints exactly what it would create/update and changes
 * nothing. Pass --confirm to actually apply it.
 *
 *   node scripts/import-produce-library.mjs
 *   node scripts/import-produce-library.mjs --confirm
 *   node scripts/import-produce-library.mjs --category=Fruits --confirm
 *
 * Idempotent: a second run reports 0 new and never duplicates image rows.
 * Existing products are matched case-insensitively on the English name and are
 * only ever enriched — the jsonb `names` map is merged, and category/image_url
 * are filled in only when they are currently empty.
 */

import { readFileSync } from 'node:fs'

const CONFIRM = process.argv.includes('--confirm')
const CATEGORY_OVERRIDE =
  process.argv.find(a => a.startsWith('--category='))?.slice('--category='.length) || null

/**
 * The source sheet mixes fruit and vegetables in one list with no category
 * column, so a single --category would mislabel roughly half of it. These are
 * the fruit names as they appear in the sheet (matched case-insensitively on
 * the part before any bracket, so "Mango (Neelan)" follows "Mango").
 *
 * The dry run prints the resulting split so it can be eyeballed and corrected
 * before anything is written — this list is a starting point, not an authority.
 */
const FRUIT_NAMES = new Set([
  // "Butter" is butter fruit — avocado, not dairy. Confirmed by opening the
  // sheet's own image for that row.
  'butter',
  'anar', 'apple', 'banana', 'burthukal', 'chikku', 'citrus', 'dates',
  'dragon fruit', 'elantha pazham', 'goosberries', 'grape', 'green mango',
  'kannimanga', 'lemon', 'mango', 'musambi', 'orange', 'pappaya', 'perakka',
  'pineapple', 'rambutan', 'robust', 'robust yellow', 'seetha pazham', 'shamam',
  'sotha mango', 'strawberry', 'strawberry box', 'watermelon', 'watermelon yellow',
])

/** Anything not a fruit is treated as a vegetable, except the few oddities. */
const NOT_PRODUCE = new Set(['kada mutta'])  // quail eggs — neither

function categoryFor(name) {
  if (CATEGORY_OVERRIDE) return CATEGORY_OVERRIDE
  const base = name.toLowerCase().split('(')[0].trim()
  if (NOT_PRODUCE.has(base)) return 'Other'
  return FRUIT_NAMES.has(base) ? 'Fruits' : 'Vegetables'
}

const SHEET_CSV =
  'https://docs.google.com/spreadsheets/d/1o_q8jA4N6AE5s8D_2ZsoWKOrZecTEC5RILUAIspkPUs/gviz/tq?tqx=out:csv&sheet=Products'

/** The migration that adds product_catalog.names / review_status and the new image versions. */
const REQUIRED_MIGRATION = '20260719140000_produce_library.sql'

// ── env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = { ...process.env }
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* rely on the ambient environment */ }
  return env
}

const env = loadEnv()
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE
if (!URL_BASE || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : []
}

// ── sheet ────────────────────────────────────────────────────────────────────

/** Minimal RFC4180 reader — no dependency, and the sheet has quoted commas. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

/** "Englsih" is misspelled in the source sheet; accept either spelling. */
const HEADER_ALIASES = {
  malayalam: ['malayalam', 'ml', 'local name'],
  english: ['englsih', 'english', 'name', 'product', 'item'],
  transparent: ['transparent'],
  shadow: ['shadow'],
}

function mapHeaders(header) {
  const index = {}
  header.forEach((raw, i) => {
    const cleaned = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ')
    if (!cleaned) return
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (index[field] === undefined && aliases.includes(cleaned)) index[field] = i
    }
  })
  return index
}

const isHttpUrl = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim())

async function fetchSheetRows() {
  let res
  try {
    res = await fetch(SHEET_CSV, { redirect: 'follow' })
  } catch (err) {
    throw new Error(`Could not reach the Google Sheet export: ${err.message}`)
  }
  if (!res.ok) {
    throw new Error(
      `Sheet export returned HTTP ${res.status}. Check the sheet is still link-shared ("Anyone with the link").`,
    )
  }
  const body = await res.text()
  const looksHtml = /^\s*</.test(body) || /<html/i.test(body.slice(0, 500))
  if (looksHtml) {
    throw new Error(
      'Sheet export returned an HTML page, not CSV — this is Google\'s sign-in/permission page.\n' +
      'The sheet is no longer publicly readable. Re-share it as "Anyone with the link → Viewer" and retry.',
    )
  }

  const rows = parseCsv(body).filter(r => r.some(c => String(c).trim() !== ''))
  if (rows.length < 2) throw new Error('Sheet export contained no data rows.')

  const idx = mapHeaders(rows[0])
  const missing = ['malayalam', 'english', 'transparent', 'shadow'].filter(f => idx[f] === undefined)
  if (missing.length) {
    throw new Error(
      `Sheet header is missing column(s): ${missing.join(', ')}. Got: ${rows[0].filter(Boolean).join(' | ')}`,
    )
  }

  return rows.slice(1).map((r, i) => ({
    line: i + 2,
    malayalam: String(r[idx.malayalam] ?? '').trim(),
    english: String(r[idx.english] ?? '').trim(),
    transparent: isHttpUrl(r[idx.transparent]) ? String(r[idx.transparent]).trim() : '',
    shadow: isHttpUrl(r[idx.shadow]) ? String(r[idx.shadow]).trim() : '',
  }))
}

// ── catalog ──────────────────────────────────────────────────────────────────

/**
 * Does the produce-library migration exist yet? The read path degrades
 * gracefully; the WRITE path refuses, because saving without `names` would
 * silently drop every Malayalam name.
 */
async function detectSchema() {
  try {
    await rest('product_catalog?select=id,names,review_status&limit=1')
    return true
  } catch (err) {
    if (/42703|does not exist/.test(err.message)) return false
    throw err
  }
}

/**
 * Whole catalog, matched in JS. Names contain `%`, `_`, `(` and `,` — all of
 * which are wildcards or separators in a PostgREST `ilike` filter — so we never
 * put a product name into a query string at all.
 */
async function fetchCatalog(hasNewColumns) {
  const cols = hasNewColumns
    ? 'id,name,category,image_url,names,review_status,status'
    : 'id,name,category,image_url,status'
  const all = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(`product_catalog?select=${cols}&order=id&limit=${PAGE}&offset=${offset}`)
    all.push(...page)
    if (page.length < PAGE) break
  }
  return all
}

async function fetchImagesFor(productIds) {
  const byProduct = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const chunk = productIds.slice(i, i + 100)
    if (!chunk.length) break
    const rows = await rest(
      `product_catalog_images?select=id,product_id,version,url&product_id=in.(${chunk.join(',')})`,
    )
    for (const row of rows) {
      if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, [])
      byProduct.get(row.product_id).push(row)
    }
  }
  return byProduct
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(CONFIRM ? '── APPLYING produce library import ──\n' : '── DRY RUN (nothing will change) ──\n')
  console.log(CATEGORY_OVERRIDE
    ? `Category: ${CATEGORY_OVERRIDE} (forced for every row by --category=)`
    : 'Category: classified per row — see the split below')

  const hasNewColumns = await detectSchema()
  if (!hasNewColumns) {
    console.log(`Schema:   migration ${REQUIRED_MIGRATION} is NOT applied (no names / review_status columns).`)
    if (CONFIRM) {
      console.error(
        `\nREFUSING to write: apply supabase/migrations/${REQUIRED_MIGRATION} first.\n` +
        'Without it the Malayalam names and the transparent/shadow image versions cannot be stored,\n' +
        'and a partial import would look successful while silently dropping data.',
      )
      process.exit(1)
    }
  } else {
    console.log('Schema:   produce-library columns present.')
  }

  const rows = await fetchSheetRows()
  console.log(`Sheet:    ${rows.length} data row(s) fetched.\n`)

  // Skip / dedupe before touching the database.
  const skipped = []
  const dupes = []
  const seen = new Map()
  const items = []
  for (const row of rows) {
    if (!row.english) {
      skipped.push(`line ${row.line}: no English name (Malayalam "${row.malayalam || '—'}")`)
      continue
    }
    const key = norm(row.english)
    if (seen.has(key)) {
      dupes.push(`line ${row.line}: "${row.english}" duplicates line ${seen.get(key)} — using the first`)
      continue
    }
    seen.set(key, row.line)
    items.push(row)
  }

  const catalog = await fetchCatalog(hasNewColumns)
  const byName = new Map()
  for (const p of catalog) {
    const key = norm(p.name)
    if (!byName.has(key)) byName.set(key, p) // duplicates exist — always take the first
  }

  const matchedIds = items.map(it => byName.get(norm(it.english))?.id).filter(Boolean)
  const imagesByProduct = await fetchImagesFor(matchedIds)

  let created = 0
  let updated = 0
  let unchanged = 0
  let imagesInserted = 0
  let imagesUpdated = 0
  let imagesUnchanged = 0
  let missingImages = 0
  const detail = []

  for (const item of items) {
    const existing = byName.get(norm(item.english))
    const wanted = [
      ['transparent', item.transparent],
      ['shadow', item.shadow],
    ].filter(([, url]) => url)
    if (wanted.length < 2) missingImages++

    if (!existing) {
      created++
      imagesInserted += wanted.length
      detail.push(
        `NEW      ${item.english}${item.malayalam ? `  (ml: ${item.malayalam})` : ''}` +
        `  [${wanted.map(([v]) => v).join(', ') || 'no images'}]`,
      )

      if (CONFIRM) {
        const [product] = await rest('product_catalog', {
          method: 'POST',
          body: JSON.stringify({
            name: item.english,
            category: categoryFor(item.english),
            names: item.malayalam ? { ml: item.malayalam } : {},
            review_status: 'approved',
            status: 'active',
            image_url: item.transparent || null,
          }),
        })
        for (const [version, url] of wanted) {
          await rest('product_catalog_images', {
            method: 'POST',
            body: JSON.stringify({
              product_id: product.id,
              version,
              url,
              source: 'url',
              is_primary: version === 'transparent',
            }),
          })
        }
      }
      continue
    }

    // ── existing product: enrich only ────────────────────────────────────────
    const patch = {}
    const currentNames = (existing.names && typeof existing.names === 'object') ? existing.names : {}
    if (item.malayalam && currentNames.ml !== item.malayalam) {
      patch.names = { ...currentNames, ml: item.malayalam } // merge — never clobber other languages
    }
    if (!existing.category) patch.category = categoryFor(item.english)
    if (!existing.image_url && item.transparent) patch.image_url = item.transparent

    const existingImages = imagesByProduct.get(existing.id) || []
    const imageOps = []
    for (const [version, url] of wanted) {
      const row = existingImages.find(r => r.version === version)
      if (!row) imageOps.push({ op: 'insert', version, url })
      else if (row.url !== url) imageOps.push({ op: 'update', id: row.id, version, url })
      else imagesUnchanged++
    }
    imagesInserted += imageOps.filter(o => o.op === 'insert').length
    imagesUpdated += imageOps.filter(o => o.op === 'update').length

    const changes = [
      ...Object.keys(patch).map(k => k === 'names' ? `names.ml="${item.malayalam}"` : `${k}`),
      ...imageOps.map(o => `${o.op === 'insert' ? '+' : '~'}${o.version}`),
    ]
    if (!changes.length) {
      unchanged++
      continue
    }
    updated++
    detail.push(`UPDATE   ${item.english}  [${changes.join(', ')}]`)

    if (CONFIRM) {
      if (Object.keys(patch).length) {
        await rest(`product_catalog?id=eq.${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })
      }
      for (const op of imageOps) {
        if (op.op === 'insert') {
          await rest('product_catalog_images', {
            method: 'POST',
            body: JSON.stringify({
              product_id: existing.id,
              version: op.version,
              url: op.url,
              source: 'url',
              is_primary: false,
            }),
          })
        } else {
          await rest(`product_catalog_images?id=eq.${op.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ url: op.url, source: 'url' }),
          })
        }
      }
    }
  }

  if (detail.length) {
    console.log(detail.join('\n'))
    console.log('')
  }
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} row(s) with no English name:`)
    console.log(skipped.map(s => `  ${s}`).join('\n'))
    console.log('')
  }
  if (dupes.length) {
    console.log(`Duplicate name(s) in the sheet (${dupes.length}):`)
    console.log(dupes.map(s => `  ${s}`).join('\n'))
    console.log('')
  }

  // The sheet has no category column, so the split below is this script's
  // guess. Printing it — and the names in each bucket — is the only chance to
  // catch a misclassification before it becomes 101 catalog rows.
  const byCategory = new Map()
  for (const item of items) {
    if (!item.english) continue
    const c = categoryFor(item.english)
    if (!byCategory.has(c)) byCategory.set(c, [])
    byCategory.get(c).push(item.english)
  }
  console.log('── Category split (check this before applying) ──')
  for (const [cat, names] of [...byCategory].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${cat} (${names.length}): ${names.join(', ')}`)
    console.log('')
  }

  // A URL that is merely well-formed is not necessarily an image. Two rows in
  // the sheet point at shop pages, which would sit in the catalog looking like
  // curated cut-outs.
  const suspectImages = []
  const identicalPairs = []
  for (const item of items) {
    if (!item.english) continue
    for (const [label, url] of [['transparent', item.transparent], ['shadow', item.shadow]]) {
      if (url && !/\.(png|jpe?g|webp|avif|gif)(\?|$)/i.test(url)) {
        suspectImages.push(`${item.english} [${label}] → ${url.slice(0, 70)}`)
      }
    }
    if (item.transparent && item.transparent === item.shadow) identicalPairs.push(item.english)
  }
  if (suspectImages.length) {
    console.log(`⚠ ${suspectImages.length} image link(s) don't end in an image extension — likely web pages, not photos:`)
    console.log(suspectImages.map(s => `    ${s}`).join('\n'))
    console.log('')
  }
  if (identicalPairs.length) {
    console.log(`⚠ ${identicalPairs.length} row(s) use the SAME url for transparent and shadow, so the two treatments are identical:`)
    console.log(`    ${identicalPairs.join(', ')}`)
    console.log('')
  }

  console.log('── Summary ──')
  console.log(`  products new:        ${created}`)
  console.log(`  products updated:    ${updated}`)
  console.log(`  products unchanged:  ${unchanged}`)
  console.log(`  images inserted:     ${imagesInserted}`)
  console.log(`  images updated:      ${imagesUpdated}`)
  console.log(`  images unchanged:    ${imagesUnchanged}`)
  console.log(`  rows missing an image: ${missingImages}`)
  console.log(`  rows skipped:        ${skipped.length}`)

  console.log(
    CONFIRM
      ? '\n✓ Import applied.'
      : hasNewColumns
        ? '\nNothing changed. Re-run with --confirm to apply.'
        : `\nNothing changed. Apply supabase/migrations/${REQUIRED_MIGRATION}, then re-run with --confirm.`,
  )
}

main().catch(err => {
  console.error('\nFailed:', err.message)
  process.exit(1)
})
