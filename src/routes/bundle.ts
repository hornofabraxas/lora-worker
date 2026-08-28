import { Hono } from "hono";
import type { Env, BundleRequest, PostSummary, PlayerProfile, Notification } from "../types.js";
import { MAX_POST_LEVEL, KNOWN_TITLES } from "../types.js";
import { precheckAuthHeaders, verifyPlayerSignature } from "../middleware/auth.js";
import {
  playerKey, playerLastBundleKey, notificationsKey,
  razeTombstoneKey, razeTombstonePrefix, defenseKey, rateLimitKey, PLAYER_INDEX_KEY, NS,
} from "../kv/schema.js";
import { snapshotRead, MutationBuffer } from "../kv/composite.js";
import { computeDrops } from "../logic/drops.js";
import { nameIsBlocked } from "../logic/names.js";
import { reconcileDefenseLevel } from "../kv/queries.js";
import type { ItemType, ItemRecord, DefenseValues } from "../types.js";

const LEGACY_ITEM_MAP: Record<string, ItemType> = {
  reinforce: "defense_common",
  barricade: "defense_uncommon",
  fortify: "defense_rare",
  citadel: "defense_epic",
  strike: "attack_common",
  raid: "attack_uncommon",
  siege: "attack_rare",
  siege_engine: "attack_rare",
  onslaught: "attack_epic",
};

function migrateItems(items: ItemRecord[]): { items: ItemRecord[]; changed: boolean } {
  let changed = false;
  const migrated = items.map((item) => {
    const newType = LEGACY_ITEM_MAP[item.type];
    if (newType) {
      changed = true;
      return { ...item, type: newType };
    }
    return item;
  });
  return { items: migrated, changed };
}

const MAX_SURVEYS_PER_BUNDLE = 200;
const DAILY_SURVEY_CAP = 50;
// Tier-IV munitions awarded by an Expedition Contract are minted here (the game
// server has no item store). Only epic combat gear is grantable this way, and a
// bundle can carry at most a handful — the in-game contract cadence is ≤2/week,
// so this only bounds a modified client, never honest play.
const GRANTABLE_ITEM_TYPES: ItemType[] = ["attack_epic", "defense_epic"];
const MAX_ITEM_GRANTS_PER_BUNDLE = 4;
// Weekly ceiling across bundles. Grant ids are client-chosen, so per-bundle
// dedup alone lets a modified client mint fresh-id epics every push (4 × 6/hr).
// Honest cadence is ≤2 contract munitions per week; 4 gives 2× headroom.
const MAX_ITEM_GRANTS_PER_WEEK = 4;
const GRANT_WEEK_TTL = 14 * 86400;
// The bundle timestamp is stamped at build time on the game server, so a genuine
// one is always ≈ now. Requiring that (like the auth middleware does for the
// header) stops a modified client walking the timestamp into the future to mint a
// fresh daily survey cap per request (the cap is keyed on the timestamp's date).
const TIMESTAMP_SKEW_SECONDS = 300;
// Hard ceiling on posts the Worker will store for one player. The game today caps
// at 3 (engine.MAX_SURVEY_POSTS); the headroom absorbs future camp perks without
// falsely dropping legitimate posts, while still bounding fabricated-post spam.
const MAX_POSTS = 6;
// Ward (dormancy) is capped at 30d in-game (engine.WARD_MAX_DAYS); +1d absorbs
// clock skew. Stops a client asserting an arbitrarily long raid-immune window.
const MAX_WARD_SECONDS = 31 * 86400;
// Outpost names are player-authored free text, shipped to every other player on
// the leaderboard/scout/raid surfaces. The in-game charter caps them at 30 chars
// (engine.py); the Worker re-clamps because the client is untrusted — an unbounded
// name would bloat the leaderboard payload and break layout for every viewer.
// Content moderation is separate and reactive (operator censor); this is only the
// length ceiling. 48 leaves headroom over the in-game 30 without being abusable.
const MAX_POST_NAME_LEN = 48;
// A centroid drives raid travel-time distance. Legit home location is effectively
// fixed, so allow it to move at most once/day — a client can't teleport next to a
// target to collapse the defender's reaction window right before dispatching.
const CENTROID_MIN_MOVE_INTERVAL = 86400;
// Bundle write rate limit: at most this many per rolling hour, per player. Was the
// standalone rateLimitMiddleware (get + put = 2 RPCs); now folded into the route's
// own snapshot read and atomic commit so the hot path costs no extra round trips.
const BUNDLE_RATE_LIMIT = 6;
const RATE_LIMIT_TTL = 7200; // 2h — covers the rolling hour bucket plus skew
// A player's raze tombstones are bounded by their post count over the tombstone
// TTL; this caps the per-bundle tombstone scan with generous headroom.
const TOMBSTONE_SCAN_LIMIT = 64;
// A player holds at most MAX_POSTS defense rows; 64 is generous headroom and
// rides the same snapshot (adding a range costs no extra RPC).
const DEFENSE_SCAN_LIMIT = 64;
// mp_tokens are 32 hex chars today; 64 leaves format headroom while stopping a
// modified client using the token field as unbounded storage.
const MAX_POST_TOKEN_LEN = 64;
// grace_days is client-asserted (engine.upkeep_grace_days: base + camp bonus,
// currently 7 max). 30 is deliberately loose — the clamp exists to stop renown
// fade being disabled outright (1e9) or poisoned (NaN), not to police balance;
// dishonest-but-plausible values surface in the admin flags report instead.
const MAX_GRACE_DAYS = 30;

/** The client is untrusted: any numeric field can arrive as a string, NaN, or
 *  Infinity, and one poisoned value propagates through the renown math into the
 *  leaderboard. Returns the value only if it is a finite number. */
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Clamp an optional client-asserted number into [lo, hi]; a malformed value
 *  becomes undefined so the field is omitted and the server default applies. */
function finiteClamp(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(v, hi)) : undefined;
}

const app = new Hono<{ Bindings: Env; Variables: { playerId: string } }>();

function todayKey(playerId: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  return `daily_surveys:${playerId}:${date}`;
}

function grantWeekKey(playerId: string, timestamp: number): string {
  // Epoch-week bucket (the timestamp is already clamped to ≈ now upstream).
  const week = Math.floor(timestamp / (7 * 86400));
  return `item_grants:${playerId}:${week}`;
}

app.post("/api/bundle", async (c) => {
  // Auth + rate limit folded into the route's own snapshot/commit (they were two
  // standalone middlewares costing 3 extra RPCs — a duplicate getPlayer read and a
  // get+put rate-limit pair). Now: cheap header precheck (no DB) → one snapshot
  // that also carries the player and the rate-limit counter → verify the signature
  // from that same player → buffer the rate-limit increment into the single commit.
  const pre = precheckAuthHeaders(c);
  if (pre) return pre;
  const playerId = c.req.header("X-Player-ID")!;

  // Read the raw body text FIRST and parse it ourselves. verifyPlayerSignature
  // (below) recomputes the HMAC over c.req.text(); Hono caches whichever body
  // accessor runs first, so if c.req.json() ran first, a later text() would return
  // a *re-stringified* body (different bytes) and every signature would fail. The
  // old authMiddleware sidestepped this by running text() before the route's
  // json() — now that they share a handler, we control the order explicitly.
  const rawBody = await c.req.text();
  let body: BundleRequest;
  try {
    body = JSON.parse(rawBody) as BundleRequest;
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // Structural timestamp guard runs BEFORE the snapshot: todayKey() feeds the
  // snapshot's daily-counter key and new Date(ts*1000).toISOString() throws on a
  // non-finite/out-of-range value. A malformed timestamp is rejected here like a
  // malformed header (pre-rate-limit, no slot burned); the *skew* check below runs
  // after the rate limit so a plausible-but-shifted timestamp still costs a slot.
  if (typeof body.timestamp !== "number" || !Number.isFinite(body.timestamp) || body.timestamp <= 0) {
    return c.json({ ok: false, error: "Invalid timestamp" }, 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const hour = Math.floor(Date.now() / 3600000);

  // One snapshot reads everything the route needs — the player, the last-bundle
  // marker, today's survey counter, pending notifications, the player index, the
  // rate-limit counter, this week's grant counter, and the player's raze
  // tombstones — instead of a get/list per item. Every write is likewise buffered
  // and flushed in one atomic commit at the end (see `buf`), so a bundle push
  // costs 2 storage RPCs (snapshot + commit).
  const dailyKey = todayKey(playerId, body.timestamp);
  const weekKey = grantWeekKey(playerId, body.timestamp);
  const snap = await snapshotRead(
    c.env,
    [
      { ns: NS.PLAYERS, key: playerKey(playerId) },
      { ns: NS.PLAYERS, key: playerLastBundleKey(playerId) },
      { ns: NS.META, key: dailyKey },
      { ns: NS.SCOUTS, key: notificationsKey(playerId) },
      { ns: NS.META, key: PLAYER_INDEX_KEY },
      { ns: NS.META, key: rateLimitKey(playerId, hour) },
      { ns: NS.META, key: weekKey },
    ],
    [
      { ns: NS.DEFENSE, key: razeTombstonePrefix(playerId), limit: TOMBSTONE_SCAN_LIMIT },
      { ns: NS.DEFENSE, key: defenseKey(playerId, ""), limit: DEFENSE_SCAN_LIMIT },
    ],
  );
  const buf = new MutationBuffer();

  // Auth verification from the snapshotted player — no extra read. Rejects an
  // unknown player (null), a bad signature, or a frozen account, and records the
  // audit reject itself. Like today, an auth failure does NOT burn a rate slot.
  const maybePlayer = snap.exact[0] ? (JSON.parse(snap.exact[0]) as PlayerProfile) : null;
  const authFail = await verifyPlayerSignature(c, maybePlayer);
  if (authFail) return authFail;
  const player = maybePlayer!; // non-null past auth: verifyPlayerSignature 401s on null

  // Rate limit from the snapshot. At-cap → 429 without incrementing (matches the
  // old middleware, which did not re-increment once over the limit). Otherwise
  // buffer the increment so it commits atomically with the rest of the write.
  const rlCount = parseInt(snap.exact[5] ?? "0", 10);
  if (rlCount >= BUNDLE_RATE_LIMIT) {
    return c.json({ ok: false, error: "Rate limit exceeded" }, 429);
  }
  buf.put(NS.META, rateLimitKey(playerId, hour), String(rlCount + 1), RATE_LIMIT_TTL);

  // Past the rate limit, every early reject must still burn the slot (the old
  // middleware incremented before the body ran, so a request that trips a cheap
  // validation error still consumed budget — otherwise a modified client spams
  // the endpoint for free by deliberately failing validation). This commits `buf`
  // — which at each of these points holds only the rate-limit increment — before
  // returning the error.
  const reject = async (status: 400 | 409, error: string): Promise<Response> => {
    await buf.commit(c.env);
    return c.json({ ok: false, error }, status);
  };

  if (typeof body.survey_count !== "number" || body.survey_count < 0 || body.survey_count > MAX_SURVEYS_PER_BUNDLE) {
    return reject(400, `survey_count must be 0-${MAX_SURVEYS_PER_BUNDLE}`);
  }

  if (Math.abs(body.timestamp - nowSec) > TIMESTAMP_SKEW_SECONDS) {
    return reject(400, "Timestamp too far from server time");
  }

  // A discovery is a first-survey of a hex, so it can never outnumber the surveys
  // in the same bundle. (Ported from the removed peer validator — cheaper and more
  // reliable enforced here at write time.)
  const discoveries = body.discoveries ?? 0;
  if (typeof discoveries !== "number" || discoveries < 0 || discoveries > body.survey_count) {
    return reject(400, "discoveries cannot exceed survey_count");
  }

  const lastBundle = snap.exact[1] ? parseInt(snap.exact[1], 10) : null;
  if (lastBundle && body.timestamp <= lastBundle) {
    return reject(409, "Duplicate or old bundle");
  }

  // Daily survey cap enforcement. Hitting the cap no longer rejects the whole
  // bundle: a capped-out player is exactly who then does administration —
  // chartering, item installs, title/centroid changes — and that all rides in
  // this same bundle. Surveys past the cap are simply dropped (cappedSurveys
  // falls to 0) while every other field still applies. The response flags the
  // cap so the client can surface it and stop re-sending the surplus surveys.
  const dailyCount = parseInt(snap.exact[2] ?? "0", 10);
  const remaining = Math.max(0, DAILY_SURVEY_CAP - dailyCount);
  const cappedSurveys = Math.min(body.survey_count, remaining);
  const dailyCapReached = body.survey_count > 0 && cappedSurveys === 0;

  const { items: migratedItems, changed: itemsMigrated } = migrateItems(player.items);
  if (itemsMigrated) {
    player.items = migratedItems;
  }

  const drops = await computeDrops(playerId, body.timestamp, cappedSurveys);

  const newItems = drops.map((d) => ({
    id: d.id,
    type: d.type,
    assigned_at: body.timestamp,
    used: false,
  }));
  player.items = [...player.items, ...newItems];

  // Expedition Contract munition grants. Each carries a client-supplied id
  // derived from the contract row, so it's idempotent: a grant whose id is
  // already in the inventory is skipped (a retried bundle never double-mints).
  // Only epic combat gear is grantable, capped per bundle AND per week — ids are
  // client-chosen, so without the weekly counter a modified client mints fresh
  // ids every push. (A retry of already-held ids never burns weekly budget.)
  if (Array.isArray(body.item_grants)) {
    const grantedThisWeek = parseInt(snap.exact[6] ?? "0", 10);
    let weekRemaining = Math.max(0, MAX_ITEM_GRANTS_PER_WEEK - grantedThisWeek);
    const existingIds = new Set(player.items.map((i) => i.id));
    const granted: ItemRecord[] = [];
    for (const g of body.item_grants) {
      if (granted.length >= MAX_ITEM_GRANTS_PER_BUNDLE || weekRemaining <= 0) break;
      if (!g || typeof g.id !== "string" || typeof g.type !== "string") continue;
      if (!GRANTABLE_ITEM_TYPES.includes(g.type as ItemType)) continue;
      if (existingIds.has(g.id)) continue;
      existingIds.add(g.id);
      granted.push({ id: g.id, type: g.type as ItemType, assigned_at: body.timestamp, used: false });
      weekRemaining--;
    }
    if (granted.length > 0) {
      player.items = [...player.items, ...granted];
      buf.put(NS.META, weekKey, String(grantedThisWeek + granted.length), GRANT_WEEK_TTL);
    }
  }

  // Coarse centroid (lat/lng, ~0.1° rounded) drives raid travel-time distance.
  // First one is accepted immediately; after that it can move at most once/day so
  // a client can't teleport next to a target to collapse the defender's warning.
  if (
    body.coarse_centroid &&
    typeof body.coarse_centroid.lat === "number" &&
    typeof body.coarse_centroid.lng === "number"
  ) {
    const next = { lat: body.coarse_centroid.lat, lng: body.coarse_centroid.lng };
    const moved =
      !player.coarse_centroid ||
      player.coarse_centroid.lat !== next.lat ||
      player.coarse_centroid.lng !== next.lng;
    const lastMove = player.centroid_updated_at ?? 0;
    if (!player.coarse_centroid || (moved && nowSec - lastMove >= CENTROID_MIN_MOVE_INTERVAL)) {
      player.coarse_centroid = next;
      player.centroid_updated_at = nowSec;
    }
  }

  if (body.post_summaries && Array.isArray(body.post_summaries)) {
    // The Worker is authoritative for combat outcomes; the game server is
    // authoritative for chartering and upgrades. A razed post is permanently
    // gone (tombstoned) — drop any attempt to re-add it. Once the server stops
    // asserting a tombstoned post (i.e. it has reconciled the raze locally),
    // clear the tombstone so the same location can be chartered fresh later.
    const tombPrefix = razeTombstonePrefix(playerId);
    const tombstoned = new Set(snap.ranges[0].map((row) => row.key.slice(tombPrefix.length)));
    const incomingHexes = new Set(body.post_summaries.map((p) => p.post_token));
    for (const hex of tombstoned) {
      if (!incomingHexes.has(hex)) buf.del(NS.DEFENSE, razeTombstoneKey(playerId, hex));
    }

    // Client-supplied post fields feed the leaderboard (renown = f(level, age)),
    // so validate each one at the trust boundary:
    //   - level clamped to [1, MAX_POST_LEVEL]. The in-game upgrade path gates on
    //     provisions, not time, so a wealthy player can legitimately jump several
    //     levels in one session — we clamp the range but don't rate-limit it here.
    //     (Large jumps surface in the admin flags report instead.)
    //   - chartered_at can never predate when the Worker first saw the post, so
    //     the quadratic age term can't be backdated. Posts already on file seed
    //     their first-seen from the previously-accepted charter time (migration).
    //   - dormant_until clamped to the 30d ward ceiling (no permanent immunity).
    // Level *decreases* pass through freely (raid-knockdown reconciliation, or
    // self-harm — never an abuse).
    const firstSeen = { ...(player.post_first_seen ?? {}) };
    const firstLevel = { ...(player.post_first_level ?? {}) };
    const priorByHex = new Map(player.post_summaries.map((p) => [p.post_token, p]));

    // Post HP scales with level (POST_MAX_HP), but a defense row is written once
    // at its creation level and only ever lowered by a raid — so a post levelled
    // up after its row exists keeps a too-small pool. Raise it to match below.
    // defByToken indexes this player's defense rows from the same snapshot.
    // raidPendingTokens are posts with a raid knockdown still awaiting delivery
    // (the client hasn't lowered its asserted level yet); skip those, or we'd
    // hand back HP the raid just removed.
    const defPrefix = defenseKey(playerId, "");
    const defByToken = new Map<string, DefenseValues>();
    for (const row of snap.ranges[1]) {
      try {
        defByToken.set(row.key.slice(defPrefix.length), JSON.parse(row.value) as DefenseValues);
      } catch { /* skip an unparseable row */ }
    }
    const raidPendingTokens = new Set<string>();
    for (const n of (snap.exact[3] ? (JSON.parse(snap.exact[3]) as Notification[]) : [])) {
      if ((n.type === "raid_damaged" || n.type === "raid_razed") && typeof n.data?.post_token === "string") {
        raidPendingTokens.add(n.data.post_token as string);
      }
    }

    const validated: PostSummary[] = [];
    for (const p of body.post_summaries) {
      // The token is the post's identity everywhere downstream; a non-string or
      // oversized one is fabrication, not a post — drop it rather than coerce.
      if (typeof p.post_token !== "string" || p.post_token.length === 0 || p.post_token.length > MAX_POST_TOKEN_LEN) {
        continue;
      }
      if (tombstoned.has(p.post_token)) continue;
      let seen = firstSeen[p.post_token];
      if (seen === undefined) {
        seen = priorByHex.get(p.post_token)?.chartered_at ?? nowSec;
        firstSeen[p.post_token] = seen;
      }
      const level = Math.min(MAX_POST_LEVEL, Math.max(1, Math.floor(finiteOr(p.level, 1))));
      // Reconcile this post's defensive HP pool up to its current level, unless a
      // raid knockdown for it is still pending delivery (see above).
      if (!raidPendingTokens.has(p.post_token)) {
        const def = defByToken.get(p.post_token);
        if (def && reconcileDefenseLevel(def, level)) {
          buf.put(NS.DEFENSE, defenseKey(playerId, p.post_token), JSON.stringify(def));
        }
      }
      // Record the level we first saw, once, so the admin flags report can tell
      // growth it witnessed from a post that simply arrived established.
      if (firstLevel[p.post_token] === undefined) {
        firstLevel[p.post_token] = priorByHex.get(p.post_token)?.level ?? level;
      }
      const chartered_at = Math.max(finiteOr(p.chartered_at, nowSec), seen);
      let dormant_until = Math.max(0, finiteOr(p.dormant_until, 0));
      if (dormant_until > nowSec + MAX_WARD_SECONDS) dormant_until = nowSec + MAX_WARD_SECONDS;
      // Clean the player-authored name (untrusted client): blank a denylisted
      // name so a slur never reaches other players' boards, else clamp length.
      // The blanked name renders as the "(unnamed)" fallback downstream.
      const name =
        typeof p.name === "string"
          ? (nameIsBlocked(p.name) ? "" : p.name.slice(0, MAX_POST_NAME_LEN))
          : undefined;
      // Ruin inputs feed the renown fade math (logic/ruin.ts); clamp each into
      // its honest range and drop malformed values so the defaults apply.
      const last_tended_at = finiteClamp(p.last_tended_at, 0, nowSec + TIMESTAMP_SKEW_SECONDS);
      const warded_at = finiteClamp(p.warded_at, 0, nowSec + TIMESTAMP_SKEW_SECONDS);
      const grace_days = finiteClamp(p.grace_days, 1, MAX_GRACE_DAYS);
      // Built field-by-field, never spread from the request: unknown client keys
      // must not ride into stored state (profile bloat, at minimum).
      validated.push({
        post_token: p.post_token,
        level,
        chartered_at,
        dormant_until,
        ...(name !== undefined ? { name } : {}),
        ...(last_tended_at !== undefined ? { last_tended_at } : {}),
        ...(warded_at !== undefined ? { warded_at } : {}),
        ...(grace_days !== undefined ? { grace_days } : {}),
      });
    }

    // Hard post-count ceiling: keep the oldest MAX_POSTS so fabricated extras
    // (which sort newest) are the ones dropped, never a player's real posts.
    validated.sort((a, b) => a.chartered_at - b.chartered_at);
    const kept = validated.slice(0, MAX_POSTS);
    player.post_summaries = kept;

    // Retain first-seen only for posts still asserted, so the map stays bounded.
    const keptHexes = new Set(kept.map((p) => p.post_token));
    player.post_first_seen = Object.fromEntries(
      Object.entries(firstSeen).filter(([hex]) => keptHexes.has(hex)),
    );
    player.post_first_level = Object.fromEntries(
      Object.entries(firstLevel).filter(([hex]) => keptHexes.has(hex)),
    );
  }

  // Chosen display title — echoed on every player's leaderboard. Titles come
  // from a fixed registry (game server: game/titles.py), so anything else is a
  // modified client using the field as free text; store "" instead. Keep the
  // registry mirror (KNOWN_TITLES) in sync when adding titles.
  if (typeof body.active_title === "string") {
    player.active_title = KNOWN_TITLES.has(body.active_title) ? body.active_title : "";
  }

  // --- Buffered writes (flushed together, atomically, below) ----------------
  // Persist the player. Does not invalidate the leaderboard snapshot — gameplay
  // writes let it ride its stale window + cron refresh (see logic/leaderboard.ts).
  buf.put(NS.PLAYERS, playerKey(playerId), JSON.stringify(player));

  // Add to the player index if not already present.
  const index = (snap.exact[4] ? (JSON.parse(snap.exact[4]) as string[]) : []);
  if (!index.includes(playerId)) {
    index.push(playerId);
    buf.put(NS.META, PLAYER_INDEX_KEY, JSON.stringify(index));
  }

  // Update daily survey count.
  if (cappedSurveys > 0) {
    buf.put(NS.META, dailyKey, String(dailyCount + cappedSurveys), 172800); // 48h TTL
  }

  buf.put(NS.PLAYERS, playerLastBundleKey(playerId), String(body.timestamp));

  const notifications: Notification[] = snap.exact[3] ? (JSON.parse(snap.exact[3]) as Notification[]) : [];
  if (notifications.length > 0) {
    buf.del(NS.SCOUTS, notificationsKey(playerId));
  }

  await buf.commit(c.env);

  return c.json({
    ok: true,
    drops,
    all_items: player.items,
    surveys_accepted: cappedSurveys,
    daily_surveys_remaining: remaining - cappedSurveys,
    daily_survey_cap_reached: dailyCapReached,
    notifications,
  });
});

export default app;
