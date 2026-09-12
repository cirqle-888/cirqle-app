import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Deleting an offer campaign is the only irreversible action in the offer
 * module — the row cascades to its products, change logs and revisions, and
 * nothing in the app can bring any of it back.
 *
 * Two things have to stay true, and neither is visible on screen:
 *
 *   · the authorization lives INSIDE the Server Function. Next's own guidance
 *     is explicit that Server Functions are reachable by direct POST, not only
 *     through the UI, so hiding the button is not a control; and
 *   · the delete goes through the campaign row alone, letting the schema's
 *     `on delete cascade` remove the children. Deleting children by hand would
 *     risk a half-deleted campaign if one statement failed.
 */
const ACTIONS = readFileSync(
  join(process.cwd(), 'src/app/(dashboard)/dashboard/campaigns/actions.ts'),
  'utf8',
)
const CARD = readFileSync(
  join(process.cwd(), 'src/components/campaigns/campaign-card.tsx'),
  'utf8',
)

/** The body of a named exported action, up to the next export. */
function actionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`)
  if (start === -1) return ''
  const next = src.indexOf('\nexport ', start + 1)
  return src.slice(start, next === -1 ? undefined : next)
}

describe('deleteCampaign — the irreversible one', () => {
  const body = actionBody(ACTIONS, 'deleteCampaign')

  it('exists and is exported', () => {
    expect(body, 'deleteCampaign action not found').not.toBe('')
  })

  it('checks admin BEFORE it touches the database', () => {
    const guardAt = body.indexOf('requireAdmin()')
    const deleteAt = body.indexOf('.delete()')
    expect(guardAt, 'no requireAdmin() in deleteCampaign').toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(-1)
    expect(guardAt, 'requireAdmin() must come before the delete').toBeLessThan(deleteAt)
  })

  it('returns early when the guard fails, rather than falling through', () => {
    expect(body).toMatch(/if\s*\(!guard\.ok\)\s*return\s*\{\s*ok:\s*false/)
  })

  it('refuses a campaign that does not exist instead of reporting success', () => {
    expect(body).toMatch(/if\s*\(readErr\s*\|\|\s*!existing\)\s*return\s*\{\s*ok:\s*false/)
  })

  it('deletes ONLY the campaign row, leaving the cascade to the schema', () => {
    expect(body).toContain("from('offer_campaigns').delete()")
    // A hand-rolled child delete is the failure mode this guards against.
    expect(body).not.toContain("from('offer_products').delete()")
    expect(body).not.toContain("from('offer_change_logs').delete()")
    expect(body).not.toContain("from('offer_campaign_revisions').delete()")
  })

  it('revalidates Requests too — the campaign is listed there, not just Campaigns', () => {
    expect(body).toContain("revalidatePath('/dashboard/requests')")
  })
})

describe('the Delete control is harder to hit than Archive', () => {
  it('asks for typed confirmation, unlike every other action on the card', () => {
    // Delete sits inches from Archive and the outcomes are opposite: one keeps
    // everything, the other destroys it. A single click is not enough.
    const del = CARD.slice(CARD.indexOf('Delete this campaign permanently?'))
    expect(del).toContain('requireTypedText')
    expect(del).toContain('danger: true')
  })

  it('points at Archive as the non-destructive alternative', () => {
    expect(CARD).toMatch(/Delete this campaign permanently\?[\s\S]{0,600}use Archive instead/)
  })

  it('tells the host to tear down its view before the list refreshes', () => {
    const handler = CARD.slice(CARD.indexOf('async function handleDelete'))
    const deletedAt = handler.indexOf('onDeleted?.()')
    const refreshAt = handler.indexOf('onRefresh()')
    expect(deletedAt).toBeGreaterThan(-1)
    expect(refreshAt).toBeGreaterThan(-1)
    expect(deletedAt, 'onDeleted must fire before onRefresh').toBeLessThan(refreshAt)
  })
})
