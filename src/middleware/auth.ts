import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env, PlayerProfile } from "../types.js";
import { getPlayer, bumpAuditReject } from "../kv/queries.js";

const encoder = new TextEncoder();

export async function computeHmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

type AuthCtx = { Bindings: Env; Variables: { playerId: string } };

/**
 * Cheap presence + timestamp-skew check, no DB. Returns a 401 Response to send,
 * or null if the headers are well-formed. Split out so a route can reject a
 * malformed request before spending a storage read.
 */
export function precheckAuthHeaders(c: Context<AuthCtx>): Response | null {
  const playerId = c.req.header("X-Player-ID");
  const timestamp = c.req.header("X-Timestamp");
  const signature = c.req.header("X-Signature");
  if (!playerId || !timestamp || !signature) {
    return c.json({ ok: false, error: "Missing auth headers" }, 401);
  }
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) {
    return c.json({ ok: false, error: "Timestamp too old" }, 401);
  }
  return null;
}

/**
 * Verify the request signature against an already-read player (and reject a
 * frozen one). Assumes precheckAuthHeaders has passed. Returns a 401/403 Response
 * on failure — recording an audit reject — or null on success.
 *
 * Taking the player as an argument is what lets the hot GET/POST routes fold the
 * auth read into the snapshot they already do: read the player once, verify from
 * it, no separate getPlayer round trip.
 */
export async function verifyPlayerSignature(
  c: Context<AuthCtx>,
  player: PlayerProfile | null,
): Promise<Response | null> {
  const playerId = c.req.header("X-Player-ID")!;
  const timestamp = c.req.header("X-Timestamp")!;
  const signature = c.req.header("X-Signature")!;

  if (!player) {
    return c.json({ ok: false, error: "Unknown player" }, 401);
  }

  const body = await c.req.text();
  const expected = await computeHmac(player.secret_hash, playerId + timestamp + body);
  if (!timingSafeEqual(expected, signature)) {
    await bumpAuditReject(c.env, playerId);
    return c.json({ ok: false, error: "Invalid signature" }, 401);
  }

  // Reversible operator suspension: a frozen player authenticates but cannot
  // write. History and standing are preserved; unfreeze restores access.
  //
  // Deliberately does NOT count an audit reject. The signature was valid — this
  // is a suspension the operator chose, not evidence of a modified client. A
  // frozen player's client keeps retrying on its normal sync interval, so
  // counting these would march every frozen account past the reject threshold
  // and manufacture a second flag out of the operator's own decision.
  if (player.frozen) {
    return c.json({ ok: false, error: "Account suspended" }, 403);
  }

  return null;
}

export const authMiddleware = createMiddleware<AuthCtx>(async (c, next) => {
  const pre = precheckAuthHeaders(c);
  if (pre) return pre;
  const playerId = c.req.header("X-Player-ID")!;
  const player = await getPlayer(c.env, playerId);
  const fail = await verifyPlayerSignature(c, player);
  if (fail) return fail;
  c.set("playerId", playerId);
  await next();
});
