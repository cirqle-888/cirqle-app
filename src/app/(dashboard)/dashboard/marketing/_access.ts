/**
 * Who may see which part of the Client Marketing Hub. One place, so the client
 * list, the hub and its tabs agree — and every section keeps the gate of the
 * module it comes from (Social, Advertising, Leads, Asset Assignment).
 */

import { hasPermission, type CurrentUser } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'

export interface MarketingAccess {
  /** Pages, content plans and posts. */
  social: boolean
  socialInsights: boolean
  socialConnect: boolean
  socialPublish: boolean
  ads: boolean
  leads: boolean
  leadsManage: boolean
  assets: boolean
  connections: boolean
  cirqleAccounts: boolean
  any: boolean
}

export function marketingAccess(me: CurrentUser | null): MarketingAccess {
  // Fail-open with no employee record (pre-migration), as the other modules do.
  const can = (k: string | string[]) => !me || hasPermission(me, k)
  const social = can([PERMS.SOCIAL_VIEW, PERMS.SOCIAL_VIEW_INSIGHTS])
  const ads = can(PERMS.ADVERTISING_VIEW)
  const leads = can(PERMS.LEADS_VIEW)
  const assets = can(PERMS.ASSETS_ASSIGN)
  return {
    social,
    socialInsights: can(PERMS.SOCIAL_VIEW_INSIGHTS),
    socialConnect: can(PERMS.SOCIAL_CONNECT),
    socialPublish: can(PERMS.SOCIAL_PUBLISH),
    ads,
    leads,
    leadsManage: can(PERMS.LEADS_MANAGE),
    assets,
    connections: can(PERMS.ADVERTISING_MANAGE_PROVIDERS),
    cirqleAccounts: can(PERMS.ASSETS_VIEW_CIRQLE),
    any: social || ads || leads || assets,
  }
}
