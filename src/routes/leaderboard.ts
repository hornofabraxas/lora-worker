import { Hono } from "hono";
import type { Env } from "../types.js";
import { authMiddleware } from "../middleware/auth.js";
import { getLeaderboardCache } from "../logic/leaderboard.js";
import { getOverrides, applyPostName, applyPlayerName } from "../logic/moderation.js";

const app = new Hono<{ Bindings: Env; Variables: { playerId: string } }>();

// Registered players only: with registration invite-gated, the leaderboard is
// the community's board, not the internet's. (It was the last unauthenticated
// read after the federation-era ledger and public-profile routes were removed.)
app.get("/api/leaderboard", authMiddleware, async (c) => {
  const now = Math.floor(Date.now() / 1000);

  // Precomputed snapshot (batched rebuild on a stale/missing read) plus the live
  // moderation overrides. This is O(1) storage reads regardless of player count —
  // the per-player fan-out that used to bound the leaderboard now happens only on
  // a rebuild, and never explodes the subrequest budget (see logic/leaderboard.ts).
  const cache = await getLeaderboardCache(c.env, now);
  const overrides = await getOverrides(c.env);

  // Distance is deliberately absent here. Proximity to a rival is secret until a
  // player spends a probe to scout them (POST /api/scout returns a fuzzed
  // distance_mi), replacing the old always-visible nearby/regional/distant band.
  const players = cache.entries.map((e) => ({
    player_id: e.player_id,
    display_name: applyPlayerName(overrides, e.player_id, e.display_name),
    active_title: e.active_title,
    total_renown: e.total_renown,
    renown_per_day: e.renown_per_day,
    post_count: e.post_count,
    post_tokens: e.post_tokens,
    posts: e.posts.map((p) => ({
      post_token: p.post_token,
      name: applyPostName(overrides, e.player_id, p.post_token, p.name),
    })),
    under_siege: false,
  }));

  players.sort((a, b) => b.total_renown - a.total_renown);

  return c.json({ players });
});

export default app;
