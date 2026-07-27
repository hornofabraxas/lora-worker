import type { RuinPost } from "./ruin.js";
import { renownActiveDays, renownFactor } from "./ruin.js";

// Renown is a per-day yield tied to a post's level (structurally the same as
// provisions), accumulated over each post's life. Unlike provisions it's never
// spent — it's permanent reputation and the leaderboard score. It stays tied to
// living posts: a razed or torn-down post drops out of post_summaries and stops
// contributing, so raiding a rival actually dents their standing. Like provisions,
// it also fades to 0 as a post falls into ruin (and freezes while warded), so the
// accrual pauses — see logic/ruin.ts — but already-earned renown is never lost.
export const RENOWN_PER_DAY_PER_LEVEL = 3;

// Longevity bonus: every day a post survives raises its renown/day by this much
// (uncapped). Long-held posts climb the leaderboard — but a high-standing post
// draws raids, so in practice this self-limits. Tunable.
export const RENOWN_AGE_BONUS_PER_DAY = 0.5;

type RenownPost = RuinPost & { level?: number };

/**
 * Renown a single post generates per day right now: a per-level base plus a slow
 * bonus for every accrued day, scaled by the ruin factor — so a post in ruin (or
 * dormant under a ward) yields 0/day. `active` is the ruin/ward-adjusted age.
 */
export function renownPerDay(post: RenownPost, now: number): number {
  const base = (post.level ?? 1) * RENOWN_PER_DAY_PER_LEVEL;
  const active = renownActiveDays(post, now);
  return (base + active * RENOWN_AGE_BONUS_PER_DAY) * renownFactor(post, now);
}

/** A player's total daily renown generation across all their posts. */
export function totalRenownPerDay(posts: RenownPost[], now: number): number {
  let total = 0;
  for (const post of posts) total += renownPerDay(post, now);
  return Math.round(total);
}

/**
 * Accumulated renown: each post's daily rate integrated over its *accrued* age.
 * The rate rises with age — rate(t) = base + c·t — so the integral is
 * base·active + c·active²/2 (quadratic, rewarding long-held posts). `active` is
 * the ruin/ward-adjusted age (logic/ruin.ts): time lost to ruin or a ward doesn't
 * accrue, so the total stops climbing while a post is neglected but never drops.
 * Stateless: derived from level, charter/upkeep times, and ward window.
 */
export function totalRenown(posts: RenownPost[], now: number): number {
  let total = 0;
  for (const post of posts) {
    const active = renownActiveDays(post, now);
    const base = (post.level ?? 1) * RENOWN_PER_DAY_PER_LEVEL;
    total += base * active + (RENOWN_AGE_BONUS_PER_DAY * active * active) / 2;
  }
  return Math.round(total);
}
