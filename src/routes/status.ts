import { Hono } from "hono";
import type { Env, PlayerProfile, RaidRecord } from "../types.js";
import { precheckAuthHeaders, verifyPlayerSignature } from "../middleware/auth.js";
import { playerKey, NS } from "../kv/schema.js";
import { snapshotRead, MutationBuffer } from "../kv/composite.js";
import { resolveDueRaids, resolveAttackerRaid } from "../logic/resolve.js";
import { assembleDefensePosts, parseDefenseRanges, DEFENSE_SCAN_LIMIT, INBOUND_RAID_SCAN_LIMIT } from "./defense.js";

const app = new Hono<{ Bindings: Env; Variables: { playerId: string } }>();

interface StatusSnapshot {
  player: PlayerProfile | null;
  activeRaidId: string | null;
  attackerLast: RaidRecord | null;
  defenseRows: { key: string; value: string }[];
  raidRows: { key: string; value: string }[];
}

/** One RPC reads everything a status response needs: the player, both attacker
 *  pointers, all defense rows, and all inbound raids. */
async function statusSnapshot(env: Env, playerId: string): Promise<StatusSnapshot> {
  const snap = await snapshotRead(
    env,
    [
      { ns: NS.PLAYERS, key: playerKey(playerId) },
      { ns: NS.ATTACKS, key: `araid:${playerId}` },
      { ns: NS.ATTACKS, key: `araidlast:${playerId}` },
    ],
    [
      { ns: NS.DEFENSE, key: `defense:${playerId}:`, limit: DEFENSE_SCAN_LIMIT },
      { ns: NS.ATTACKS, key: `raid:${playerId}:`, limit: INBOUND_RAID_SCAN_LIMIT },
    ],
  );
  return {
    player: snap.exact[0] ? (JSON.parse(snap.exact[0]) as PlayerProfile) : null,
    activeRaidId: snap.exact[1],
    attackerLast: snap.exact[2] ? (JSON.parse(snap.exact[2]) as RaidRecord) : null,
    defenseRows: snap.ranges[0],
    raidRows: snap.ranges[1],
  };
}

/**
 * One combined poll: a player's defense view *and* their own outbound raid, in a
 * single request. The game server polls this instead of hitting
 * /api/player/:id/defense and /api/raid/mine separately.
 *
 * The idle path — no raid has landed — costs a single snapshot RPC: we detect
 * from that snapshot whether anything is actually due before paying for any
 * resolution. Only when a raid has landed do we resolve (atomically) and take a
 * second snapshot to reflect the outcome. This is what keeps the dominant
 * steady-state poll cheap enough to scale.
 *
 * The response nests each half under its original shape ({ ok, posts } and
 * { ok, active_raid_id, raid }) so the client reuses the exact handlers that
 * consumed the two endpoints.
 */
app.get("/api/status", async (c) => {
  // Auth folded into the poll's own snapshot: precheck the headers (cheap, no
  // DB), read the player as part of the status snapshot, then verify the
  // signature from that same player — so the whole idle poll is one storage RPC.
  const pre = precheckAuthHeaders(c);
  if (pre) return pre;
  const playerId = c.req.header("X-Player-ID")!;
  const now = Math.floor(Date.now() / 1000);

  let snap = await statusSnapshot(c.env, playerId);
  const authFail = await verifyPlayerSignature(c, snap.player);
  if (authFail) return authFail;

  // Detect landed raids from the snapshot before spending any resolution reads.
  const incomingDue = snap.raidRows.some((r) => {
    const raid = JSON.parse(r.value) as RaidRecord;
    return raid.status === "in_flight" && raid.arrives_at <= now;
  });
  const ownDue =
    snap.attackerLast?.status === "in_flight" && snap.attackerLast.arrives_at <= now;

  if (incomingDue || ownDue) {
    // Resolve atomically (each does its own read + one atomic commit), then
    // re-snapshot so the response reflects the landed outcomes.
    if (incomingDue) await resolveDueRaids(c.env, playerId);
    if (ownDue) await resolveAttackerRaid(c.env, playerId);
    snap = await statusSnapshot(c.env, playerId);
    if (!snap.player) {
      return c.json({ ok: false, error: "Player not found" }, 404);
    }
  }

  // Non-null past here: verifyPlayerSignature 401s on a missing player, and the
  // re-snapshot branch 404s if it vanished mid-request.
  const player = snap.player!;
  const { defByHex, inFlight } = parseDefenseRanges(playerId, snap.defenseRows, snap.raidRows, now);
  const missing = new MutationBuffer();
  const posts = assembleDefensePosts(playerId, player.post_summaries, now, defByHex, inFlight, missing);
  await missing.commit(c.env);

  return c.json({
    ok: true,
    defense: { ok: true, posts },
    raid: { ok: true, active_raid_id: snap.activeRaidId ?? null, raid: snap.attackerLast ?? null },
  });
});

export default app;
