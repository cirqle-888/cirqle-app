/** Tuning knobs for Design QA's heuristics, gathered in one place so a
 * reviewer tightening/loosening the checks doesn't have to hunt through
 * qaEngine.ts. All units are px unless noted otherwise. */

/** Two corner-radius values within this many px of each other are treated
 * as "the same" radius when clustering. */
export const RADIUS_TOLERANCE_PX = 1;

/** Auto-layout itemSpacing values within this many px of the scope's modal
 * spacing value are considered consistent. */
export const SPACING_TOLERANCE_PX = 2;

/** Per-channel (0-255) tolerance when comparing a resolved fill/stroke hex
 * against a local variable's resolved hex for missing-variable-binding. */
export const COLOR_CHANNEL_TOLERANCE = 2;

/** Shadow offset-x/offset-y bucket size used when clustering shadow
 * signatures — two shadows whose offsets round to the same bucket are
 * treated as the same shadow for comparison purposes. */
export const SHADOW_OFFSET_TOLERANCE_PX = 1;
/** Same idea for blur (effect `radius`) and spread. */
export const SHADOW_BLUR_TOLERANCE_PX = 2;
export const SHADOW_SPREAD_TOLERANCE_PX = 1;

/** Max number of individual per-node issues emitted for
 * inconsistent-typography before the rest are folded into the aggregate
 * issue only (keeps a 10k-layer file's result set from exploding). */
export const TYPOGRAPHY_SAMPLE_CAP = 25;

/** Max number of duplicate-text-style group issues emitted. */
export const DUPLICATE_SAMPLE_CAP = 25;

/** A FRAME needs at least this many direct children before
 * missing-auto-layout even considers it as a row/column candidate. */
export const MIN_AUTO_LAYOUT_CANDIDATE_CHILDREN = 3;

/** Gap-to-gap and cross-axis tolerance used by the missing-auto-layout
 * evenly-spaced-row/column pattern detector. */
export const EVEN_SPACING_TOLERANCE_PX = 2;

/** Minimum sample size before the statistical clustering rules
 * (inconsistent-spacing/radius/shadow) bother reporting anything — below
 * this there isn't enough data to call something an "outlier". */
export const MIN_SAMPLE_SIZE_FOR_CLUSTERING = 3;
