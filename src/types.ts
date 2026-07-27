import type { KvStore } from "./kv/do_store.js";

export interface Env {
  PLAYERS: KVNamespace;
  ATTACKS: KVNamespace;
  DEFENSE: KVNamespace;
  SCOUTS: KVNamespace;
  META: KVNamespace;
  /** SQLite-backed Durable Object namespace backing all storage in production. */
  KV_DO?: DurableObjectNamespace<KvStore>;
  /** Shared secret guarding the /api/admin/* seeding & inspection endpoints. */
  ADMIN_SECRET?: string;
  /**
   * When set, /api/register requires a matching invite code, closing open
   * sybil registration. Unset (e.g. in tests) leaves registration open.
   */
  REGISTER_SECRET?: string;
  /**
   * Cloudflare Access application audience (AUD) tag and Zero Trust team
   * domain, guarding the browser-facing /admin surface. Both must be set for an
   * Access identity to be accepted — unset means /admin is reachable only with
   * the ADMIN_SECRET header. Neither is sensitive; they live in wrangler.toml.
   */
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  /** Optional comma-separated email allow-list, a second fence behind Access. */
  ADMIN_EMAILS?: string;
}

export interface PlayerProfile {
  player_id: string;
  display_name: string;
  registered_at: number;
  items: ItemRecord[];
  post_summaries: PostSummary[];
  secret_hash: string;
  /** Coarse cell centroid (lat/lng) for travel-time distance. Sent by the game server. */
  coarse_centroid?: { lat: number; lng: number };
  /** Unix seconds the centroid was last moved. Guards against teleport-before-raid. */
  centroid_updated_at?: number;
  /** Chosen display title (verbatim label). Client-trusted; echoed on the leaderboard. */
  active_title?: string;
  /**
   * Server-owned: unix seconds the Worker first saw each post (keyed by hex).
   * A post's charter age can never predate this, so renown's age term can't be
   * backdated by a modified client. Never set from the request body.
   */
  post_first_seen?: Record<string, number>;
  /**
   * Server-owned: each post's level the first time the Worker saw it. The
   * anti-cheat flag for "reached max level implausibly fast" is only meaningful
   * against growth we actually observed — a post that arrived already at max
   * predates our view of it (every new registrant's posts do, since first-seen
   * is their registration) and says nothing. Absent for posts that predate this
   * field, which are therefore never flagged on level growth.
   */
  post_first_level?: Record<string, number>;
  /**
   * Set by an operator to reversibly suspend a player: while true, all
   * authenticated writes are rejected (see auth middleware). History is kept.
   */
  frozen?: boolean;
}

export interface PostSummary {
  post_token: string;
  level: number;
  chartered_at: number;
  coarse_cell: string;
  // Player's custom (or auto-generated) name for this outpost. Echoed on the
  // leaderboard, scout reports, and raid notifications so rivals see the post's
  // chosen identity rather than a bare hex label. Absent on legacy bundles.
  name?: string;
  // Unix seconds until which the outpost is warded (dormant): not raidable.
  // 0 or absent = not warded.
  dormant_until?: number;
  // Ruin inputs (mirrors the game server's Outposts card). Renown fades to 0 as a
  // post falls into ruin and freezes while dormant under a ward; these let the
  // Worker reproduce that decay for the leaderboard. Absent on legacy bundles
  // (treated as freshly tended → full renown).
  last_tended_at?: number;
  warded_at?: number;
  grace_days?: number;
}

export interface ItemRecord {
  id: string;
  type: ItemType;
  assigned_at: number;
  used: boolean;
  installed_post_token?: string;
}

export type ItemType =
  | "probe"
  | "attack_common"
  | "attack_uncommon"
  | "attack_rare"
  | "attack_epic"
  | "defense_common"
  | "defense_uncommon"
  | "defense_rare"
  | "defense_epic";

// Attack power, doubled in the 2026-07-22 balance pass (was 15/35/75/150). Same-
// tier defense items were worth 2-2.7x an attack item (boost HP + install DR
// double-dip), making attacking a donation; doubling attack narrows that gulf
// without touching the defense-install identity. Keep in sync with the game
// server mirror (engine.ATTACK_ITEM_POWER) used for the client damage preview.
export const ITEM_ATTACK_POWER: Partial<Record<ItemType, number>> = {
  attack_common: 30,
  attack_uncommon: 70,
  attack_rare: 150,
  attack_epic: 300,
};

// Installed defense item = a permanent % damage reduction (rarer = more). The
// post's own per-level HP is the health pool; the item multiplies its effective
// value. Capped so no post is ever un-razable with enough firepower.
export const ITEM_DEFENSE_PCT: Partial<Record<ItemType, number>> = {
  defense_common: 0.08,
  defense_uncommon: 0.15,
  defense_rare: 0.25,
  defense_epic: 0.40,
};
export const MAX_DEFENSE_PCT = 0.6;

// Temporary flat-HP granted when a defense item is deployed as a reactive boost
// (distinct from ITEM_DEFENSE_PCT, which is the permanent damage reduction when
// the same item is *installed*). Flat HP with diminishing returns can never make
// a post invincible — enough total firepower always drains the pool. Deploying a
// boost is a real in-raid decision, not an obligation.
export const ITEM_BOOST_HP: Partial<Record<ItemType, number>> = {
  defense_common: 40,
  defense_uncommon: 80,
  defense_rare: 150,
  defense_epic: 300,
};

// Combat revision tunables (docs/combat-revision-2026-07.md §9).
export const TRAVEL_MIN_SECONDS = 3600; // 1h floor
export const TRAVEL_MAX_SECONDS = 43200; // 12h cap
export const TRAVEL_MAX_KM = 5000; // distance mapped to the 12h cap
export const BOOST_DURATION_SECONDS = 43200; // 12h (>= longest travel, so a boost raised on any warning is live at impact)
// 48h regen pause after a raid lands (was 12h). A defender otherwise healed
// 36+ HP between daily raids on top of the level reset, so a sustained campaign
// against an *active* defender couldn't make progress. 48h > the 24h per-target
// cooldown, so damage from one raid still stands when the next lands.
export const BESIEGED_DURATION_SECONDS = 172800;
export const BOOST_DR_FACTOR = 0.6; // each already-active boost scales the next by this
// Most live flat-HP boosts a post can hold at once. Drops make defense items
// cheap to stockpile, so an uncapped stack (even with the 0.6 DR falloff) let a
// determined defender sit behind ~700 effective HP indefinitely. Capping at 2
// keeps the reactive boost a real in-raid decision, not an obligation-to-hoard.
export const MAX_ACTIVE_BOOSTS = 2;
export const RAID_COOLDOWN_SECONDS = 86400; // 24h per-target cooldown
// A raze tombstone blocks re-adding a razed post until the game server reconciles
// (stops re-sending it), at which point it's cleared. This is only the safety net
// if that reconciliation never happens — long enough to comfortably outlast it.
export const RAZE_TOMBSTONE_TTL = 604800; // 7 days

export function isAttackItem(type: ItemType): boolean {
  return type.startsWith("attack_");
}

export function isDefenseItem(type: ItemType): boolean {
  return type.startsWith("defense_");
}

/** Highest post level in the game (game server: engine.MAX_POST_LEVEL). */
export const MAX_POST_LEVEL = 5;

export const POST_MAX_HP: Record<number, number> = {
  1: 50,
  2: 100,
  3: 175,
  4: 275,
  5: 400,
};

export interface ItemDrop {
  type: ItemType;
  id: string;
}

export interface Notification {
  type: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

// Legacy containers also send post_surveys / provisions_earned / xp_earned /
// field_notes_earned / coarse_cells; those rode along only for the (removed)
// public ledger feed and are now ignored entirely.
export interface BundleRequest {
  survey_count: number;
  discoveries: number;
  post_summaries?: PostSummary[];
  coarse_centroid?: { lat: number; lng: number };
  active_title?: string;
  /** Tier-IV munitions won from Expedition Contracts, minted idempotently by id. */
  item_grants?: { id: string; type: string }[];
  timestamp: number;
}

export interface RegisterRequest {
  display_name: string;
}

// Mirror of the game server's title registry (game/titles.py): postcard titles
// plus multiplayer titles. active_title is otherwise attacker-controlled text
// echoed onto every player's leaderboard, so only registry labels are stored.
export const KNOWN_TITLES: ReadonlySet<string> = new Set([
  // Postcard titles
  "Strider", "Trailblazer", "Relentless", "Steadfast", "Boundless",
  // Multiplayer titles
  "Warlord", "Vanguard", "Reaver", "Bulwark", "Pathfinder",
]);

export interface DefenseValues {
  base_defense: number;
  survey_bonus: number;
  defense_item: ItemType | null;
  defense_value: number;
  hp: number;
  max_hp: number;
  hp_updated_at: number;
  /** Temporary flat-HP boosts, soaked before base HP. Optional for back-compat. */
  boosts?: BoostRecord[];
  /** Passive HP regen paused until this unix time (set when a raid lands). */
  besieged_until?: number;
}

export interface BoostRecord {
  item_type: ItemType;
  hp_remaining: number;
  hp_initial: number;
  installed_at: number;
  expires_at: number;
}

/** An in-flight or resolved multi-item raid. */
export interface RaidRecord {
  raid_id: string;
  attacker_id: string;
  attacker_name: string;
  target_player_id: string;
  target_player_name: string;
  target_post_token: string;
  // Name of the raided outpost at dispatch time, so the attacker's result card
  // and the defender's notification can name the post rather than just the hex.
  target_post_name?: string;
  item_types: ItemType[];
  raw_power: number;
  dispatched_at: number;
  arrives_at: number;
  status: "in_flight" | "resolved";
  outcome?: "razed" | "damaged" | "defended";
  damage_dealt?: number;
  hp_after?: number;
  level_after?: number;
  resolved_at?: number;
  // Survey marks the attacker earns from this raid (raze = 10x razed level,
  // damaged = 2x level, defended = 0). Marks live on the player-run game server,
  // so the Worker only records the amount here; the attacker's game server reads
  // it off the resolved raid (araidlast) and credits it locally, exactly once.
  spoils_marks?: number;
}

export type ThreatBand = "raze" | "heavy" | "hold";

export interface ScoutResult {
  scout_id: string;
  scouter: string;
  target_player: string;
  post_level: number;
  post_age_days: number;
  post_count: number;
  created_at: number;
  // Fuzzed straight-line distance (miles) between the scouter and target coarse
  // centroids, rounded to the nearest 50mi. null when either centroid is
  // unknown. Distance is hidden on the leaderboard and only revealed here, so a
  // player must spend a probe to learn roughly how far a rival sits.
  distance_mi?: number | null;
}

