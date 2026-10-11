import { describe, it, expect } from 'vitest'
import {
  clampFocal, slugFromClientName, uniqueShowcaseSlug, isOwnStoragePath, publicUrlFor,
  pathFromPublicUrl, rowToEntry, resolveForViewport, objectPosition, focalFromPointer,
  nudgeFocal, visibleRegion, defaultAltText, validateShowcaseInput, positionsFor, nextPosition,
  mobileModeOf, mediaAdvice,
  DESKTOP_ASPECT, MOBILE_ASPECT, MAX_CLIENT_NAME,
  type ShowcaseRow, type ShowcaseInput,
} from './showcase'

const BASE = 'https://site.supabase.co'

const row = (over: Partial<ShowcaseRow> = {}): ShowcaseRow => ({
  id: 'id-1', slug: 'elara', client_name: 'Elara', category: 'Brand identity', description: '',
  media_type: 'image', media_url: `${BASE}/x.webp`, poster_url: null,
  mobile_media_url: null, mobile_media_type: null, mobile_poster_url: null,
  alt_text: 'Elara', focal_x: 30, focal_y: 70, mobile_focal_x: null, mobile_focal_y: null,
  project_path: null, position: 10, published: true, ...over,
})

describe('numbers', () => {
  it('keeps focal points whole and inside 0–100', () => {
    expect(clampFocal(33.6)).toBe(34)
    expect(clampFocal(-5)).toBe(0)
    expect(clampFocal(140)).toBe(100)
  })
  it('falls back instead of storing NaN', () => {
    expect(clampFocal('nope')).toBe(50)
    expect(clampFocal(undefined, 20)).toBe(20)
  })
})

describe('slugs', () => {
  it('makes a web-safe slug', () => {
    expect(slugFromClientName('Elara Perfumes!')).toBe('elara-perfumes')
    expect(slugFromClientName('  Café  Déjà Vu ')).toBe('cafe-deja-vu')
  })
  it('never ends on a dash after truncating', () => {
    const s = slugFromClientName(`${'a'.repeat(59)} b`)
    expect(s.endsWith('-')).toBe(false)
  })
  it('settles uniqueness once, with a numeric suffix', () => {
    expect(uniqueShowcaseSlug('Elara', ['elara', 'elara-2'])).toBe('elara-3')
    expect(uniqueShowcaseSlug('Elara', [])).toBe('elara')
  })
  it('does not produce an empty slug from a name with no usable letters', () => {
    expect(uniqueShowcaseSlug('!!!', [])).toBe('client')
  })
})

describe('storage paths — the gate between the browser and the public site', () => {
  it('accepts a file inside the presentation’s own folder', () => {
    expect(isOwnStoragePath('elara', 'showcase/elara/desktop-2880.webp')).toBe(true)
    expect(isOwnStoragePath('elara', 'showcase/elara/mobile.mp4')).toBe(true)
  })
  it('refuses another presentation’s folder, traversal and absolute paths', () => {
    expect(isOwnStoragePath('elara', 'showcase/other/x.webp')).toBe(false)
    expect(isOwnStoragePath('elara', 'showcase/elara/../other/x.webp')).toBe(false)
    expect(isOwnStoragePath('elara', '/showcase/elara/x.webp')).toBe(false)
    expect(isOwnStoragePath('elara', 'showcase\\elara\\x.webp')).toBe(false)
  })
  it('refuses an extension the public bucket must not serve', () => {
    expect(isOwnStoragePath('elara', 'showcase/elara/x.html')).toBe(false)
    expect(isOwnStoragePath('elara', 'showcase/elara/x.svg')).toBe(false)
    expect(isOwnStoragePath('elara', 'showcase/elara/x')).toBe(false)
  })
  it('refuses anything that is not a string', () => {
    expect(isOwnStoragePath('elara', null)).toBe(false)
    expect(isOwnStoragePath('', 'showcase//x.webp')).toBe(false)
  })
})

describe('public URLs', () => {
  it('builds a versioned https URL, so a replaced file is not served stale', () => {
    const url = publicUrlFor(`${BASE}/`, 'work', 'showcase/elara/desktop-2880.webp', 1234.9)
    expect(url).toBe(`${BASE}/storage/v1/object/public/work/showcase/elara/desktop-2880.webp?v=1234`)
    expect(url.startsWith('https://')).toBe(true)
  })
  it('round-trips back to the storage path, ignoring the version', () => {
    const url = publicUrlFor(BASE, 'work', 'showcase/elara/a b.webp', 9)
    expect(pathFromPublicUrl(BASE, 'work', url)).toBe('showcase/elara/a b.webp')
  })
  it('does not claim a path for a URL from somewhere else', () => {
    expect(pathFromPublicUrl(BASE, 'work', 'https://evil.example/x.webp')).toBeNull()
    expect(pathFromPublicUrl(BASE, 'work', null)).toBeNull()
  })
})

describe('reading a row', () => {
  it('reads a desktop-only presentation', () => {
    const e = rowToEntry(row())
    expect(e.desktop).toMatchObject({ type: 'image', focalX: 30, focalY: 70 })
    expect(e.mobile).toBeNull()
    expect(e.published).toBe(true)
  })
  it('lets a mobile side without its own focal point follow the desktop one', () => {
    const e = rowToEntry(row({ mobile_media_url: `${BASE}/m.webp` }))
    expect(e.mobile).toMatchObject({ focalX: 30, focalY: 70, type: 'image' })
  })
  it('treats unset nullable columns as safe defaults', () => {
    const e = rowToEntry(row({ category: null, description: null, position: null, published: null, focal_x: null, focal_y: null }))
    expect(e).toMatchObject({ category: '', description: '', position: 0, published: false })
    expect(e.desktop).toMatchObject({ focalX: 50, focalY: 50 })
  })
})

describe('what a visitor sees — mirrors WorkPresentation.tsx', () => {
  const withMobile = rowToEntry(row({
    mobile_media_url: `${BASE}/m.webp`, mobile_focal_x: 80, mobile_focal_y: 10,
  }))
  it('shows desktop media on desktop', () => {
    expect(resolveForViewport(withMobile, 'desktop')).toMatchObject({ url: `${BASE}/x.webp`, focalX: 30, fellBack: false })
  })
  it('shows the mobile media and its own focal point on a phone', () => {
    expect(resolveForViewport(withMobile, 'mobile')).toMatchObject({ url: `${BASE}/m.webp`, focalX: 80, focalY: 10, fellBack: false })
  })
  it('falls back to desktop on a phone when there is no mobile media, and says so', () => {
    const r = resolveForViewport(rowToEntry(row()), 'mobile')
    expect(r).toMatchObject({ url: `${BASE}/x.webp`, focalX: 30, fellBack: true })
  })
  it('borrows the desktop poster for a mobile video that has none of its own', () => {
    const e = rowToEntry(row({
      media_type: 'video', poster_url: `${BASE}/p.webp`,
      mobile_media_url: `${BASE}/m.mp4`, mobile_media_type: 'video', mobile_poster_url: null,
    }))
    expect(resolveForViewport(e, 'mobile').posterUrl).toBe(`${BASE}/p.webp`)
  })
})

describe('focal point geometry', () => {
  it('writes the CSS the website writes', () => {
    expect(objectPosition(30.4, 70)).toBe('30% 70%')
  })
  it('converts a pointer position to a percentage of the IMAGE', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }
    expect(focalFromPointer(rect, 300, 150)).toEqual({ x: 50, y: 50 })
    expect(focalFromPointer(rect, 100, 50)).toEqual({ x: 0, y: 0 })
  })
  it('pins to the edge when dragged past it', () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 }
    expect(focalFromPointer(rect, 999, -50)).toEqual({ x: 100, y: 0 })
  })
  it('does not divide by a zero-size box', () => {
    expect(focalFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toEqual({ x: 50, y: 50 })
  })
  it('nudges from the keyboard, in bigger steps with Shift, and stays in range', () => {
    expect(nudgeFocal({ x: 50, y: 50 }, 'ArrowRight')).toEqual({ x: 51, y: 50 })
    expect(nudgeFocal({ x: 50, y: 50 }, 'ArrowUp', true)).toEqual({ x: 50, y: 40 })
    expect(nudgeFocal({ x: 0, y: 0 }, 'ArrowLeft')).toEqual({ x: 0, y: 0 })
    expect(nudgeFocal({ x: 5, y: 5 }, 'Enter')).toEqual({ x: 5, y: 5 })
  })
})

describe('visibleRegion — what object-fit: cover keeps', () => {
  it('shows everything when the shapes match', () => {
    expect(visibleRegion(1600, 900, DESKTOP_ASPECT, 50, 50)).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
  })
  it('crops the sides of a wide image on a phone, and the focal point picks which', () => {
    // 16:9 artwork in a 9:19.5 frame keeps a thin vertical slice.
    const left = visibleRegion(1600, 900, MOBILE_ASPECT, 0, 50)
    const right = visibleRegion(1600, 900, MOBILE_ASPECT, 100, 50)
    expect(left.x).toBe(0)
    expect(left.height).toBe(100)
    expect(left.width).toBeCloseTo(26, 0)
    expect(right.x + right.width).toBeCloseTo(100, 5)
  })
  it('crops top and bottom of a tall image on a desktop', () => {
    const top = visibleRegion(900, 1600, DESKTOP_ASPECT, 50, 0)
    expect(top.y).toBe(0)
    expect(top.width).toBe(100)
    expect(top.height).toBeCloseTo(31.6, 0)
  })
  it('only ever loses one axis', () => {
    const r = visibleRegion(1200, 800, MOBILE_ASPECT, 40, 40)
    expect(r.height === 100 || r.width === 100).toBe(true)
  })
  it('degrades to "all of it" on nonsense', () => {
    expect(visibleRegion(0, 0, 1, 50, 50)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })
})

describe('validation', () => {
  const input = (over: Partial<ShowcaseInput> = {}): ShowcaseInput => ({
    clientName: 'Elara Perfumes', category: 'Brand identity', description: '', altText: '',
    projectPath: null,
    desktop: { type: 'image', path: 'showcase/elara/desktop-2880.webp', posterPath: null, focalX: 50, focalY: 50 },
    mobile: null, ...over,
  })
  const errs = (i: ShowcaseInput) => {
    const v = validateShowcaseInput(i, 'elara')
    return v.ok ? [] : v.errors
  }

  it('accepts a complete presentation', () => {
    expect(errs(input())).toEqual([])
  })
  it('needs a client name', () => {
    expect(errs(input({ clientName: '  ' })).join(' ')).toMatch(/client name/)
    expect(errs(input({ clientName: 'x'.repeat(MAX_CLIENT_NAME + 1) })).join(' ')).toMatch(/under 80/)
  })
  it('derives alt text rather than demanding it', () => {
    expect(defaultAltText('Elara', 'Brand identity')).toBe('Elara — Brand identity')
    expect(defaultAltText('Elara', '')).toBe('Elara')
    expect(errs(input({ altText: '' }))).toEqual([])
  })
  it('keeps a project link inside the portfolio', () => {
    expect(errs(input({ projectPath: '/portfolio/social-media/cell-world' }))).toEqual([])
    expect(errs(input({ projectPath: 'https://evil.example' })).join(' ')).toMatch(/inside the portfolio/)
    expect(errs(input({ projectPath: '/contact' })).join(' ')).toMatch(/inside the portfolio/)
  })
  it('refuses a file that is not in this presentation’s folder', () => {
    const bad = input({ desktop: { type: 'image', path: 'showcase/other/x.webp', posterPath: null, focalX: 50, focalY: 50 } })
    expect(errs(bad).join(' ')).toMatch(/desktop file did not upload/)
  })
  it('requires a poster for a desktop video — the website’s own constraint', () => {
    const video = input({ desktop: { type: 'video', path: 'showcase/elara/desktop.mp4', posterPath: null, focalX: 50, focalY: 50 } })
    expect(errs(video).join(' ')).toMatch(/poster/)
  })
  it('lets a mobile video borrow the desktop poster, as the table allows', () => {
    const ok = input({
      desktop: { type: 'image', path: 'showcase/elara/d.webp', posterPath: 'showcase/elara/dp.webp', focalX: 50, focalY: 50 },
      mobile: { type: 'video', path: 'showcase/elara/m.mp4', posterPath: null, focalX: 50, focalY: 50 },
    })
    expect(errs(ok)).toEqual([])
    const bad = input({ mobile: { type: 'video', path: 'showcase/elara/m.mp4', posterPath: null, focalX: 50, focalY: 50 } })
    expect(errs(bad).join(' ')).toMatch(/mobile video has no poster/)
  })
  it('reports every problem at once instead of one per attempt', () => {
    expect(errs(input({ clientName: '', projectPath: '/x' })).length).toBeGreaterThanOrEqual(2)
  })
})

describe('ordering', () => {
  it('spaces positions by ten so a later insert has room', () => {
    expect(positionsFor(['a', 'b', 'c'])).toEqual([
      { id: 'a', position: 10 }, { id: 'b', position: 20 }, { id: 'c', position: 30 },
    ])
  })
  it('puts a new entry after everything', () => {
    expect(nextPosition([{ position: 10 }, { position: 40 }])).toBe(50)
    expect(nextPosition([])).toBe(10)
  })
})

describe('storage paths on a read entry', () => {
  it('fills in paths when it knows the public base, so an edit can keep a file', () => {
    const e = rowToEntry(row({
      media_url: publicUrlFor(BASE, 'work', 'showcase/elara/desktop-2880.webp', 5),
    }), BASE)
    expect(e.desktop.path).toBe('showcase/elara/desktop-2880.webp')
  })
  it('leaves them null when it does not', () => {
    expect(rowToEntry(row()).desktop.path).toBeNull()
  })
})

describe('how phones get their picture', () => {
  const desktopUrl = `${BASE}/storage/v1/object/public/work/showcase/elara/desktop-2880.webp`
  const base = row({ media_url: `${desktopUrl}?v=1` })
  it('is "same" when there is no mobile row', () => {
    expect(mobileModeOf(rowToEntry(base))).toBe('same')
  })
  it('is "crop" when the mobile file IS the desktop file — only the focal point differs', () => {
    // Different cache-busting versions must not hide that it is one file.
    const e = rowToEntry({ ...base, mobile_media_url: `${desktopUrl}?v=2`, mobile_focal_x: 10 })
    expect(mobileModeOf(e)).toBe('crop')
  })
  it('is "own" when a different file was uploaded for phones', () => {
    const e = rowToEntry({ ...base, mobile_media_url: `${BASE}/storage/v1/object/public/work/showcase/elara/mobile-1170.webp?v=1` })
    expect(mobileModeOf(e)).toBe('own')
  })
})

describe('advice about a source file', () => {
  it('says nothing about a good file', () => {
    expect(mediaAdvice('desktop', 2400, 1350)).toBeNull()
    expect(mediaAdvice('mobile', 1170, 2532)).toBeNull()
  })
  it('warns about too few pixels, per screen', () => {
    expect(mediaAdvice('desktop', 1200, 675)).toMatch(/1200px wide.*1600px/)
    expect(mediaAdvice('mobile', 600, 1300)).toMatch(/600px wide.*900px/)
  })
  it('warns when the shape fights the screen', () => {
    expect(mediaAdvice('desktop', 2000, 3000)).toMatch(/portrait/)
    expect(mediaAdvice('mobile', 3000, 2000)).toMatch(/landscape/)
  })
  it('says nothing when it does not know the size yet', () => {
    expect(mediaAdvice('desktop', 0, 0)).toBeNull()
  })
})
