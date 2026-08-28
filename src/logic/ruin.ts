// Ruin decay, mirrored from the game server (game/engine.py). A post pays full
// yield for RUIN_GRACE_DAYS after its last upkeep, then its yield ramps linearly
// to zero across RUIN_RAMP_DAYS. Renown fades on the same curve as provisions and
// freezes entirely while a post is dormant under a ward. Keep these constants and
// the factor math in sync with the Python side.
export const RUIN_GRACE_DAYS = 6;
export const RUIN_RAMP_DAYS = 4;

export interface RuinPost {
  chartered_at: number;
  last_tended_at?: number;
  warded_at?: number;
  dormant_until?: number;
  grace_days?: number;
}

/** Instantaneous yield multiplier (0..1) for a post `ageDays` since last upkeep. */
export function ruinIncomeFactor(ageDays: number, grace = RUIN_GRACE_DAYS): number {
  const rampEnd = grace + RUIN_RAMP_DAYS;
  if (ageDays <= grace) return 1;
  if (ageDays >= rampEnd) return 0;
  return (rampEnd - ageDays) / RUIN_RAMP_DAYS;
}

/**
 * Number of "full-value" days earned across an age window [a0, a1] — the integral
 * of the yield factor. Mirrors game/engine.py ruin_effective_days: full credit up
 * to `grace`, half-credit across the ramp, nothing after.
 */
export function ruinEffectiveDays(a0: number, a1: number, grace = RUIN_GRACE_DAYS): number {
  const rampEnd = grace + RUIN_RAMP_DAYS;
  const anti = (a: number): number => {
    if (a <= grace) return a;
    if (a >= rampEnd) return grace + RUIN_RAMP_DAYS / 2;
    return grace + (rampEnd * (a - grace) - (a * a - grace * grace) / 2) / RUIN_RAMP_DAYS;
  };
  return Math.max(0, anti(a1) - anti(a0));
}

/** True while the post is dormant under a ward (no yield, ruin timer paused). */
export function isWarded(post: RuinPost, now: number): boolean {
  return !!(post.dormant_until && now < post.dormant_until);
}

/**
 * Seconds of [start, end] overlapping the post's ward window [warded_at,
 * dormant_until]. Mirrors game/engine.py _ward_overlap; only the current/most
 * recent ward window is tracked, so ruin excludes exactly that span.
 */
function wardOverlapSecs(post: RuinPost, start: number, end: number): number {
  const wardStart = post.warded_at;
  const wardEnd = post.dormant_until;
  if (!wardStart || !wardEnd) return 0;
  return Math.max(0, Math.min(end, wardEnd) - Math.max(start, wardStart));
}

/** Age in days since last upkeep, excluding time frozen under a ward. */
function ageSinceUpkeepDays(post: RuinPost, now: number): number {
  const lastTended = post.last_tended_at ?? post.chartered_at;
  const secs = now - lastTended - wardOverlapSecs(post, lastTended, now);
  return Math.max(0, secs / 86400);
}

/**
 * Instantaneous renown multiplier (0..1): 0 while dormant under a ward, otherwise
 * the ruin factor for the (ward-excluded) time since the post's last upkeep. A
 * post with no last-upkeep data (legacy bundle) is treated as maintained (1.0).
 */
export function renownFactor(post: RuinPost, now: number): number {
  if (isWarded(post, now)) return 0;
  if (post.last_tended_at == null) return 1;
  return ruinIncomeFactor(ageSinceUpkeepDays(post, now), post.grace_days ?? RUIN_GRACE_DAYS);
}

/**
 * Days of renown a post has actually accrued: its lifetime minus time frozen
 * under a ward, minus the days lost to ruin past the grace window (weighted by
 * the fading factor across the ramp). Ruin and ward both pause accrual, so this
 * plateaus while a post is neglected or dormant and resumes when it's tended —
 * the leaderboard total stops climbing but never drops.
 */
export function renownActiveDays(post: RuinPost, now: number): number {
  const activeSecs = now - post.chartered_at - wardOverlapSecs(post, post.chartered_at, now);
  const activeAge = Math.max(0, activeSecs / 86400);
  // No last-upkeep data (legacy bundle): count the full lifetime, no ruin decay.
  if (post.last_tended_at == null) return activeAge;
  const grace = post.grace_days ?? RUIN_GRACE_DAYS;
  const ageSinceUpkeep = ageSinceUpkeepDays(post, now);
  const ruinLost = ageSinceUpkeep - ruinEffectiveDays(0, ageSinceUpkeep, grace);
  return Math.max(0, activeAge - ruinLost);
}
