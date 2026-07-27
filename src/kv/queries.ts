import type { Env, PlayerProfile, Notification, DefenseValues, RaidRecord } from "../types.js";
import { POST_MAX_HP, RAZE_TOMBSTONE_TTL } from "../types.js";
import { playerKey, playerLastBundleKey, notificationsKey, defenseKey, razeTombstoneKey, razeTombstonePrefix, PLAYER_INDEX_KEY, LEADERBOARD_CACHE_KEY, auditRejectKey, isPlayerProfileKey, AUDIT_REJECT_PREFIX } from "./schema.js";
import { batch } from "./do_store.js";

export async function getPlayer(env: Env, playerId: string): Promise<PlayerProfile | null> {
  return env.PLAYERS.get<PlayerProfile>(playerKey(playerId), "json");
}

export async function putPlayer(env: Env, player: PlayerProfile): Promise<void> {
  await env.PLAYERS.put(playerKey(player.player_id), JSON.stringify(player));
  // NB: intentionally does NOT invalidate the leaderboard snapshot. Gameplay
  // writes (bundles, raid resolution) happen constantly; invalidating here put
  // every leaderboard poll on a ~5-RPC rebuild. The snapshot instead refreshes on
  // its stale window + the 6h cron, and roster changes (register/delete) still
  // invalidate explicitly. See logic/leaderboard.ts (LEADERBOARD_STALE_SECONDS).
}

// Batched read of many players in one RPC (see BatchKV.getMany). Skips ids with
// no stored profile. Used by the leaderboard rebuild so it never fans out into
// one subrequest per player.
export async function getPlayersByIds(env: Env, ids: string[]): Promise<PlayerProfile[]> {
  if (ids.length === 0) return [];
  const raws = await batch(env.PLAYERS).getMany(ids.map(playerKey));
  const players: PlayerProfile[] = [];
  for (const raw of raws) {
    if (raw) players.push(JSON.parse(raw) as PlayerProfile);
  }
  return players;
}

export async function getLastBundleTime(env: Env, playerId: string): Promise<number | null> {
  const val = await env.PLAYERS.get(playerLastBundleKey(playerId));
  return val ? parseInt(val, 10) : null;
}

export async function setLastBundleTime(env: Env, playerId: string, timestamp: number): Promise<void> {
  await env.PLAYERS.put(playerLastBundleKey(playerId), String(timestamp));
}

// --- Audit counters ---------------------------------------------------------
// A rolling count of rejected authenticated requests per player (bad signature,
// frozen, or an anti-cheat validation reject). A modified client probing the API
// shows up here, so the admin flags report can surface it. Keyed by the *claimed*
// player id, so a spoofed id can only inflate its own count — a review signal, not
// an enforcement gate.
export async function bumpAuditReject(env: Env, playerId: string): Promise<void> {
  const key = auditRejectKey(playerId);
  const count = parseInt(await env.META.get(key) ?? "0", 10);
  await env.META.put(key, String(count + 1), { expirationTtl: 604800 }); // 7d
}

export async function getAuditReject(env: Env, playerId: string): Promise<number> {
  return parseInt(await env.META.get(auditRejectKey(playerId)) ?? "0", 10);
}

// --- Whole-roster reads -----------------------------------------------------
// The admin reports (flags, name review, player search) each need every player.
// Doing that with a get per id costs 1 subrequest per player, and Cloudflare caps
// a request at 50 subrequests on the free plan (1000 on paid) — so a per-player
// fan-out doesn't get slow as the roster grows, it starts throwing. These read
// the whole `player:` prefix in a single range scan instead, which costs one RPC
// at any roster size. See docs/admin-scaling-2026-07.md.

// Backstop ceiling on a roster scan. Far above any plausible roster (the Worker
// is sized for ~560 players) — it exists so the scan can never become unbounded,
// not as a paging boundary.
export const PLAYER_SCAN_LIMIT = 20000;

/**
 * Decode profiles out of a `player:` prefix scan. Skips the
 * `player:<id>:last_bundle` markers that share the prefix, and tolerates an
 * unparseable row rather than failing the whole report over one bad record.
 */
export function playersFromRows(rows: { key: string; value: string }[]): PlayerProfile[] {
  const players: PlayerProfile[] = [];
  for (const row of rows) {
    if (!isPlayerProfileKey(row.key)) continue;
    try {
      players.push(JSON.parse(row.value) as PlayerProfile);
    } catch {
      // A corrupt row shouldn't blind the operator to every other player.
    }
  }
  return players;
}

/** Decode an `audit:reject:` prefix scan into playerId -> count. */
export function auditRejectsFromRows(rows: { key: string; value: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = row.key.slice(AUDIT_REJECT_PREFIX.length);
    const n = parseInt(row.value, 10);
    if (id && Number.isFinite(n)) counts.set(id, n);
  }
  return counts;
}

export async function getPlayerIndex(env: Env): Promise<string[]> {
  return await env.META.get<string[]>(PLAYER_INDEX_KEY, "json") ?? [];
}

export async function addToPlayerIndex(env: Env, playerId: string): Promise<void> {
  const index = await getPlayerIndex(env);
  if (!index.includes(playerId)) {
    index.push(playerId);
    await env.META.put(PLAYER_INDEX_KEY, JSON.stringify(index));
    // A roster change (unlike a gameplay write) should show on the leaderboard at
    // once, so invalidate the snapshot here — the symmetric spot to removal.
    await env.META.delete(LEADERBOARD_CACHE_KEY);
  }
}

export async function removeFromPlayerIndex(env: Env, playerId: string): Promise<void> {
  const index = await getPlayerIndex(env);
  const next = index.filter((id) => id !== playerId);
  if (next.length !== index.length) {
    await env.META.put(PLAYER_INDEX_KEY, JSON.stringify(next));
  }
  // Drop the leaderboard snapshot so a deleted player disappears immediately.
  await env.META.delete(LEADERBOARD_CACHE_KEY);
}

export async function getNotifications(env: Env, playerId: string): Promise<Notification[]> {
  const raw = await env.SCOUTS.get<Notification[]>(notificationsKey(playerId), "json");
  return raw ?? [];
}

export async function clearNotifications(env: Env, playerId: string): Promise<void> {
  await env.SCOUTS.delete(notificationsKey(playerId));
}

export async function appendNotification(env: Env, playerId: string, notification: Notification): Promise<void> {
  const existing = await getNotifications(env, playerId);
  existing.push(notification);
  await env.SCOUTS.put(notificationsKey(playerId), JSON.stringify(existing));
}

export async function getDefense(env: Env, playerId: string, postToken: string): Promise<DefenseValues | null> {
  return env.DEFENSE.get<DefenseValues>(defenseKey(playerId, postToken), "json");
}

export async function putDefense(env: Env, playerId: string, postToken: string, defense: DefenseValues): Promise<void> {
  await env.DEFENSE.put(defenseKey(playerId, postToken), JSON.stringify(defense));
}

// The defense row a post starts with before anyone installs an item. Shared by
// getOrCreateDefense (which persists it) and the composite read paths (which
// materialize it in memory and persist only if the post had no row yet).
export function defaultDefense(postLevel: number, now: number): DefenseValues {
  const maxHp = POST_MAX_HP[postLevel] ?? 50;
  return {
    base_defense: 10,
    survey_bonus: 0,
    defense_item: null,
    defense_value: 0,
    hp: maxHp,
    max_hp: maxHp,
    hp_updated_at: now,
  };
}

export async function getOrCreateDefense(env: Env, playerId: string, postToken: string, postLevel: number = 1): Promise<DefenseValues> {
  const existing = await getDefense(env, playerId, postToken);
  if (existing) return existing;
  const fresh = defaultDefense(postLevel, Math.floor(Date.now() / 1000));
  await putDefense(env, playerId, postToken, fresh);
  return fresh;
}

// --- Raze tombstones --------------------------------------------------------
// A razed post is permanently gone. The tombstone stops a game server that
// hasn't yet reconciled the raze from resurrecting the post by re-sending it in
// a bundle. Cleared once the server stops asserting the post (see the bundle
// route), so the same location can be chartered fresh afterward.

export async function addRazeTombstone(env: Env, playerId: string, postToken: string): Promise<void> {
  await env.DEFENSE.put(razeTombstoneKey(playerId, postToken), String(Math.floor(Date.now() / 1000)), {
    expirationTtl: RAZE_TOMBSTONE_TTL,
  });
}

export async function listRazeTombstones(env: Env, playerId: string): Promise<Set<string>> {
  const prefix = razeTombstonePrefix(playerId);
  const list = await env.DEFENSE.list({ prefix });
  const hexes = new Set<string>();
  for (const key of list.keys) hexes.add(key.name.slice(prefix.length));
  return hexes;
}

export async function clearRazeTombstone(env: Env, playerId: string, postToken: string): Promise<void> {
  await env.DEFENSE.delete(razeTombstoneKey(playerId, postToken));
}

// --- Raids (in-flight multi-item combat) -----------------------------------
// Keyed under the ATTACKS namespace: raid records by target so a defender's
// incoming raids list by prefix; an attacker pointer enforces one-in-flight;
// a TTL'd cooldown key enforces the 24h per-target limit.

// In-flight records are written without a TTL (they must survive until they
// resolve, however long the party travels). A resolved record is only needed
// briefly — for attacker-pointer reconciliation — so it's written with a TTL so
// the raid: keyspace `resolveDueRaids` scans stays bounded (see RESOLVED_RAID_TTL).
export async function putRaid(env: Env, raid: RaidRecord, ttlSeconds?: number): Promise<void> {
  const key = `raid:${raid.target_player_id}:${raid.raid_id}`;
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await env.ATTACKS.put(key, JSON.stringify(raid), opts);
}

export async function listRaids(env: Env, targetId?: string): Promise<RaidRecord[]> {
  const prefix = targetId ? `raid:${targetId}:` : "raid:";
  // One RPC returns every raid record body under the prefix — no follow-up get
  // per key. The trailing colon keeps `araid:`/`raidcd:` siblings out of range.
  const rows = await batch(env.ATTACKS).listValues(prefix);
  const raids: RaidRecord[] = [];
  for (const row of rows) {
    raids.push(JSON.parse(row.value) as RaidRecord);
  }
  return raids;
}

export async function getActiveRaidId(env: Env, attackerId: string): Promise<string | null> {
  return env.ATTACKS.get(`araid:${attackerId}`);
}

// The one-in-flight lock. A raid resolves (and clears this lock atomically)
// within travel time + a cron cycle — far under this TTL — so it never fires for
// a live raid. It exists only as a hard ceiling: the lock can never outlive a
// raid and wedge the attacker out of dispatching, even if a record is lost.
const ACTIVE_RAID_LOCK_TTL = 172800; // 48h

export async function setActiveRaid(env: Env, attackerId: string, raidId: string): Promise<void> {
  await env.ATTACKS.put(`araid:${attackerId}`, raidId, { expirationTtl: ACTIVE_RAID_LOCK_TTL });
}

// The attacker's most recent raid record, kept (48h TTL) even after the raid
// resolves and the active pointer is cleared — so the attacker can see the
// outcome ("your party razed X"). Written on dispatch and on resolution.
export async function putAttackerLastRaid(env: Env, raid: RaidRecord): Promise<void> {
  await env.ATTACKS.put(`araidlast:${raid.attacker_id}`, JSON.stringify(raid), {
    expirationTtl: 172800, // 48h
  });
}

export async function getAttackerLastRaid(env: Env, attackerId: string): Promise<RaidRecord | null> {
  return env.ATTACKS.get<RaidRecord>(`araidlast:${attackerId}`, "json");
}

export async function getRaidCooldown(env: Env, attackerId: string, targetPostToken: string): Promise<number | null> {
  const v = await env.ATTACKS.get(`raidcd:${attackerId}:${targetPostToken}`);
  return v ? parseInt(v, 10) : null;
}

export async function setRaidCooldown(env: Env, attackerId: string, targetPostToken: string, now: number): Promise<void> {
  await env.ATTACKS.put(`raidcd:${attackerId}:${targetPostToken}`, String(now), { expirationTtl: 86400 });
}

// All of an attacker's live per-target cooldowns, keyed by target_post_token —
// one RPC via listValues instead of a get-per-target loop. Expired entries
// don't appear (the KV TTL already reclaims them), so callers never need to
// re-check RAID_COOLDOWN_SECONDS themselves beyond what's returned here.
export async function getRaidCooldowns(env: Env, attackerId: string): Promise<Record<string, number>> {
  const prefix = `raidcd:${attackerId}:`;
  const rows = await batch(env.ATTACKS).listValues(prefix);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const targetPostToken = row.name.slice(prefix.length);
    out[targetPostToken] = parseInt(row.value, 10);
  }
  return out;
}

