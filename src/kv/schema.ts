// Logical namespace names — the prefixes that keep the conceptual KV spaces
// isolated inside the single consolidated DO instance. Match the binding names in
// index.ts KV_BINDINGS. Composite reads/writes (kv/composite.ts) address rows by
// (namespace, key), so these are the source of truth for that qualification.
// (LEDGER was retired 2026-07-23 with the public activity feed; its rows carry a
// ≤7-day TTL and age out of the DO on their own.)
export const NS = {
  PLAYERS: "PLAYERS",
  ATTACKS: "ATTACKS",
  DEFENSE: "DEFENSE",
  SCOUTS: "SCOUTS",
  META: "META",
} as const;

export const PLAYER_PREFIX = "player:";

export function playerKey(playerId: string): string {
  return `${PLAYER_PREFIX}${playerId}`;
}

export function playerLastBundleKey(playerId: string): string {
  return `${PLAYER_PREFIX}${playerId}:last_bundle`;
}

// True for a stored profile row, false for the `player:<id>:last_bundle` markers
// that share the prefix. A whole-roster scan (the admin reports) reads the prefix
// once and separates the two on key shape — a profile key has exactly one colon,
// a marker has two — rather than paying a second scan or a per-player get.
export function isPlayerProfileKey(key: string): boolean {
  return key.startsWith(PLAYER_PREFIX) && !key.includes(":", PLAYER_PREFIX.length);
}

// Rolling per-player counter of rejected authenticated requests (see
// bumpAuditReject). TTL'd and sparse — only players who have actually been
// rejected have a row — so the flags report pulls the whole prefix in one range
// read instead of one get per player.
export const AUDIT_REJECT_PREFIX = "audit:reject:";

export function auditRejectKey(playerId: string): string {
  return `${AUDIT_REJECT_PREFIX}${playerId}`;
}

export function rateLimitKey(
  playerId: string,
  hour: number,
): string {
  return `ratelimit:${playerId}:bundles:${hour}`;
}

export function defenseKey(playerId: string, postHex: string): string {
  return `defense:${playerId}:${postHex}`;
}

// A razed post leaves a tombstone so a lagging game server can't resurrect it by
// re-sending it in a bundle before it reconciles the raze locally. Stored in the
// DEFENSE namespace under a distinct `razed:` prefix (regen scans `defense:`).
export function razeTombstoneKey(playerId: string, postHex: string): string {
  return `razed:${playerId}:${postHex}`;
}

export function razeTombstonePrefix(playerId: string): string {
  return `razed:${playerId}:`;
}

export function scoutKey(scoutId: string): string {
  return `scout:${scoutId}`;
}

export function notificationsKey(playerId: string): string {
  return `notifications:${playerId}`;
}

export const PLAYER_INDEX_KEY = "player_index";

// Precomputed leaderboard snapshot (see logic/leaderboard.ts). Lives in META.
// Defined here — the lowest module in the import graph — so both the query layer
// (which invalidates it on any player write) and the leaderboard logic can share
// it without an import cycle.
export const LEADERBOARD_CACHE_KEY = "leaderboard_cache";
