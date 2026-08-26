/**
 * Service picker ordering — committed work first.
 *
 * Once a client is chosen, most service picks are not arbitrary: the client is
 * usually owed something specific. Two signals say so, and they differ in
 * strength:
 *
 *   package  a line in an ACTIVE client package — work already contracted
 *   agreed   a negotiated rate in the pricing matrix — a standing arrangement,
 *            but not an obligation to deliver anything in particular
 *
 * Both beat "some service this office happens to use a lot", so they are
 * pinned above the usage-sorted list rather than left to compete with it.
 * Everything not pinned is returned in the order it was given, which the
 * Combobox then smart-sorts into Recently / Frequently Used as before — the
 * point is to add a shortcut, not to take the existing one away.
 */

export interface ServiceLike { id: string; name: string }

export interface ServiceOption {
  id: string
  label: string
  sub?: string
  group?: string
}

export const PACKAGE_GROUP = 'In Their Package'
export const AGREED_GROUP  = 'Agreed Pricing'

export function buildServiceOptions(
  /** Services in display order — already usage-sorted by the caller. */
  services: readonly ServiceLike[],
  opts: {
    packageServiceIds?: ReadonlySet<string>
    agreedServiceIds?: ReadonlySet<string>
  } = {},
): ServiceOption[] {
  const pkg = opts.packageServiceIds
  const agreed = opts.agreedServiceIds

  // No client chosen (or nothing committed) → the plain list, ungrouped, so
  // the Combobox behaves exactly as it always has.
  if (!pkg?.size && !agreed?.size) {
    return services.map(s => ({ id: s.id, label: s.name }))
  }

  const inPackage: ServiceOption[] = []
  const agreedOnly: ServiceOption[] = []
  const rest: ServiceOption[] = []

  for (const s of services) {
    // A service in both a package and the pricing matrix appears ONCE, under
    // Package — the stronger claim. Listing it twice would make the shortcut
    // longer than the thing it is shortcutting.
    if (pkg?.has(s.id)) {
      inPackage.push({ id: s.id, label: s.name, sub: 'in their package', group: PACKAGE_GROUP })
    } else if (agreed?.has(s.id)) {
      agreedOnly.push({ id: s.id, label: s.name, sub: 'agreed rate', group: AGREED_GROUP })
    } else {
      rest.push({ id: s.id, label: s.name })
    }
  }

  return [...inPackage, ...agreedOnly, ...rest]
}
