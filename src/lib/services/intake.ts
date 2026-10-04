/**
 * Service-based intake routing — PURE, client-safe helpers (no DB imports).
 *
 * Each service carries an `intake_kind` declaring which client-facing intake
 * form it exposes. A client's available forms are the distinct non-'none'
 * intake_kinds across the services assigned to them (via client_service_pricing)
 * — the single source of truth for client capabilities. No per-client module
 * table. New kinds (meta_ads, google_ads, website, seo, …) only need an entry
 * here + their own intake route; no schema migration.
 *
 * Server-side derivation lives in `intake-server.ts` (it imports the admin
 * client and must never be pulled into a client bundle).
 */

export const INTAKE_KINDS = ['none', 'request_portal', 'offer_intake', 'product_library'] as const
export type KnownIntakeKind = typeof INTAKE_KINDS[number]
// Future kinds are allowed as plain strings without code-wide type churn.
export type IntakeKind = KnownIntakeKind | (string & {})

export const INTAKE_KIND_META: Record<string, { label: string; short: string; description: string }> = {
  none:           { label: 'None — billing only', short: 'None',         description: 'No client-submittable form. Pure billing / line-item service (e.g. Domain Purchase, Workspace Mail).' },
  request_portal: { label: 'Standard Request',     short: 'Request',      description: 'Design / social-media clients submit work through the standard Request Portal.' },
  // Still marks an offer-flyer client (catalog, capability checks), but there is
  // no client form any more: offer lists are prepared by staff in Offer Studio.
  offer_intake:   { label: 'Offer Flyer',          short: 'Offer Flyer',  description: 'Supermarket / retail offer-flyer clients. Their offer lists are prepared by the team in Offer Studio — no client form.' },
  product_library:{ label: 'Product Library',       short: 'Products',     description: 'Clients build up their own catalog of vegetables and fruits — name, local name and photo — for staff to review before it goes live.' },
}

/** Display label for any kind, including future ones not yet in the meta map. */
export function intakeKindLabel(kind: string | null | undefined): string {
  if (!kind) return INTAKE_KIND_META.none.label
  return INTAKE_KIND_META[kind]?.label ?? kind
}

/** Distinct, non-'none' intake kinds across a set of services. */
export function deriveIntakeKinds(services: Array<{ intake_kind?: string | null }>): string[] {
  return [...new Set(
    services.map(s => s.intake_kind || 'none').filter(k => k && k !== 'none'),
  )]
}

/** Which app a multi-service client lands on first when opening their Hub link.
 *  Offer Intake used to lead for supermarket/retail clients; it has no client
 *  form any more, so their Product Library comes first. */
export const INTAKE_KIND_PRIORITY = ['product_library', 'request_portal'] as const

/** Route for a given kind, given that client's per-app tokens. Null if the
 *  client doesn't have that app's token (kind not enabled / not provisioned). */
export function intakeKindHref(kind: string, tokens: {
  requestToken?: string | null
  offerToken?: string | null
  libraryToken?: string | null
}): string | null {
  if (kind === 'request_portal') return tokens.requestToken ? `/intake/${tokens.requestToken}` : null
  // The client offer form was retired (Oct 2026) — offers are prepared in Offer
  // Studio — so an offer-flyer client has no form to be sent to.
  if (kind === 'offer_intake') return null
  if (kind === 'product_library') return tokens.libraryToken ? `/intake/library/${tokens.libraryToken}` : null
  return null
}
