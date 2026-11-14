/**
 * WhatsApp listener — offer price lists (supermarket flyers). Pure rules.
 *
 * A supermarket client pastes tomorrow's offers into its WhatsApp group as a
 * price list ("Tomato-26", "FEBI DISH WASH 500ML 44.90"). Each list is one
 * flyer, so it goes onto that client's social calendar as an "Untitled" flyer
 * on the offer date, with the list in its notes.
 *
 * The offer date: the client sometimes writes it ("DATE 14/15", "29/30",
 * "നാളെ"), often in a short message of its own. When nothing says, the offer
 * is for the next day.
 */

export const OFFER_ITEM_TITLE = 'Untitled'
/** Fewest priced lines that make a message a price list. */
export const MIN_PRICE_LINES = 4
/** A date sent on its own counts for a list received this recently. */
export const DATE_FOLLOW_UP_MINUTES = 180
/** A message delivered this late (the listener was off) is not planned from: its offer has likely passed. */
export const STALE_HOURS = 24
/** Written in the notes while the date is our guess; a later date message looks for it. */
export const DATE_ASSUMED_LINE = 'Offer date: not given, so it is set to the next day.'

const LETTERS = /[A-Za-zഀ-ൿ]{2}/
// "... 44.90", "Tomato-26", "APPLE 149/-", "Rice Rs 55": a name, then a price that ends the line.
const PRICE_AT_END = /[\s\-:=.₹]\s*(?:rs\.?\s*)?\d{1,5}(?:\.\d{1,2})?\s*(?:\/-|rs\.?|₹)?\s*$/i
// "DATE 14/15", "Offer date 11 to 13", and "Date2 to 10" typed without a space.
const DATE_LINE = /^\s*(?:offer\s*)?dates?(?![a-z])[\s:.\-]*(.*)$/i

const lines = (text: string): string[] => String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)

export function isPriceLine(line: string): boolean {
  return !DATE_LINE.test(line) && LETTERS.test(line) && PRICE_AT_END.test(line)
}

/** How many priced products the message lists; 0 when it is not a price list. */
export function priceListSize(text: string): number {
  const all = lines(text).filter(l => !DATE_LINE.test(l))
  const priced = all.filter(isPriceLine).length
  // Mostly prices: a paragraph that happens to end four lines with a number is not a list.
  return priced >= MIN_PRICE_LINES && priced >= all.length * 0.6 ? priced : 0
}

/**
 * One to three priced lines with nothing else ("Ador price 289", "BANANA MYSORE 39"):
 * some clients send a flyer's products a few at a time, or add one after the list.
 */
export function isSmallAddition(text: string): boolean {
  const all = lines(text)
  return all.length >= 1 && all.length < MIN_PRICE_LINES && all.every(isPriceLine)
}

/** Finds a message already added to an item's notes. */
export const additionMarker = (messageId: string) => `[added:${messageId}]`
export function notesWithAddition(notes: string, text: string, messageId: string): string {
  return `${notes}\n\nAdded by the client afterwards:\n${text.trim().slice(0, 1000)}\n${additionMarker(messageId)}`
}

// ─── Dates (all on the India calendar, as 'YYYY-MM-DD') ───────────────────────

const iso = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}
export const addDays = (day: string, by: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10)

/** The next date, from `from` onwards, that falls on this day of the month. */
function nextDayOfMonth(dayOfMonth: number, from: string): string | null {
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7))
  for (let i = 0; i < 3; i++) {
    const d = iso(y, m, dayOfMonth)
    if (d && d >= from) return d
    m += 1; if (m > 12) { m = 1; y += 1 }
  }
  return null
}

const WEEKDAYS: [RegExp, number][] = [
  [/\bsun(day)?\b|ഞായർ|ഞായറാഴ്ച/i, 0], [/\bmon(day)?\b|തിങ്കൾ|തിങ്കളാഴ്ച/i, 1], [/\btue(s|sday)?\b|ചൊവ്വ/i, 2],
  [/\bwed(nesday)?\b|ബുധൻ|ബുധനാഴ്ച/i, 3], [/\bthu(r|rs|rsday)?\b|വ്യാഴം|വ്യാഴാഴ്ച/i, 4], [/\bfri(day)?\b|വെള്ളി/i, 5],
  [/\bsat(urday)?\b|ശനി/i, 6],
]

const DATE_FILLER = new Set(['offer', 'offers', 'date', 'dates', 'valid', 'on', 'and', 'to', 'page', 'pages', 'only', 'from', 'for'])
const DATE_WORD = new RegExp(`^(?:നാളെ|naa?ley?|tomorrow|tmrw|ഇന്ന്|innu?|today|മറ്റന്നാൾ|mattannal|${WEEKDAYS.map(([re]) => re.source.replace(/\\b/g, '')).join('|')})$`, 'i')

export interface OfferDates { start: string; end: string | null }

/**
 * Reads a date out of a few words: "14/15", "29/30/31", "12-11-2026", "നാളെ",
 * "tomorrow", "sat sun". Numbers are days of the month (that is how the clients
 * write them), unless they plainly read as day/month. Null when it says no date.
 */
export function parseDateHint(text: string, today: string): OfferDates | null {
  const t = String(text || '').trim().toLowerCase()
  if (!t || t.length > 60) return null

  if (/മറ്റന്നാൾ|mattannal|day after tomorrow/.test(t)) return { start: addDays(today, 2), end: null }
  if (/നാളെ|\bnaa?le[y]?\b|\btomorrow\b|\btmrw\b/.test(t)) return { start: addDays(today, 1), end: null }
  if (/ഇന്ന്|\binnu?\b|\btoday\b/.test(t)) return { start: today, end: null }

  const full = t.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})\b/)
  if (full) {
    const year = full[3].length === 2 ? 2000 + Number(full[3]) : Number(full[3])
    const exact = Math.abs(year - Number(today.slice(0, 4))) <= 1 ? iso(year, Number(full[2]), Number(full[1])) : null
    if (exact) return { start: exact, end: null }
  }

  const nums = (t.match(/\d+/g) || []).map(Number)
  if (nums.length >= 1 && nums.length <= 4 && nums.every(n => n >= 1 && n <= 31) && /^[\d\s\/,&.\-]+$/.test(t.replace(/\b(and|to)\b/g, ' '))) {
    const month = Number(today.slice(5, 7)), nextMonth = month === 12 ? 1 : month + 1
    // "14/11" in November: day/month. "14/15": two days.
    if (nums.length === 2 && nums[1] < nums[0] && nums[1] <= 12 && (nums[1] === month || nums[1] === nextMonth) && nums[1] !== 1) {
      const year = Number(today.slice(0, 4)) + (nums[1] < month ? 1 : 0)
      const d = iso(year, nums[1], nums[0])
      if (d && d >= today) return { start: d, end: null }
    }
    const start = nextDayOfMonth(nums[0], today)
    if (!start) return null
    const last = nums.length > 1 ? nextDayOfMonth(nums[nums.length - 1], start) : null
    // A run of days is short; anything longer is a misread.
    const end = last && last > start && Date.parse(last) - Date.parse(start) <= 10 * 86_400_000 ? last : null
    return { start, end }
  }

  const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay()
  const ahead = WEEKDAYS.filter(([re]) => re.test(t)).map(([, dow]) => ((dow - todayDow + 7) % 7) || 7).sort((a, b) => a - b)
  if (ahead.length) {
    const end = ahead.length > 1 && ahead[ahead.length - 1] - ahead[0] <= 3 ? addDays(today, ahead[ahead.length - 1]) : null
    return { start: addDays(today, ahead[0]), end }
  }
  return null
}

/** The offer date for a price list: what its "DATE" line says, else the next day. */
export function offerDates(text: string, today: string): OfferDates & { given: boolean } {
  for (const l of lines(text)) {
    const m = l.match(DATE_LINE)
    const hint = m ? parseDateHint(m[1], today) : null
    if (hint) return { ...hint, given: true }
  }
  // A bare "14/15" as the first line, above the products.
  const first = lines(text)[0] || ''
  const top = !isPriceLine(first) && /^[\d\s\/,&.\-]+$/.test(first) ? parseDateHint(first, today) : null
  if (top) return { ...top, given: true }
  return { start: addDays(today, 1), end: null, given: false }
}

/** A short message that only gives a date ("29/30", "നാളെ", "Date 14/15"). */
export function dateOnlyMessage(text: string, today: string): OfferDates | null {
  const t = String(text || '').trim()
  if (!t || t.length > 40 || t.includes('\n') || priceListSize(t)) return null
  const m = t.match(DATE_LINE)
  // A lone number ("19") is more often a price or a count than a date.
  if (!m && /^\d+$/.test(t)) return null
  // Only when the message is nothing but the date: "Before Thursday night kittiya" is talk, not an offer date.
  const words = t.toLowerCase().split(/[^a-z\u0D00-\u0D7F]+/).filter(Boolean)
  if (!words.every(w => DATE_FILLER.has(w) || DATE_WORD.test(w))) return null
  return parseDateHint(m ? m[1] : t, today)
}

// ─── Notes on the calendar item ───────────────────────────────────────────────

const sourceTag = (messageId: string, chatId: string) => `[whatsapp:${messageId} chat:${chatId}]`
/** Finds the item a message already became (a redelivery must not add a second one). */
export const messageMarker = (messageId: string) => `[whatsapp:${messageId} `
/** Finds the items that came from one chat. */
export const chatMarker = (chatId: string) => ` chat:${chatId}]`

const pretty = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' })
export function dateLabel(d: OfferDates): string {
  return d.end ? `${pretty(d.start)} to ${pretty(d.end)}` : pretty(d.start)
}

export function offerNotes(input: {
  list: string; client: string; sender: string; products: number
  dates: OfferDates & { given: boolean }; messageId: string; chatId: string
  /** The list was read off a photo by AI rather than typed. */
  fromPhoto?: boolean
}): string {
  return [
    ...(input.fromPhoto ? ['Read by AI from a photo: check every price against the photo in the WhatsApp chat.'] : []),
    `Offer list from WhatsApp (${input.client}${input.sender ? `, sent by ${input.sender}` : ''}): ${input.products} products.`,
    input.dates.given ? `Offer date: ${dateLabel(input.dates)} (given by the client).` : DATE_ASSUMED_LINE,
    '',
    input.list.trim().slice(0, 6000),
    '',
    sourceTag(input.messageId, input.chatId),
  ].join('\n')
}

/** The notes once the client has sent the date the list did not carry. */
export function notesWithDate(notes: string, dates: OfferDates): string {
  return notes.replace(DATE_ASSUMED_LINE, `Offer date: ${dateLabel(dates)} (given by the client in a later message).`)
}
