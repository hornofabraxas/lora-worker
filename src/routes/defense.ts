import { Hono } from "hono";
import type { Env, PlayerProfile, DefenseValues, RaidRecord } from "../types.js";
import { isDefenseItem, ITEM_DEFENSE_PCT, MAX_ACTIVE_BOOSTS } from "../types.js";
import { authMiddleware } from "../middleware/auth.js";
import { getPlayer, putPlayer, getOrCreateDefense, putDefense, defaultDefense } from "../kv/queries.js";
import { defenseKey, NS } from "../kv/schema.js";
import { snapshotRead, MutationBuffer } from "../kv/composite.js";
import { makeBoost, activeBoosts, threatBand, defenseReduction, effectiveHp, effectiveMaxHp } from "../logic/raid.js";
import { resolveDueRaids } from "../logic/resolve.js";

const app = new Hono<{ Bindings: Env; Variables: { playerId: string } }>();

// Per-player prefix-scan ceilings, sized to what a player can actually have plus
// headroom: a handful of posts (each with one defense row), and inbound raids
// bounded by distinct attackers (one raid in flight each). Shared by the defense
// route and the combined status poll so both bound their reads identically.
export const DEFENSE_SCAN_LIMIT = 64;
export const INBOUND_RAID_SCAN_LIMIT = 256;

/** Parse the DEFENSE and ATTACKS(raid:) ranges of a per-player snapshot into a
 *  hex→defense map and the list of still-inbound raids. Shared by the defense
 *  route (which snapshots on its own) and the status route (which reuses its one
 *  combined snapshot), so both read the same shape. */
export function parseDefenseRanges(
  pid: string,
  defenseRows: { key: string; value: string }[],
  raidRows: { key: string; value: string }[],
  now: number,
): { defByHex: Map<string, DefenseValues>; inFlight: RaidRecord[] } {
  const defByHex = new Map<string, DefenseValues>();
  const defPrefix = `defense:${pid}:`;
  for (const row of defenseRows) {
    defByHex.set(row.key.slice(defPrefix.length), JSON.parse(row.value) as DefenseValues);
  }
  const inFlight = raidRows
    .map((r) => JSON.parse(r.value) as RaidRecord)
    .filter((r) => r.status === "in_flight" && r.arrives_at > now);
  return { defByHex, inFlight };
}

/**
 * Build the per-post defense view (HP, effective HP with boosts, defense %, and
 * inbound-raid threat) from already-read data. Pure — materializes a default row
 * in memory for any post with none, buffering only those defaults for the caller
 * to persist. Shared by GET /api/player/:id/defense and GET /api/status so the
 * two never drift. Assumes landed raids for this defender are already resolved.
 */
export function assembleDefensePosts(
  pid: string,
  postSummaries: PlayerProfile["post_summaries"],
  now: number,
  defByHex: Map<string, DefenseValues>,
  inFlight: RaidRecord[],
  missing: MutationBuffer,
) {
  const posts = [];
  for (const post of postSummaries) {
    let defense = defByHex.get(post.post_token);
    if (!defense) {
      defense = defaultDefense(post.level, now);
      missing.put(NS.DEFENSE, defenseKey(pid, post.post_token), JSON.stringify(defense));
    }
    // Inbound raids on this post — coarse threat only, no attacker composition.
    const incoming = inFlight
      .filter((r) => r.target_post_token === post.post_token)
      .map((r) => ({
        raid_id: r.raid_id,
        arrives_at: r.arrives_at,
        eta_seconds: r.arrives_at - now,
        threat: threatBand(r.raw_power, defense!, now),
      }));
    const liveBoosts = activeBoosts(defense, now);
    posts.push({
      post_token: post.post_token,
      ...defense,
      defense_pct: defenseReduction(defense),
      boost_hp: liveBoosts.reduce((s, b) => s + b.hp_remaining, 0),
      effective_hp: effectiveHp(defense, now),
      effective_max_hp: effectiveMaxHp(defense),
      active_boosts: liveBoosts.length,
      incoming_raids: incoming,
    });
  }
  return posts;
}

/**
 * Defense view for one player, reading every defense row and inbound raid in ONE
 * snapshot and persisting any materialized default rows in one atomic write.
 */
export async function buildDefensePosts(env: Env, player: PlayerProfile, now: number) {
  const pid = player.player_id;
  const snap = await snapshotRead(env, [], [
    { ns: NS.DEFENSE, key: `defense:${pid}:`, limit: DEFENSE_SCAN_LIMIT },
    { ns: NS.ATTACKS, key: `raid:${pid}:`, limit: INBOUND_RAID_SCAN_LIMIT },
  ]);
  const { defByHex, inFlight } = parseDefenseRanges(pid, snap.ranges[0], snap.ranges[1], now);
  const missing = new MutationBuffer();
  const posts = assembleDefensePosts(pid, player.post_summaries, now, defByHex, inFlight, missing);
  await missing.commit(env);
  return posts;
}

function restoreCapKey(playerId: string, postToken: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  return `restore_hp:${playerId}:${postToken}:${date}`;
}

app.post("/api/defend/install", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const body = await c.req.json();
  const { post_token, item_id } = body;

  if (!post_token || !item_id) {
    return c.json({ ok: false, error: "Missing post_token or item_id" }, 400);
  }

  const player = await getPlayer(c.env, playerId);
  if (!player) {
    return c.json({ ok: false, error: "Player not found" }, 404);
  }

  const postSummary = player.post_summaries.find((p) => p.post_token === post_token);
  if (!postSummary) {
    return c.json({ ok: false, error: "Post not found" }, 400);
  }

  const itemIdx = player.items.findIndex(
    (i) => i.id === item_id && !i.used,
  );
  if (itemIdx === -1) {
    return c.json({ ok: false, error: "Item not found or already used" }, 400);
  }

  const item = player.items[itemIdx];
  if (!isDefenseItem(item.type)) {
    return c.json({ ok: false, error: "Item is not a defensive item" }, 400);
  }

  const defensePct = ITEM_DEFENSE_PCT[item.type] ?? 0;

  player.items[itemIdx].used = true;
  player.items[itemIdx].installed_post_token = post_token;
  await putPlayer(c.env, player);

  const defense = await getOrCreateDefense(c.env, playerId, post_token, postSummary.level);

  // Single slot — replace existing item (old one is consumed). defense_value now
  // stores the damage-reduction fraction for this item.
  defense.defense_item = item.type;
  defense.defense_value = defensePct;
  await putDefense(c.env, playerId, post_token, defense);

  return c.json({
    ok: true,
    defense_pct: defensePct,
    defense_item: item.type,
    hp: defense.hp,
    max_hp: defense.max_hp,
    effective_hp: effectiveHp(defense, Math.floor(Date.now() / 1000)),
    effective_max_hp: effectiveMaxHp(defense),
  });
});

// Deploy one or more defense items as temporary flat-HP boosts (reactive
// counterplay to an inbound raid). Diminishing returns per active boost.
app.post("/api/defend/boost", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const body = await c.req.json();
  const { post_token, item_ids } = body;

  if (!post_token || !Array.isArray(item_ids) || item_ids.length === 0) {
    return c.json({ ok: false, error: "Missing post_token or item_ids" }, 400);
  }

  const player = await getPlayer(c.env, playerId);
  if (!player) return c.json({ ok: false, error: "Player not found" }, 404);

  const postSummary = player.post_summaries.find((p) => p.post_token === post_token);
  if (!postSummary) return c.json({ ok: false, error: "Post not found" }, 400);

  const ids = new Set<string>(item_ids);
  const chosen = player.items.filter((i) => ids.has(i.id) && !i.used && isDefenseItem(i.type));
  if (chosen.length !== ids.size) {
    return c.json({ ok: false, error: "One or more items are missing, used, or not defense items" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const defense = await getOrCreateDefense(c.env, playerId, post_token, postSummary.level);

  const kept = activeBoosts(defense, now);
  // Hard cap on concurrently-live boosts (see MAX_ACTIVE_BOOSTS). Reject rather
  // than silently drop so the defender never spends items that don't take effect.
  const room = MAX_ACTIVE_BOOSTS - kept.length;
  if (room <= 0) {
    return c.json({ ok: false, error: `This post already has the maximum ${MAX_ACTIVE_BOOSTS} active boosts` }, 400);
  }
  if (chosen.length > room) {
    return c.json({ ok: false, error: `Only ${room} more boost${room === 1 ? "" : "s"} can be added (max ${MAX_ACTIVE_BOOSTS} active)` }, 400);
  }
  let count = kept.length;
  const added = [];
  for (const item of chosen) {
    const boost = makeBoost(item.type, count, now);
    kept.push(boost);
    added.push(boost);
    count++;
  }
  defense.boosts = kept;

  for (const item of player.items) {
    if (ids.has(item.id)) item.used = true;
  }
  await putPlayer(c.env, player);
  await putDefense(c.env, playerId, post_token, defense);

  const totalBoostHp = kept.reduce((s, b) => s + b.hp_remaining, 0);
  return c.json({
    ok: true,
    boosts_active: kept.length,
    boost_hp_added: added.reduce((s, b) => s + b.hp_remaining, 0),
    total_boost_hp: totalBoostHp,
  });
});

app.post("/api/defend/restore", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const body = await c.req.json();
  const { post_token, provisions_spent } = body;

  if (!post_token || typeof provisions_spent !== "number" || provisions_spent <= 0) {
    return c.json({ ok: false, error: "Missing post_token or invalid provisions_spent" }, 400);
  }

  const player = await getPlayer(c.env, playerId);
  if (!player) {
    return c.json({ ok: false, error: "Player not found" }, 404);
  }

  const postSummary = player.post_summaries.find((p) => p.post_token === post_token);
  if (!postSummary) {
    return c.json({ ok: false, error: "Post not found" }, 400);
  }

  const defense = await getOrCreateDefense(c.env, playerId, post_token, postSummary.level);

  if (defense.hp >= defense.max_hp) {
    return c.json({ ok: false, error: "HP already at maximum" }, 400);
  }

  // Provisions are charged on the (player-controlled) game server, so to the
  // Worker every restore looks free. Cap the HP restored per post per day at 2×
  // its max so a modified client can't hold a post permanently topped-up through
  // a sustained assault, while a normal defender's repairs are never blocked.
  const now = Math.floor(Date.now() / 1000);
  const capKey = restoreCapKey(playerId, post_token, now);
  const restoredToday = parseInt(await c.env.META.get(capKey) ?? "0", 10);
  const dailyCap = defense.max_hp * 2;
  const dailyRemaining = Math.max(0, dailyCap - restoredToday);
  if (dailyRemaining === 0) {
    return c.json({ ok: false, error: "Daily HP restore cap reached for this post" }, 429);
  }

  const hpPerProvision = 5;
  const maxRestorable = Math.min(defense.max_hp - defense.hp, dailyRemaining);
  const hpRestored = Math.min(provisions_spent * hpPerProvision, maxRestorable);

  defense.hp += hpRestored;
  defense.hp_updated_at = now;
  await putDefense(c.env, playerId, post_token, defense);
  await c.env.META.put(capKey, String(restoredToday + hpRestored), { expirationTtl: 172800 });

  return c.json({
    ok: true,
    new_hp: defense.hp,
    max_hp: defense.max_hp,
    daily_restore_remaining: dailyRemaining - hpRestored,
  });
});

app.get("/api/player/:id/defense", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const targetId = c.req.param("id");

  if (playerId !== targetId) {
    return c.json({ ok: false, error: "Can only view own defense" }, 403);
  }

  // Resolve any raids that have landed on this defender before reporting state.
  await resolveDueRaids(c.env, playerId);

  const player = await getPlayer(c.env, playerId);
  if (!player) {
    return c.json({ ok: false, error: "Player not found" }, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  const posts = await buildDefensePosts(c.env, player, now);

  return c.json({ ok: true, posts });
});

export default app;
