/**
 * Checklist items — work we owe a client that is not a task and not a bill.
 *
 * Two kinds of job kept getting forgotten because there was nowhere honest to
 * put them:
 *
 *   • COMPLIMENTARY extras promised alongside a package — a set of Instagram
 *     highlight icons, a profile picture. Somebody must do them, nobody is
 *     charged for them.
 *   • SETUP for a new brand — Facebook page, Instagram account, Meta Business
 *     configuration, linking the accounts. Not client work at all, but the
 *     client's work cannot start until it is done.
 *
 * Both are shaped exactly like a request (client, title, assignee, due date),
 * so they ride the same rails: the Requests page for whoever runs the work, the
 * My Work board for whoever does it. What makes them different is enforced in
 * three places and nowhere else:
 *
 *   1. starting one never creates a task — so it can never reach an invoice
 *   2. it never appears on the client's portal or track page
 *   3. it never emails the client
 *
 * Pure constants and predicates only, so the server actions, the board and the
 * inbox all read the same definition.
 */

export const REQUEST_KIND_REQUEST = 'request'
export const REQUEST_KIND_CHECKLIST = 'checklist'

export type RequestKind = typeof REQUEST_KIND_REQUEST | typeof REQUEST_KIND_CHECKLIST

/**
 * Is this a checklist item?
 *
 * Anything unset is a REQUEST. The column arrived long after the rows did, and
 * reading an unset kind as "checklist" would quietly hide real client work from
 * the client's own portal.
 */
export function isChecklistRequest(r: { kind?: string | null } | null | undefined): boolean {
  return r?.kind === REQUEST_KIND_CHECKLIST
}

/** What a checklist item is called wherever one appears. */
export const CHECKLIST_LABEL = 'Complimentary'
export const CHECKLIST_HINT =
  'Work we owe this client with nothing to bill — it is assigned and tracked, but never becomes a task and never reaches an invoice.'

/**
 * The steps a new brand needs before any design work can start.
 *
 * Held in code rather than a table on purpose: it is a default, and the whole
 * point is that starting a brand takes one click instead of remembering nine
 * things. Anything unusual is added to the client's list by hand afterwards,
 * and any of these can be deleted if the brand already has them.
 */
export const BRAND_ONBOARDING_STEPS: readonly { title: string; description: string }[] = [
  {
    title: 'Create the Facebook page',
    description: 'Business page with the brand name, category, and the agreed handle.',
  },
  {
    title: 'Create the Instagram account',
    description: 'Handle to match the Facebook page wherever it is still free.',
  },
  {
    title: 'Convert Instagram to a professional account',
    description: 'Business or Creator — Insights and scheduling both need it.',
  },
  {
    title: 'Link Instagram to the Facebook page',
    description: 'Through Meta Business Suite, not the phone app — the app link does not carry publishing rights.',
  },
  {
    title: 'Set up Meta Business Suite access',
    description: 'Add the brand to the business portfolio and give Cirqle a partner role.',
  },
  {
    title: 'Connect the accounts to Cirqle',
    description: 'Social → Accounts, so scheduling and publishing work from here.',
  },
  {
    title: 'Add the profile picture and cover',
    description: 'Brand logo at the right crop for both platforms.',
  },
  {
    title: 'Write the bio and contact details',
    description: 'Bio, category, phone, email, address, and the website link.',
  },
  {
    title: 'Create the highlight icons',
    description: 'The starter set agreed with the client — complimentary.',
  },
]
