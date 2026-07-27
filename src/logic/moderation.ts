import type { Env } from "../types.js";

// Manual, admin-driven name moderation for the PUBLIC surfaces (leaderboard,
// scout results, raid notifications). Post names and player display names arrive
// verbatim from self-hosted game servers and are overwritten on every bundle
// sync, so a censored name can't live on the player record — it would be
// clobbered on the next sync. Instead we keep a small override map here and
// apply it on READ, so the override always wins regardless of what a node sends.
//
// There is deliberately no wordlist: this is a small trusted friend-group game,
// so moderation is reactive — an operator spots a name via GET /api/admin/names
// and censors it via POST /api/admin/censor.

export const MODERATION_KEY = "moderation:names";

// Neutral labels used when an override has an empty replacement (i.e. "just hide
// it" rather than "rename it to X").
export const POST_FALLBACK = "Outpost";
export const PLAYER_FALLBACK = "Surveyor";

export interface ModerationOverrides {
  /** "<player_id>:<post_hex>" -> replacement ("" = neutral fallback). */
  posts: Record<string, string>;
  /** "<player_id>" -> replacement ("" = neutral fallback). */
  players: Record<string, string>;
}

export function postOverrideKey(playerId: string, postHex: string): string {
  return `${playerId}:${postHex}`;
}

export async function getOverrides(env: Env): Promise<ModerationOverrides> {
  const raw = await env.META.get<ModerationOverrides>(MODERATION_KEY, "json");
  return { posts: raw?.posts ?? {}, players: raw?.players ?? {} };
}

/** Decode overrides already pulled as part of a larger snapshot read. */
export function parseOverrides(raw: string | null): ModerationOverrides {
  if (!raw) return { posts: {}, players: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<ModerationOverrides>;
    return { posts: parsed.posts ?? {}, players: parsed.players ?? {} };
  } catch {
    return { posts: {}, players: {} };
  }
}

export async function putOverrides(env: Env, o: ModerationOverrides): Promise<void> {
  await env.META.put(MODERATION_KEY, JSON.stringify(o));
}

/** Returns the public-safe post name, applying any override. */
export function applyPostName(
  o: ModerationOverrides,
  playerId: string,
  postHex: string,
  name: string,
): string {
  const k = postOverrideKey(playerId, postHex);
  if (Object.prototype.hasOwnProperty.call(o.posts, k)) {
    return o.posts[k] || POST_FALLBACK;
  }
  return name;
}

/** Returns the public-safe display name, applying any override. */
export function applyPlayerName(
  o: ModerationOverrides,
  playerId: string,
  name: string,
): string {
  if (Object.prototype.hasOwnProperty.call(o.players, playerId)) {
    return o.players[playerId] || PLAYER_FALLBACK;
  }
  return name;
}
