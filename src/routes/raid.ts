import { Hono } from "hono";
import type { Env, RaidRecord, ItemType } from "../types.js";
import { isAttackItem, RAID_COOLDOWN_SECONDS } from "../types.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  getPlayer, putPlayer, putRaid,
  getActiveRaidId, setActiveRaid,
  getRaidCooldown, setRaidCooldown, getRaidCooldowns,
  putAttackerLastRaid, getAttackerLastRaid,
} from "../kv/queries.js";
import { rawPower, travelTimeBetween } from "../logic/raid.js";
import { resolveAttackerRaid } from "../logic/resolve.js";
import { getOverrides, applyPostName, applyPlayerName } from "../logic/moderation.js";

const app = new Hono<{ Bindings: Env; Variables: { playerId: string } }>();

// Dispatch an atomic multi-item raid. Items are committed now; the raid travels
// (distance-scaled ETA) and resolves at arrival against defense-at-arrival.
app.post("/api/raid/dispatch", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const body = await c.req.json();
  const { target_player_id, target_post_hex, item_ids } = body;

  if (!target_player_id || !target_post_hex || !Array.isArray(item_ids) || item_ids.length === 0) {
    return c.json({ ok: false, error: "Missing target_player_id, target_post_hex, or item_ids" }, 400);
  }
  if (target_player_id === playerId) {
    return c.json({ ok: false, error: "Cannot raid yourself" }, 400);
  }

  const player = await getPlayer(c.env, playerId);
  if (!player) return c.json({ ok: false, error: "Player not found" }, 404);

  const now = Math.floor(Date.now() / 1000);

  // Must keep at least one active (non-warded) outpost to launch a raid —
  // you can't attack from behind a fully dormant frontier (anti-turtling).
  const hasActiveOutpost = player.post_summaries.some(
    (p) => !p.dormant_until || now >= p.dormant_until,
  );
  if (!hasActiveOutpost) {
    return c.json({ ok: false, error: "You need at least one active (non-warded) outpost to launch a raid" }, 400);
  }

  // One raiding party in flight at a time.
  if (await getActiveRaidId(c.env, playerId)) {
    return c.json({ ok: false, error: "Your raiding party is already deployed — wait for it to return" }, 409);
  }

  // 24h per-target cooldown.
  const cd = await getRaidCooldown(c.env, playerId, target_post_hex);
  if (cd && now - cd < RAID_COOLDOWN_SECONDS) {
    const hours = Math.ceil((RAID_COOLDOWN_SECONDS - (now - cd)) / 3600);
    return c.json({ ok: false, error: `Target on cooldown: ${hours}h remaining` }, 400);
  }

  // Validate items: owned, unused, attack items, no duplicates.
  const ids = new Set<string>(item_ids);
  if (ids.size !== item_ids.length) {
    return c.json({ ok: false, error: "Duplicate item_ids" }, 400);
  }
  const chosen = player.items.filter((i) => ids.has(i.id) && !i.used && isAttackItem(i.type));
  if (chosen.length !== ids.size) {
    return c.json({ ok: false, error: "One or more items are missing, used, or not attack items" }, 400);
  }

  const target = await getPlayer(c.env, target_player_id);
  if (!target) return c.json({ ok: false, error: "Target player not found" }, 404);
  const targetPost = target.post_summaries.find((p) => p.post_hex === target_post_hex);
  if (!targetPost) return c.json({ ok: false, error: "Target post not found" }, 400);
  if (targetPost.dormant_until && now < targetPost.dormant_until) {
    return c.json({ ok: false, error: "Target outpost is warded (dormant) and cannot be raided" }, 400);
  }

  // Commit items.
  for (const item of player.items) {
    if (ids.has(item.id)) item.used = true;
  }
  await putPlayer(c.env, player);

  const itemTypes = chosen.map((i) => i.type) as ItemType[];
  const eta = travelTimeBetween(player.coarse_centroid, target.coarse_centroid);
  const overrides = await getOverrides(c.env);
  const raid: RaidRecord = {
    raid_id: crypto.randomUUID(),
    attacker_id: playerId,
    attacker_name: applyPlayerName(overrides, playerId, player.display_name),
    target_player_id,
    target_player_name: applyPlayerName(overrides, target_player_id, target.display_name),
    target_post_hex,
    target_post_name: applyPostName(overrides, target_player_id, target_post_hex, targetPost.name ?? ""),
    item_types: itemTypes,
    raw_power: rawPower(itemTypes),
    dispatched_at: now,
    arrives_at: now + eta,
    status: "in_flight",
  };

  await putRaid(c.env, raid);
  await putAttackerLastRaid(c.env, raid);
  await setActiveRaid(c.env, playerId, raid.raid_id);
  await setRaidCooldown(c.env, playerId, target_post_hex, now);

  return c.json({
    ok: true,
    raid_id: raid.raid_id,
    arrives_at: raid.arrives_at,
    eta_seconds: eta,
    raw_power: raid.raw_power,
    items_committed: itemTypes.length,
  });
});

// The requesting player's live per-target cooldowns, so the game server can show
// a countdown on the Warfront before the player even opens the raid picker
// (previously this only surfaced as a dispatch-time rejection error).
app.get("/api/raid/cooldowns", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const cooldowns = await getRaidCooldowns(c.env, playerId);
  const expires_at: Record<string, number> = {};
  for (const [postHex, setAt] of Object.entries(cooldowns)) {
    expires_at[postHex] = setAt + RAID_COOLDOWN_SECONDS;
  }
  return c.json({ ok: true, expires_at });
});

// Attacker view of their own most recent raid (resolves due first). Returns the
// full record — in_flight (with arrives_at) or resolved (with outcome/damage) —
// so the game server can display live status and the landing result.
app.get("/api/raid/mine", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  // Resolve only *this* attacker's landed raid — not every raid account-wide.
  // Resolution is atomic (record + cleared lock commit together), so there is no
  // reconcile pass: the lock and the resolved record can't disagree.
  await resolveAttackerRaid(c.env, playerId);
  const activeId = await getActiveRaidId(c.env, playerId);
  const raid = await getAttackerLastRaid(c.env, playerId);
  return c.json({ ok: true, active_raid_id: activeId ?? null, raid: raid ?? null });
});

export default app;
