import { Hono } from "hono";
import type { Env, ItemType, ItemRecord } from "../types.js";
import { authMiddleware } from "../middleware/auth.js";
import { getPlayer, putPlayer } from "../kv/queries.js";

const app = new Hono<{ Bindings: Env; Variables: { playerId: string } }>();

// Items the Merchant is allowed to mint. Rare/epic stay drop-only so purchased
// stock never devalues the rarest rewards. Currency is charged on the game
// server (the Worker has no knowledge of provisions/marks); this endpoint only
// mints the item into the player's authoritative inventory.
const SELLABLE_ITEMS: ItemType[] = [
  "probe",
  "attack_common",
  "attack_uncommon",
  "defense_common",
  "defense_uncommon",
];

// Currency is charged on the (player-controlled) game server, so the Worker can't
// verify a purchase was paid for. A generous per-day mint ceiling bounds the
// worst case (a modified client minting free items in a loop) without ever
// blocking honest play — the in-game weekly merchant stocks only a handful.
const SHOP_DAILY_BUY_CAP = 20;

function buyCountKey(playerId: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  return `shop_buys:${playerId}:${date}`;
}

app.post("/api/shop/buy", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const body = await c.req.json();
  const { item_type, purchase_id } = body;

  if (!item_type || !purchase_id) {
    return c.json({ ok: false, error: "Missing item_type or purchase_id" }, 400);
  }

  if (!SELLABLE_ITEMS.includes(item_type)) {
    return c.json({ ok: false, error: `Item ${item_type} is not for sale` }, 400);
  }

  const player = await getPlayer(c.env, playerId);
  if (!player) {
    return c.json({ ok: false, error: "Player not found" }, 404);
  }

  // Idempotent: a retried purchase (same purchase_id) returns the existing item
  // rather than minting a duplicate. (Checked before the daily cap so a retry is
  // never counted against it.)
  const existing = player.items.find((i) => i.id === purchase_id);
  if (existing) {
    return c.json({ ok: true, item: existing, all_items: player.items });
  }

  const now = Math.floor(Date.now() / 1000);
  const capKey = buyCountKey(playerId, now);
  const boughtToday = parseInt(await c.env.META.get(capKey) ?? "0", 10);
  if (boughtToday >= SHOP_DAILY_BUY_CAP) {
    return c.json({ ok: false, error: "Daily purchase cap reached" }, 429);
  }

  const item: ItemRecord = {
    id: purchase_id,
    type: item_type,
    assigned_at: now,
    used: false,
  };
  player.items = [...player.items, item];
  await putPlayer(c.env, player);
  await c.env.META.put(capKey, String(boughtToday + 1), { expirationTtl: 172800 });

  return c.json({ ok: true, item, all_items: player.items });
});

// Salvage unused items back for currency. Batched (many ids, one write) to keep
// Worker load low. The Worker only removes items from the authoritative
// inventory; the game server credits marks/provisions from removed_count (so a
// retried request, whose items are already gone, credits nothing).
app.post("/api/shop/salvage", authMiddleware, async (c) => {
  const playerId = c.get("playerId");
  const body = await c.req.json();
  const { item_ids } = body;

  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    return c.json({ ok: false, error: "Missing item_ids" }, 400);
  }

  const player = await getPlayer(c.env, playerId);
  if (!player) {
    return c.json({ ok: false, error: "Player not found" }, 404);
  }

  // Only free (unused, uninstalled) items can be salvaged — an installed defense
  // or a spent probe is off-limits.
  const wanted = new Set<string>(item_ids);
  const removed: string[] = [];
  const kept: ItemRecord[] = [];
  for (const it of player.items) {
    if (wanted.has(it.id) && !it.used && !it.installed_post_token) {
      removed.push(it.id);
    } else {
      kept.push(it);
    }
  }

  if (removed.length > 0) {
    player.items = kept;
    await putPlayer(c.env, player);
  }

  return c.json({
    ok: true,
    removed_ids: removed,
    removed_count: removed.length,
    all_items: player.items,
  });
});

export default app;
