import type { Env, PlayerProfile } from "../types.js";
import { totalRenown, totalRenownPerDay } from "./renown.js";
import { getPlayerIndex, getPlayersByIds, purgePlayerData } from "../kv/queries.js";
import { LEADERBOARD_CACHE_KEY } from "../kv/schema.js";

// How long a snapshot may be served before a read rebuilds it. Gameplay writes
// (bundles, raid resolution) no longer invalidate it — only registration and
// deletion do (roster changes should show immediately). So this window governs
// how stale renown/post changes may be, and is matched to the 6h cron that also
// refreshes it: reads between rebuilds are served straight from cache (2 RPCs),
// and renown — which accrues over days — drifting up to 6h is imperceptible on a
// ranking. This keeps the leaderboard poll off the per-bundle rebuild treadmill.
export const LEADERBOARD_STALE_SECONDS = 6 * 3600;

// One precomputed row per player. Names are stored raw and moderated at read
// time (so an operator censor takes effect immediately without a rebuild).
// post_token values are opaque per-post tokens minted by the game server — they
// identify a raid/scout target, not a place.
export interface LeaderboardEntry {
  player_id: string;
  display_name: string;
  active_title: string | null;
  total_renown: number;
  renown_per_day: number;
  post_count: number;
  post_tokens: string[];
  posts: { post_token: string; name: string }[];
}

export interface LeaderboardCache {
  built_at: number;
  entries: LeaderboardEntry[];
}

function toEntry(p: PlayerProfile, now: number): LeaderboardEntry {
  return {
    player_id: p.player_id,
    display_name: p.display_name,
    active_title: p.active_title ?? null,
    total_renown: totalRenown(p.post_summaries, now),
    renown_per_day: totalRenownPerDay(p.post_summaries, now),
    post_count: p.post_summaries.length,
    post_tokens: p.post_summaries.map((s) => s.post_token),
    posts: p.post_summaries.map((s) => ({ post_token: s.post_token, name: s.name ?? "" })),
  };
}

/**
 * Rebuild the snapshot from the player index using a single batched read — no
 * per-player fan-out, so it costs a fixed handful of subrequests no matter how
 * many players there are. Called on a stale/missing read and from the cron.
 */
export async function rebuildLeaderboardCache(
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<LeaderboardCache> {
  const ids = await getPlayerIndex(env);
  const players = await getPlayersByIds(env, ids);
  const cache: LeaderboardCache = {
    built_at: now,
    entries: players.map((p) => toEntry(p, now)),
  };
  await env.META.put(LEADERBOARD_CACHE_KEY, JSON.stringify(cache));
  return cache;
}

// How many top ranks must be free of NPCs before the whole garrison retires.
// Matches the seeded garrison size: once real players hold this entire band, the
// scaffolding has done its job.
export const NPC_RETIRE_TOP_N = 8;

/**
 * Retire the seeded NPC garrison once real players own the top band.
 *
 * The garrison (players seeded with `npc: true`) exists so the first registrants
 * must earn their standing instead of inheriting an empty #1. It removes itself:
 * the first time NO npc sits in the top `NPC_RETIRE_TOP_N` by renown, every npc
 * is purged in a single pass — all-or-nothing, so the board never shows a
 * half-emptied garrison. While even one npc still holds a top slot, the whole
 * garrison stays. Returns the number of NPCs retired (0 if none, or if the band
 * still contains one).
 *
 * Runs from the 6h cron, off the hot path — `purgePlayerData` is scan-heavy by
 * design, and this fires at most once in the garrison's life (after which there
 * are no NPCs left to find).
 */
export async function retireGarrisonIfClear(
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const ids = await getPlayerIndex(env);
  const players = await getPlayersByIds(env, ids);
  const npcIds = players.filter((p) => p.npc).map((p) => p.player_id);
  if (npcIds.length === 0) return 0;

  const ranked = players
    .map((p) => ({ npc: !!p.npc, renown: totalRenown(p.post_summaries, now) }))
    .sort((a, b) => b.renown - a.renown);

  // A smaller-than-band field always still contains the NPCs, so this correctly
  // keeps them while the community is tiny.
  if (ranked.slice(0, NPC_RETIRE_TOP_N).some((r) => r.npc)) return 0;

  for (const id of npcIds) await purgePlayerData(env, id);
  await rebuildLeaderboardCache(env, now);
  return npcIds.length;
}

/** Serve the snapshot, rebuilding only if it's missing or past its stale window. */
export async function getLeaderboardCache(
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<LeaderboardCache> {
  const cached = await env.META.get<LeaderboardCache>(LEADERBOARD_CACHE_KEY, "json");
  if (cached && now - cached.built_at <= LEADERBOARD_STALE_SECONDS) return cached;
  return rebuildLeaderboardCache(env, now);
}
