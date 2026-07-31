import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { aiParseOfferProducts } from '@/lib/ai/offer-capture'
import { splitOfferSections, summariseSections, type OfferSection } from '@/lib/ai/offer-sections'

/**
 * POST /api/figma/parse — turn a pasted WhatsApp offer message into structured
 * products, for the Cirqle Studio plugin's Paste tab.
 *
 * Deliberately NOT a second AI engine: it calls the same `aiParseOfferProducts`
 * (Groq) the Offer Intake form uses, so a list pasted in Figma and the same list
 * pasted in Cirqle produce identical output. What this route ADDS is the
 * section pre-pass — sticky "Sunday 100gm" headers, day grouping and
 * "Sunday 3 page" hints that line-by-line parsing cannot see.
 *
 * Read-only: nothing is written. The plugin shows the result for review and
 * only then calls POST /api/figma/campaign to persist it.
 *
 * Auth: the workspace `offer_sheet_secret`, same as the other figma routes.
 */

export const dynamic = 'force-dynamic'
// Section parsing fans out one Groq call per section; a multi-day paste can
// take longer than the default serverless ceiling.
export const maxDuration = 60

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

/** Cap the paste so one runaway message can't fan out into dozens of AI calls. */
const MAX_CHARS = 20_000
const MAX_SECTIONS = 12

export async function POST(req: NextRequest) {
  try {
    const admin = createAdminClient()

    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    const { data: secretRow } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', 'offer_sheet_secret')
      .maybeSingle()
    const secret = (secretRow?.value || '').trim()
    if (!secret || !bearer || bearer !== secret) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized. Paste the shared secret from Apps → Offer Intake → Shared sync script.' },
        { status: 401, headers: CORS_HEADERS },
      )
    }

    const body = await req.json().catch(() => null) as { text?: string; hint?: string } | null
    const text = (body?.text || '').trim()
    if (!text) {
      return NextResponse.json(
        { ok: false, error: 'Nothing to parse — paste the client\'s offer message first.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }
    if (text.length > MAX_CHARS) {
      return NextResponse.json(
        { ok: false, error: `That paste is ${text.length} characters; the limit is ${MAX_CHARS}. Split it into two pastes.` },
        { status: 413, headers: CORS_HEADERS },
      )
    }

    const sectioned = splitOfferSections(text)
    if (!sectioned.sections.length) {
      return NextResponse.json(
        { ok: false, error: 'No product lines found — the message looks like headers only.' },
        { status: 422, headers: CORS_HEADERS },
      )
    }
    if (sectioned.sections.length > MAX_SECTIONS) {
      return NextResponse.json(
        { ok: false, error: `That paste splits into ${sectioned.sections.length} sections (limit ${MAX_SECTIONS}). Send one day at a time.` },
        { status: 413, headers: CORS_HEADERS },
      )
    }

    // Each section is parsed on its own so its day/pack size can be attached
    // without relying on the model to preserve line order across the whole
    // message.
    //
    // SEQUENTIALLY, not in parallel. Groq's free tier caps tokens-per-minute
    // (12k on on_demand), and this prompt is token-heavy: firing three sections
    // at once reliably 429s the middle one — measured on a real three-section
    // Sea Star paste, where section 2 died with "Limit 12000, Used 8282,
    // Requested 4461". One at a time keeps each call inside the window, and
    // callGroqJSON's own 429 backoff then absorbs any residual burst. The cost
    // is a few seconds on multi-section pastes, which is the right trade for
    // not silently dropping a third of the products.
    const parsed: { index: number; section: OfferSection; products: Awaited<ReturnType<typeof aiParseOfferProducts>>['products']; error: string | null }[] = []
    for (let index = 0; index < sectioned.sections.length; index++) {
      const section = sectioned.sections[index]
      try {
        const result = await aiParseOfferProducts(section.lines.join('\n'), body?.hint)
        parsed.push({ index, section, products: result.products, error: null })
      } catch (err) {
        // One failed section must not lose the others — report it inline and
        // keep going, so a rate-limited middle section can't cost the rest.
        parsed.push({
          index,
          section,
          products: [],
          error: err instanceof Error ? err.message : 'AI parsing failed for this section.',
        })
      }
    }

    const products = parsed.flatMap(({ section, products: items }) =>
      items.map((p) => ({
        name: p.name,
        price: p.price ?? null,
        mrp: p.mrp ?? null,
        // The section's pack size becomes the structured Weight column (and the
        // #weight layer in Figma). The AI's own per-line weight handling is
        // unchanged — it folds line-level sizes into the name — so the two
        // never fight over the same value.
        weight: section.weight,
        badge: p.badge ?? null,
        day: section.day,
        offerType: /buy\s*1\s*get\s*1|b1g1|bogo/i.test(p.badge || '') ? 'bogo' : 'price',
      })),
    )

    const failures = parsed.filter(p => p.error)

    return NextResponse.json(
      {
        ok: true,
        products,
        summary: summariseSections(sectioned),
        days: sectioned.days,
        pageHints: sectioned.pageHints,
        sections: sectioned.sections.map((s, i) => ({
          day: s.day,
          weight: s.weight,
          lineCount: s.lines.length,
          productCount: parsed[i].products.length,
          error: parsed[i].error,
        })),
        // Surfaced so the plugin can warn rather than silently under-deliver.
        warnings: [
          ...failures.map(f => {
            const label = `Section ${f.index + 1}${f.section.weight ? ` (${f.section.weight})` : ''}`
            // A rate limit is transient and self-healing; say so, rather than
            // leaving the user to read a raw provider error and assume the
            // paste is broken.
            return /rate limit|429/i.test(f.error || '')
              ? `${label}: AI rate limit hit — wait ~30s and press Parse again. Its ${f.section.lines.length} products are missing from the list below.`
              : `${label} failed: ${f.error}`
          }),
          ...(sectioned.days.length > 1
            ? [`This message covers ${sectioned.days.length} days (${sectioned.days.join(', ')}) — save one campaign per day.`]
            : []),
        ],
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
