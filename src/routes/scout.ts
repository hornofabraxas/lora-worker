import { Hono } from "hono";
import type { Env, ScoutResult } from "../types.js";
import { authMiddleware } from "../middleware/auth.js";
import { getPlayer, putPlayer, appendNotification, getOrCreateDefense } from "../kv/queries.js";
import { defenseReduction, activeBoosts, haversineKm } from "../logic/raid.js";
import { scoutKey } from "../kv/schema.js";
import { getOverrides, applyPostName } from "../logic/moderation.js";

const KM_PER_MILE = 1.609344;
// Distance is fuzzed to the nearest 50mi so a scout reveals a rough bearing, not
// a precise fix. The coarse centroids are already ~0.1° (~7mi) grained, so this
// bucket sits comfortably inside the existing location-privacy boundary.
const DISTANCE_FUZZ_MI = 50;

function fuzzedDistanceMi(
  a?: { lat: number; lng: number },
  b?: { lat: number; lng: number },
): number | null {
  if (!a || !b) return null;
  const mi = haversineKm(a, b) / KM_PER_MILE;
  return Math.round(mi / DISTANCE_FUZZ_MI) * DISTANCE_FUZZ_MI;
}

const app = new Hono<{ Bindings: Env; Variables: { playerId: string } }>();

app.post("/api/scout", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const body = await c.req.json();
  const { target_player_id, probe_item_id } = body;

  if (!target_player_id || !probe_item_id) {
    return c.json({ ok: false, error: "Missing target_player_id or probe_item_id" }, 400);
  }

  if (target_player_id === playerId) {
    return c.json({ ok: false, error: "Cannot scout yourself" }, 400);
  }

  const player = await getPlayer(c.env, playerId);
  if (!player) {
    return c.json({ ok: false, error: "Player not found" }, 404);
  }

  const itemIdx = player.items.findIndex(
    (i) => i.id === probe_item_id && i.type === "probe" && !i.used,
  );
  if (itemIdx === -1) {
    return c.json({ ok: false, error: "Probe not found or already used" }, 400);
  }

  const target = await getPlayer(c.env, target_player_id);
  if (!target) {
    return c.json({ ok: false, error: "Target player not found" }, 404);
  }

  if (target.post_summaries.length === 0) {
    return c.json({ ok: false, error: "Target has no posts" }, 400);
  }

  player.items[itemIdx].used = true;
  await putPlayer(c.env, player);

  const now = Math.floor(Date.now() / 1000);

  // Recon reveals exact HP, the installed item's % damage reduction, and the
  // *count* of live flat-HP boosts (not their HP). Revealing the count lets an
  // attacker size a raid against a defender who's actively boosting — the probe
  // is now worth casting before a raid — while the exact boost HP stays hidden,
  // so a guaranteed precalculated raze is still impossible against a live defender.
  const overrides = await getOverrides(c.env);
  const postDetails = [];
  for (const p of target.post_summaries) {
    const def = await getOrCreateDefense(c.env, target_player_id, p.post_hex, p.level);
    postDetails.push({
      post_hex: p.post_hex,
      name: applyPostName(overrides, target_player_id, p.post_hex, p.name ?? ""),
      level: p.level,
      age_days: Math.floor((now - p.chartered_at) / 86400),
      hp: def.hp,
      max_hp: def.max_hp,
      defense_reduction: defenseReduction(def),
      active_boosts: activeBoosts(def, now).length,
    });
  }

  const highestPost = target.post_summaries.reduce((best, p) =>
    p.level > best.level ? p : best,
  );

  const distance_mi = fuzzedDistanceMi(player.coarse_centroid, target.coarse_centroid);

  const scoutId = crypto.randomUUID();
  const result: ScoutResult = {
    scout_id: scoutId,
    scouter: playerId,
    target_player: target_player_id,
    post_level: highestPost.level,
    post_age_days: Math.floor((now - highestPost.chartered_at) / 86400),
    post_count: target.post_summaries.length,
    created_at: now,
    distance_mi,
  };

  await c.env.SCOUTS.put(scoutKey(scoutId), JSON.stringify(result));

  await appendNotification(c.env, target_player_id, {
    type: "scouted",
    message: "An unknown explorer has scouted your outposts.",
    timestamp: now,
  });

  return c.json({
    ok: true,
    scout_id: scoutId,
    post_level: result.post_level,
    post_age_days: result.post_age_days,
    post_count: result.post_count,
    distance_mi: result.distance_mi,
    posts: postDetails,
  });
});

export default app;
