/**
 * Advertising adapter — turns a captured snippet ("Run Meta ads ₹20k for Acme,
 * lead gen") into a review draft for a new Advertising Project. Heuristic only
 * (no AI parse of its own) so it stays fast and dependency-light; the user
 * confirms + fills in the budget details on the create form. No DB writes —
 * commit happens through the Advertising module's guarded createAdProject.
 */
import { findClient } from '@/lib/ai/request-capture'
import {
  PLATFORM_LABEL, CAMPAIGN_TYPE_LABEL,
  type AdPlatform, type AdCampaignType,
} from '@/lib/advertising/types'
import type { AdapterContext, CaptureDraft, CaptureInput, DetectedClient, ModuleAdapter } from '../types'

const PLATFORM_KEYWORDS: [AdPlatform, RegExp][] = [
  ['instagram', /\binsta(gram)?\b|\big\b/i],
  ['facebook',  /\bfacebook\b|\bfb\b/i],
  ['meta',      /\bmeta\b/i],
  ['google',    /\bgoogle\b|\badwords\b|\bsearch ads\b|\bdisplay ads\b|\bp-?max\b|\bperformance max\b/i],
  ['youtube',   /\byoutube\b|\byt\b/i],
  ['tiktok',    /\btiktok\b/i],
  ['linkedin',  /\blinkedin\b/i],
  ['snapchat',  /\bsnap(chat)?\b/i],
  ['x',         /\btwitter\b|\bx ads\b/i],
]

const TYPE_KEYWORDS: [AdCampaignType, RegExp][] = [
  ['leads',       /\blead\s?gen\b|\blead generation\b|\bleads?\b/i],
  ['messages',    /\bmessages?\b|\bdm\b|\bwhatsapp\b/i],
  ['sales',       /\bsales?\b|\bcatalog(ue)?\b|\bshop\b/i],
  ['conversion',  /\bconversions?\b|\bconvert\b/i],
  ['remarketing', /\bremarket(ing)?\b|\bretarget(ing)?\b/i],
  ['app_install', /\bapp install(s)?\b|\binstalls?\b/i],
  ['video_views', /\bvideo views?\b/i],
  ['traffic',     /\btraffic\b|\bvisits?\b/i],
  ['engagement',  /\bengagement\b|\bboost\b|\blikes?\b|\bfollowers?\b/i],
  ['awareness',   /\bawareness\b|\bbrand(ing)?\b/i],
  ['reach',       /\breach\b/i],
]

/** Detect the ad platform from free text. Defaults to 'meta' (most common). */
export function detectPlatform(text: string): AdPlatform {
  for (const [platform, re] of PLATFORM_KEYWORDS) if (re.test(text)) return platform
  return 'meta'
}

/** Detect the campaign objective from free text. Null when nothing matches. */
export function detectCampaignType(text: string): AdCampaignType | null {
  for (const [type, re] of TYPE_KEYWORDS) if (re.test(text)) return type
  return null
}

/**
 * Pull an ad budget out of text like "₹20,000", "Rs 20000", "20k budget",
 * "INR 35k". Returns null when no money-looking figure is present.
 */
export function extractBudget(text: string): number | null {
  // Prefer a figure that sits next to a currency marker or the word "budget".
  const m = text.match(
    /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|l)?|([\d,]+(?:\.\d+)?)\s*(k|lakh|l)?\s*(?:budget|spend)/i,
  )
  if (!m) return null
  const numRaw = m[1] ?? m[3]
  const unit = (m[2] ?? m[4] ?? '').toLowerCase()
  if (!numRaw) return null
  let val = parseFloat(numRaw.replace(/,/g, ''))
  if (!Number.isFinite(val)) return null
  if (unit === 'k') val *= 1_000
  else if (unit === 'lakh' || unit === 'l') val *= 100_000
  return val
}

export interface ParsedAdvertising {
  platform: AdPlatform
  campaignType: AdCampaignType | null
  adBudget: number | null
  campaignName: string
}

/** Pure parse of the snippet → advertising fields (unit-tested). */
export function parseAdvertising(text: string): ParsedAdvertising {
  const platform = detectPlatform(text)
  const campaignType = detectCampaignType(text)
  const adBudget = extractBudget(text)
  const firstLine = (text.split('\n')[0] || '').trim()
  const campaignName =
    (firstLine.length >= 4 && firstLine.length <= 80 ? firstLine : '') ||
    `${PLATFORM_LABEL[platform]} ${campaignType ? CAMPAIGN_TYPE_LABEL[campaignType] : 'Ads'} Campaign`
  return { platform, campaignType, adBudget, campaignName }
}

/** Pure mapping of parsed fields → a review draft (unit-tested). */
export function buildAdvertisingDraft(
  parsed: ParsedAdvertising,
  client: DetectedClient | null,
): CaptureDraft {
  const typeLabel = parsed.campaignType ? CAMPAIGN_TYPE_LABEL[parsed.campaignType] : 'Ads'
  return {
    type: 'advertising',
    // Advertising captures commit as a request in the Requests inbox; this target
    // is only a fallback for the redirect path.
    target: '/dashboard/requests',
    summary: `${PLATFORM_LABEL[parsed.platform]} ${typeLabel} — ${parsed.campaignName}`,
    client,
    fields: {
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      campaignName: parsed.campaignName,
      platform: parsed.platform,
      campaignType: parsed.campaignType,
      adBudget: parsed.adBudget,
    },
  }
}

export const advertisingAdapter: ModuleAdapter = {
  type: 'advertising',
  async prepare(input: CaptureInput, classification, ctx: AdapterContext): Promise<CaptureDraft> {
    const text = input.payload.trim()
    const parsed = parseAdvertising(text)
    let client = ctx.client
    if (!client) {
      const hint = (classification.hints?.client as string) || null
      if (hint) {
        const hit = await findClient(ctx.admin, hint)
        if (hit) client = { id: hit.id, name: hit.name, matchedBy: 'name' }
      }
    }
    return buildAdvertisingDraft(parsed, client)
  },
}
