import { Hono } from "hono";
import type { Env, RegisterRequest, PlayerProfile } from "../types.js";
import { getPlayer, putPlayer, addToPlayerIndex } from "../kv/queries.js";
import { timingSafeEqual } from "../middleware/auth.js";
import { snapshotRead, MutationBuffer } from "../kv/composite.js";
import { playerKey, PLAYER_INDEX_KEY, registerDailyKey, registerIpDailyKey, NS } from "../kv/schema.js";

const app = new Hono<{ Bindings: Env }>();

// Registration counters live two UTC days so the date bucket survives clock skew.
const REGISTER_COUNTER_TTL = 172800; // 48h

/** Today's UTC date (YYYY-MM-DD), server time — registration has no trusted
 *  client timestamp, so the bucket can't be walked forward. */
function utcDate(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** A configured positive-integer cap, or null when the env var is unset/invalid
 *  (→ that cap is not enforced). */
function positiveCap(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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

  // --- Registration caps (all opt-in; unset = off, like REGISTER_SECRET) ------
  // The invite code is a *shared* secret — every player's client config holds
  // it — so it stops strangers but not a holder (or a leak) minting players in a
  // loop. These caps bound player *creation*: a lifetime roster ceiling plus
  // per-day global and per-IP limits. Raw request volume is a separate concern,
  // bounded at the Cloudflare edge (WAF rate-limit rule), not here.
  const maxTotal = positiveCap(c.env.MAX_TOTAL_PLAYERS);
  const dailyLimit = positiveCap(c.env.REGISTER_DAILY_LIMIT);
  const ipDailyLimit = positiveCap(c.env.REGISTER_IP_DAILY_LIMIT);
  const capsActive = maxTotal !== null || dailyLimit !== null || ipDailyLimit !== null;

  const date = utcDate();
  const globalKey = registerDailyKey(date);
  const ip = c.req.header("CF-Connecting-IP") ?? "";
  // No client IP (local dev / a stripped header) → the per-IP cap can't be keyed,
  // so it's skipped; the global and total caps still apply.
  const ipKey = ip ? registerIpDailyKey(ip, date) : null;

  const buf = new MutationBuffer();
  let index: string[] = [];
  let globalCount = 0;
  let ipCount = 0;

  if (capsActive) {
    // One snapshot carries the roster index and both day counters. Cheap-reject
    // an over-cap registration before minting anything.
    const snap = await snapshotRead(
      c.env,
      [
        { ns: NS.META, key: PLAYER_INDEX_KEY },
        { ns: NS.META, key: globalKey },
        ...(ipKey ? [{ ns: NS.META, key: ipKey }] : []),
      ],
      [],
    );
    index = snap.exact[0] ? (JSON.parse(snap.exact[0]) as string[]) : [];
    globalCount = parseInt(snap.exact[1] ?? "0", 10);
    ipCount = ipKey ? parseInt(snap.exact[2] ?? "0", 10) : 0;

    if (maxTotal !== null && index.length >= maxTotal) {
      return c.json({ ok: false, error: "Registration is closed (roster full)" }, 403);
    }
    if (dailyLimit !== null && globalCount >= dailyLimit) {
      return c.json({ ok: false, error: "Daily registration limit reached — try again tomorrow" }, 429);
    }
    if (ipDailyLimit !== null && ipKey && ipCount >= ipDailyLimit) {
      return c.json({ ok: false, error: "Too many registrations from this network today" }, 429);
    }
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

  if (capsActive) {
    // Persist the player, extend the roster index (already read above), and bump
    // whichever day counters are enforced — all in one atomic commit, so the
    // counter can't drift from the players actually created.
    buf.put(NS.PLAYERS, playerKey(playerId), JSON.stringify(player));
    if (!index.includes(playerId)) {
      index.push(playerId);
      buf.put(NS.META, PLAYER_INDEX_KEY, JSON.stringify(index));
    }
    if (dailyLimit !== null) {
      buf.put(NS.META, globalKey, String(globalCount + 1), REGISTER_COUNTER_TTL);
    }
    if (ipDailyLimit !== null && ipKey) {
      buf.put(NS.META, ipKey, String(ipCount + 1), REGISTER_COUNTER_TTL);
    }
    await buf.commit(c.env);
  } else {
    // Open-registration path unchanged: no index read, so use the standalone
    // helpers exactly as before.
    await putPlayer(c.env, player);
    await addToPlayerIndex(c.env, playerId);
  }

  return c.json({
    ok: true,
    player_id: playerId,
    secret,
  }, 201);
});

export default app;
