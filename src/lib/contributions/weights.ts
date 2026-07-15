/**
 * Group-weight normalization — display-side mirror of the commission engine.
 *
 * `contribution_groups.weight` is a RELATIVE importance value, not a fixed
 * percentage. The engine (src/lib/calculations/commission.ts, step 1)
 * normalizes over the groups active on each task:
 *
 *   portion_i = weight_i / Σ weight(active groups) × 100
 *
 * so any combination of groups always splits exactly 100% of the pool.
 * This helper reproduces that math for previews (e.g. the Service form)
 * WITHOUT touching the engine itself.
 *
 * Future extension point — per-service weight overrides: if a nullable
 * `weight` column is ever added to the `group_services` junction, resolve
 * each group's weight as `junction.weight ?? group.weight` BEFORE calling
 * normalizeGroupWeights, and pass the same resolved weights to
 * calculateCommission. Nothing else needs to change.
 */

export interface WeightedGroup {
  id: string
  name: string
  weight: number
}

/** Normalized split for a set of groups; pct values sum to 100 (or all 0 when the set is empty / weightless). */
export function normalizeGroupWeights<T extends WeightedGroup>(groups: T[]): (T & { pct: number })[] {
  const total = groups.reduce((s, g) => s + (g.weight || 0), 0)
  return groups.map(g => ({
    ...g,
    pct: total > 0 ? ((g.weight || 0) / total) * 100 : 0,
  }))
}

/** Compact "Design 50% · Products 50%" label for a normalized split. */
export function formatGroupSplit(groups: WeightedGroup[]): string {
  return normalizeGroupWeights(groups)
    .map(g => `${g.name.replace(' Group', '')} ${g.pct.toFixed(g.pct % 1 === 0 ? 0 : 1)}%`)
    .join(' · ')
}
