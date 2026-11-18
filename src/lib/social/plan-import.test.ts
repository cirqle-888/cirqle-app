import { describe, it, expect } from 'vitest'
import { parsePlan, parsePlanBlocks, parsePlanTable, planDate, planMonthIn, contentTypeOf, platformsOf } from './plan-import'
import { cleanPlanItem } from './plan-mcp'

describe('planDate', () => {
  const M = '2026-12'
  it('reads the ways an AI writes a date', () => {
    for (const raw of ['2026-12-04', '04/12/2026', '4 Dec', 'Dec 4', 'December 4th', 'Fri 4', '4', '**4 Dec 2026**'])
      expect(planDate(raw, M), raw).toEqual({ date: '2026-12-04' })
  })
  it('refuses another month, and a day the month does not have', () => {
    expect(planDate('2027-01-02', M)).toEqual({ date: null, outside: true })
    expect(planDate('2 Jan', M)).toEqual({ date: null, outside: true })
    expect(planDate('32', M)).toEqual({ date: null })
    expect(planDate('30', '2026-02')).toEqual({ date: null })
    expect(planDate('TBC', M)).toEqual({ date: null })
  })
})

describe('reading formats and platforms', () => {
  it('maps what the AI calls a format to the app’s content types', () => {
    expect(contentTypeOf('Reel')).toBe('reel')
    expect(contentTypeOf('Carousel post')).toBe('carousel')
    expect(contentTypeOf('Offer flyer post')).toBe('flyer')
    expect(contentTypeOf('Poster / Story')).toBe('poster')
    expect(contentTypeOf('YouTube Short')).toBe('reel')
    expect(contentTypeOf('WhatsApp status')).toBe('story')
    expect(contentTypeOf('something else')).toBe('post')
  })
  it('maps platform names and short forms, and leaves "All" for staff to choose', () => {
    expect(platformsOf('Instagram + Facebook')).toEqual(['instagram', 'facebook'])
    expect(platformsOf('IG/FB')).toEqual(['instagram', 'facebook'])
    expect(platformsOf('WhatsApp Status')).toEqual(['whatsapp'])
    expect(platformsOf('All')).toEqual([])
  })
})

const CALENDAR = `Here is the plan for December.

| Date | Day | Platform | Format | Theme | Idea in one line | Hook in the card's language | What the designer needs |
|---|---|---|---|---|---|---|---|
| 2026-12-02 | Wed | Instagram, Facebook | Poster | Wedding packages | **Grand wedding package** reminder | ഒരു ഗ്രാൻഡ് കല്യാണം | Package photo, logo |
| 4 Dec | Fri | Instagram | Reel | Behind the scenes | Kitchen at 5 am before a 1000-guest event | രാവിലെ അഞ്ച് മണി | Phone footage |
| 7 Dec | Mon | Instagram | Story | TREND SLOT | | | |
| 2 Jan | Sat | Instagram | Poster | New year | New year wishes | Happy New Year | Logo |
| soon | - | Instagram | Poster | Offers | Weekend offer | Offer | Logo |

Let me know if you want changes.`

describe('parsePlanTable', () => {
  it('reads a calendar: dated items, hooks as captions, the rest as notes', () => {
    const p = parsePlanTable(CALENDAR, '2026-12')
    expect(p.kind).toBe('calendar')
    expect(p.items).toHaveLength(3)
    expect(p.items[0]).toEqual({
      title: 'Grand wedding package reminder', date: '2026-12-02', content_type: 'poster',
      platforms: ['instagram', 'facebook'], caption: 'ഒരു ഗ്രാൻഡ് കല്യാണം',
      notes: 'Theme: Wedding packages\nDesigner needs: Package photo, logo', asap: false,
    })
    expect(p.items[1]).toMatchObject({ date: '2026-12-04', content_type: 'reel', platforms: ['instagram'] })
  })

  it('keeps a trend slot as a dated placeholder marked to post as soon as it is filled', () => {
    const slot = parsePlanTable(CALENDAR, '2026-12').items[2]
    expect(slot).toMatchObject({ title: 'Trend slot (fill from the daily trend check)', date: '2026-12-07', content_type: 'story', caption: null, asap: true })
  })

  it('reports the rows it left out, with the reason', () => {
    const { skipped } = parsePlanTable(CALENDAR, '2026-12')
    expect(skipped.map(s => s.reason)).toEqual(['That date is outside 2026-12.', 'Could not read the date.'])
  })

  it('reads fresh ideas as undated ideas', () => {
    const p = parsePlanTable(`Format | Idea | Hook | Effort | Best day
Reel | * Staff plating 500 biriyanis in 60 seconds | ഒരു മിനിറ്റിൽ | needs a shoot | Friday
Poster | Guess the dish poll | ഏത് വിഭവം? | easy | Sunday`, '2026-12')
    expect(p.kind).toBe('ideas')
    expect(p.items).toHaveLength(2)
    expect(p.items[0]).toMatchObject({ title: 'Staff plating 500 biriyanis in 60 seconds', date: null, content_type: 'reel', asap: false, notes: 'Effort: needs a shoot\nBest day: Friday' })
  })

  it('reads trends as ideas to post now, keeping the source link', () => {
    const p = parsePlanTable(`| Trend | Why it fits | Post idea (poster, reel or story) | Hook | Post by | Source link |
| --- | --- | --- | --- | --- | --- |
| Heavy rain alert in Malappuram | Events move indoors | Reel: our indoor hall setup | മഴയായാലും | Today | [Manorama](https://example.com/rain) |`, '2026-11')
    expect(p.kind).toBe('trends')
    expect(p.items[0]).toMatchObject({ title: 'Reel: our indoor hall setup', date: null, content_type: 'reel', asap: true })
    expect(p.items[0].notes).toContain('Trend: Heavy rain alert in Malappuram')
    expect(p.items[0].notes).toContain('Source: https://example.com/rain')
  })

  it('reads a table pasted from a spreadsheet (tabs)', () => {
    const p = parsePlanTable('Date\tPlatform\tFormat\tIdea\tHook\n5\tFB\tPoster\tFriday offer\tOffer!', '2026-12')
    expect(p.items).toEqual([expect.objectContaining({ title: 'Friday offer', date: '2026-12-05', platforms: ['facebook'], caption: 'Offer!' })])
  })

  it('finds nothing in plain text, and says so instead of guessing', () => {
    expect(parsePlanTable('Sure! Here are some thoughts about your calendar.', '2026-12')).toEqual({ kind: 'unknown', items: [], skipped: [] })
    expect(parsePlanTable('', '2026-12').kind).toBe('unknown')
  })

  it('every item it returns passes the calendar’s own validation', () => {
    for (const it of parsePlanTable(CALENDAR, '2026-12').items) expect(cleanPlanItem(it, '2026-12-01').ok).toBe(true)
  })

  it('reads every table in the answer: a calendar, then extra ideas', () => {
    const p = parsePlanTable(`| Date | Platform | Format | Idea | Hook |
|---|---|---|---|---|
| 24 Dec | IG/FB | Poster | Christmas wishes | Merry Christmas |

Some extra ideas:

| Format | Idea | Hook |
| Reel | Guess the dish | Which dish? |`, '2026-12')
    expect(p.kind).toBe('calendar')
    expect(p.items.map(i => [i.title, i.date])).toEqual([['Christmas wishes', '2026-12-24'], ['Guess the dish', null]])
    expect(p.skipped).toEqual([])
  })
})

describe('planMonthIn', () => {
  it('finds the month the dates are in', () => {
    expect(planMonthIn(CALENDAR)).toBe('2026-12')
    expect(planMonthIn('| 04/12/2026 | a |\n| 05/12/2026 | b |\n| 01/01/2027 | c |')).toBe('2026-12')
  })
  it('falls back to a month named in the text, and to nothing', () => {
    expect(planMonthIn('Plan for January 2027\n| Date | Idea |\n| 4 | x |')).toBe('2027-01')
    expect(planMonthIn('| Date | Idea |\n| 4 Dec | x |')).toBeNull()
    expect(planMonthIn('')).toBeNull()
  })
})

const DETAILED = `Here is the plan.

### POST 1
Date: 2026-12-01
Day: Tue
Platform: Instagram, Facebook
Format: Poster
Theme: Wedding packages
Idea: Grand wedding package reminder
Goal: enquiry; December is wedding season
Hook: ഒരു ഗ്രാൻഡ് കല്യാണം
Text on design: ഒരു ഗ്രാൻഡ് കല്യാണം / 1000 guests / Call now
Visual direction: Red header band, food photo centre,
logo bottom right. Same grid as last month.
Caption: Planning a wedding?
Call us today.
Hashtags: #kondotty #catering
Designer needs: package photo
AI prompt: Top view of a wedding buffet, warm light, empty space on top for text, no text in the image
Reel script: -
References: [Buffet layout](https://example.com/buffet); search: wedding catering poster red

### POST 2
**Date:** 4 Dec
**Format:** Reel
**Idea:** Kitchen at 5 am
**Reel script:**
1. 0-3s gas on
2. 3-8s rice goes in

### POST 3
Date: 2026-12-08
Format: Story
Idea: TREND SLOT

### POST 4
Date: 2 Jan
Idea: Outside the month
`

describe('parsePlanBlocks', () => {
  const p = parsePlanBlocks(DETAILED, '2026-12')

  it('reads one item per post block', () => {
    expect(p.kind).toBe('detailed')
    expect(p.items.map(i => [i.date, i.content_type, i.title])).toEqual([
      ['2026-12-01', 'poster', 'Grand wedding package reminder'],
      ['2026-12-04', 'reel', 'Kitchen at 5 am'],
      ['2026-12-08', 'story', 'Trend slot (fill from the daily trend check)'],
    ])
    expect(p.skipped).toEqual([{ row: '2 Jan Outside the month', reason: 'That date is outside 2026-12.' }])
  })

  it('puts the words in the caption and the brief in the notes', () => {
    const it0 = p.items[0]
    expect(it0.caption).toBe('Hook: ഒരു ഗ്രാൻഡ് കല്യാണം\n\nText on design:\nഒരു ഗ്രാൻഡ് കല്യാണം / 1000 guests / Call now\n\nCaption:\nPlanning a wedding?\nCall us today.\n\n#kondotty #catering')
    expect(it0.notes).toContain('Theme: Wedding packages')
    expect(it0.notes).toContain('Visual direction: Red header band, food photo centre,\nlogo bottom right. Same grid as last month.')
    expect(it0.notes).toContain('AI prompt (paste into the image or video tool):\nTop view of a wedding buffet')
    expect(it0.notes).not.toContain('Reel script')
    expect(it0.platforms).toEqual(['instagram', 'facebook'])
  })

  it('turns references into links: real ones as they are, phrases as a search', () => {
    expect(p.items[0].links).toEqual([
      { label: 'Buffet layout', url: 'https://example.com/buffet' },
      { label: 'Pinterest: wedding catering poster red', url: 'https://www.pinterest.com/search/pins/?q=wedding%20catering%20poster%20red' },
    ])
    expect(p.items[0].notes).toContain('Reference searches: wedding catering poster red')
  })

  it('keeps a numbered reel script whole, and bold labels work', () => {
    expect(p.items[1].notes).toBe('Reel script:\n1. 0-3s gas on\n2. 3-8s rice goes in')
  })

  it('a trend slot is a dated placeholder', () => {
    expect(p.items[2]).toMatchObject({ caption: null, asap: true })
  })

  it('finds nothing in a table or in plain text', () => {
    expect(parsePlanBlocks(CALENDAR, '2026-12').items).toEqual([])
    expect(parsePlanBlocks('Idea time! Here: nothing.', '2026-12').kind).toBe('unknown')
  })

  it('every item passes the calendar’s own validation, links included', () => {
    for (const it of p.items) {
      const c = cleanPlanItem(it, '2026-12-01')
      expect(c.ok).toBe(true)
    }
    const c = cleanPlanItem(p.items[0], '2026-12-01')
    expect(c.ok && c.item.links.length).toBe(2)
  })
})

describe('parsePlan', () => {
  it('reads blocks and tables together, keeping the fuller copy of a repeated post', () => {
    const p = parsePlan(`| Date | Format | Idea |
|---|---|---|
| 2026-12-01 | Poster | Grand wedding package reminder |
| 2026-12-20 | Poster | Only in the table |

${DETAILED}`, '2026-12')
    expect(p.kind).toBe('detailed')
    expect(p.items.map(i => i.title)).toEqual(['Grand wedding package reminder', 'Kitchen at 5 am', 'Trend slot (fill from the daily trend check)', 'Only in the table'])
    expect(p.items[0].notes).toContain('Visual direction')
  })
  it('a plain table still reads as before', () => {
    expect(parsePlan(CALENDAR, '2026-12')).toEqual(parsePlanTable(CALENDAR, '2026-12'))
  })
})
