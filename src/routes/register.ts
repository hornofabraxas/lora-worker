import { Hono } from "hono";
import type { Env, RegisterRequest, PlayerProfile } from "../types.js";
import { getPlayer, putPlayer, addToPlayerIndex } from "../kv/queries.js";
import { timingSafeEqual } from "../middleware/auth.js";

const app = new Hono<{ Bindings: Env }>();

app.post("/api/register", async (c) => {
  const body = await c.req.json<RegisterRequest & { invite_code?: string }>();

  // Sybil gate: when an invite code is configured, registration requires it.
  // Every registered player is a leaderboard entry and a valid raid actor, so
  // open registration is an abuse surface once the game is public. Unset leaves
  // registration open (tests, private/dev use).
  if (c.env.REGISTER_SECRET) {
    const provided = c.req.header("x-invite-code") ?? body.invite_code ?? "";
    if (!provided || !timingSafeEqual(provided, c.env.REGISTER_SECRET)) {
      return c.json({ ok: false, error: "A valid invite code is required to register" }, 403);
    }
  }

  if (!body.display_name || body.display_name.length < 1 || body.display_name.length > 32) {
    return c.json({ ok: false, error: "display_name must be 1-32 characters" }, 400);
  }

  const idBytes = new Uint8Array(16);
  crypto.getRandomValues(idBytes);
  const playerId = Array.from(idBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = Array.from(secretBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  const existing = await getPlayer(c.env, playerId);
  if (existing) {
    return c.json({ ok: false, error: "ID collision, retry" }, 500);
  }

  const player: PlayerProfile = {
    player_id: playerId,
    display_name: body.display_name,
    registered_at: Math.floor(Date.now() / 1000),
    items: [],
    post_summaries: [],
    secret,
  };

  await putPlayer(c.env, player);
  await addToPlayerIndex(c.env, playerId);

  return c.json({
    ok: true,
    player_id: playerId,
    secret,
  }, 201);
});

export default app;
