import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { FORMATS_BY_COLLECTION, WORK_FORMATS, WORK_FORMAT_LABEL } from './types'

/**
 * The dashboard's format vocabulary against the website's.
 *
 * These are two repositories and two deploys, joined only by a `format` string
 * in a shared database — so they drift silently, and the drift is invisible
 * until somebody tries to file something.
 *
 * That already happened: the website could render outdoor and print work
 * (hoardings, banners, standees, posters, menus…) while the dashboard's
 * vocabulary stopped at social media and brand identity. An outdoor piece
 * uploaded from the dashboard fell back to `vocabulary[0]` — 'post' — and the
 * website, seeing a format from outside the collection's list, treated it as
 * missing and re-inferred it. The piece was neither filed nor framed as what
 * it was, and nothing anywhere said so.
 *
 * Reads the sibling checkout, and SKIPS when it is not there so a contributor
 * with only one repository still gets a green suite.
 */

const WEBSITE = join(__dirname, '../../../../cirqle-website/src/lib/work.ts')
const present = existsSync(WEBSITE)
const source = present ? readFileSync(WEBSITE, 'utf8') : ''

/** Pull a quoted string list out of a named declaration in the website source. */
function listAfter(marker: string): string[] {
  const at = source.indexOf(marker)
  expect(at, `${marker} is gone from the website's work.ts`).toBeGreaterThan(-1)
  const body = source.slice(at, source.indexOf('\n]', at) + 2)
  return [...body.matchAll(/"([a-z]+)"/g)].map(m => m[1])
}

describe.skipIf(!present)('dashboard and website agree on what a format is', () => {
  it('offers every format the website can render', () => {
    // The website's chip order, which lists each format exactly once.
    const theirs = listAfter('export const FORMATS: readonly WorkFormat[] = [')
    expect([...theirs].sort()).toEqual([...WORK_FORMATS].sort())
  })

  it('files each collection under the same vocabulary', () => {
    const at = source.indexOf('const COLLECTION_FORMATS: Record<string, readonly WorkFormat[]> = {')
    expect(at, 'COLLECTION_FORMATS is gone from the website').toBeGreaterThan(-1)
    const body = source.slice(at, source.indexOf('\n};', at))

    for (const [collection, formats] of Object.entries(FORMATS_BY_COLLECTION)) {
      // Keys appear quoted ("social-media") or bare (outdoor).
      const line = body.split('\n').find(l => l.includes(`"${collection}":`) || l.match(new RegExp(`\\b${collection}:`)))
      expect(line, `the website has no vocabulary for the ${collection} collection`).toBeTruthy()
      const theirs = [...line!.matchAll(/"([a-z]+)"/g)].map(m => m[1]).filter(f => f !== collection)
      expect(theirs, collection).toEqual([...formats])
    }
  })

  it('has a label for every format, so none renders as a raw slug', () => {
    for (const format of WORK_FORMATS) {
      expect(WORK_FORMAT_LABEL[format], format).toBeTruthy()
    }
  })
})

describe('the vocabulary itself', () => {
  it('lists every format exactly once', () => {
    expect(new Set(WORK_FORMATS).size).toBe(WORK_FORMATS.length)
  })

  it('files every collection format inside the shared vocabulary', () => {
    // A collection offering a format the type does not know would be saved and
    // then never matched by anything.
    for (const [collection, formats] of Object.entries(FORMATS_BY_COLLECTION)) {
      for (const format of formats) {
        expect(WORK_FORMATS, `${collection} → ${format}`).toContain(format)
      }
    }
  })
})
