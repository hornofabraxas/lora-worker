import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { computeHmac } from "../src/middleware/auth.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { getLeaderboardAs } from "./helpers/auth.js";

let env: Env;

async function registerPlayer(name: string): Promise<{ player_id: string; secret: string }> {
  const res = await app.fetch(
    new Request("http://localhost/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: name, coarse_cells: ["831a00fffffffff"] }),
    }),
    env,
  );
  return res.json();
}

async function auth(playerId: string, secret: string, body: string): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await computeHmac(secret, playerId + timestamp + body);
  return { "X-Player-ID": playerId, "X-Timestamp": timestamp, "X-Signature": signature, "Content-Type": "application/json" };
}

async function addPost(playerId: string, postHex: string, level: number): Promise<void> {
  const raw = (await env.PLAYERS.get(`player:${playerId}`, "json")) as any;
  raw.post_summaries.push({ post_hex: postHex, level, chartered_at: Math.floor(Date.now() / 1000) - 864000, coarse_cell: "831a00fffffffff" });
  await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
}

async function giveItem(playerId: string, type: string): Promise<string> {
  const raw = (await env.PLAYERS.get(`player:${playerId}`, "json")) as any;
  const id = crypto.randomUUID();
  raw.items.push({ id, type, assigned_at: Date.now(), used: false });
  await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
  return id;
}

async function get(path: string, playerId: string, secret: string) {
  return app.fetch(new Request(`http://localhost${path}`, { method: "GET", headers: await auth(playerId, secret, "") }), env);
}

async function post(path: string, playerId: string, secret: string, payload: object) {
  const body = JSON.stringify(payload);
  return app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: await auth(playerId, secret, body), body }), env);
}

/** Force every in-flight raid on a target to have already arrived. */
async function makeRaidDue(targetId: string): Promise<void> {
  const list = await env.ATTACKS.list({ prefix: `raid:${targetId}:` });
  for (const { name } of list.keys) {
    const raid = (await env.ATTACKS.get(name, "json")) as any;
    raid.arrives_at = Math.floor(Date.now() / 1000) - 1;
    await env.ATTACKS.put(name, JSON.stringify(raid));
  }
}

describe("GET /api/status auth (inline, folded into the snapshot)", () => {
  beforeEach(() => { env = makeEnv(); });

  it("rejects a request with no auth headers", async () => {
    const res = await app.fetch(new Request("http://localhost/api/status"), env);
    expect(res.status).toBe(401);
  });

  it("rejects a request with a bad signature", async () => {
    const p = await registerPlayer("Sig");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await app.fetch(
      new Request("http://localhost/api/status", {
        headers: { "X-Player-ID": p.player_id, "X-Timestamp": timestamp, "X-Signature": "deadbeef" },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a well-signed request for an unknown player", async () => {
    // Valid HMAC over a secret the Worker never issued — must 401 as unknown.
    const res = await app.fetch(
      new Request("http://localhost/api/status", { headers: await auth("nobody", "nosecret", "") }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/status (combined defense + raid poll)", () => {
  beforeEach(() => { env = makeEnv(); });

  it("returns defense posts and raid halves in one response", async () => {
    const p = await registerPlayer("Solo");
    await addPost(p.player_id, "post_a", 2);

    const res = await get("/api/status", p.player_id, p.secret);
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // Defense half mirrors GET /api/player/:id/defense.
    expect(json.defense.ok).toBe(true);
    expect(json.defense.posts).toHaveLength(1);
    expect(json.defense.posts[0].post_hex).toBe("post_a");
    // Raid half mirrors GET /api/raid/mine — idle here.
    expect(json.raid.ok).toBe(true);
    expect(json.raid.active_raid_id).toBeNull();
    expect(json.raid.raid).toBeNull();
  });

  it("surfaces an attacker's in-flight raid and a defender's incoming raid", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 3);
    const item = await giveItem(atk.player_id, "attack_uncommon");

    const dispatch = await post("/api/raid/dispatch", atk.player_id, atk.secret, {
      target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item],
    });
    expect(dispatch.status).toBe(200);

    // Attacker sees their own party in flight.
    const atkStatus = (await (await get("/api/status", atk.player_id, atk.secret)).json()) as any;
    expect(atkStatus.raid.active_raid_id).not.toBeNull();
    expect(atkStatus.raid.raid.status).toBe("in_flight");

    // Defender sees an inbound raid on the targeted post.
    const defStatus = (await (await get("/api/status", def.player_id, def.secret)).json()) as any;
    const targeted = defStatus.defense.posts.find((p: any) => p.post_hex === "post_a");
    expect(targeted.incoming_raids.length).toBe(1);
    expect(targeted.incoming_raids[0].eta_seconds).toBeGreaterThan(0);
  });

  it("resolves a landed raid through the poll and reflects the outcome for both sides", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 1);
    const item = await giveItem(atk.player_id, "attack_rare"); // razes lvl1

    await post("/api/raid/dispatch", atk.player_id, atk.secret, {
      target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item],
    });
    await makeRaidDue(def.player_id);

    // Defender's poll detects the landed raid, resolves it, and re-snapshots:
    // the razed post is gone and no inbound raid remains.
    const defStatus = (await (await get("/api/status", def.player_id, def.secret)).json()) as any;
    expect(defStatus.defense.posts).toHaveLength(0);

    // Attacker's poll shows the resolved outcome and a released lock.
    const atkStatus = (await (await get("/api/status", atk.player_id, atk.secret)).json()) as any;
    expect(atkStatus.raid.active_raid_id).toBeNull();
    expect(atkStatus.raid.raid.status).toBe("resolved");
    expect(atkStatus.raid.raid.outcome).toBe("razed");
  });
});

describe("leaderboard snapshot invalidation", () => {
  beforeEach(() => { env = makeEnv(); });

  it("reflects a new player registered after an earlier read (cache invalidated on write)", async () => {
    const a = await registerPlayer("Alpha");
    await addPost(a.player_id, "a_post", 3);

    // First read populates the snapshot with just Alpha.
    let lb = (await getLeaderboardAs(env, a)) as any;
    expect(lb.players.map((p: any) => p.display_name)).toEqual(["Alpha"]);

    // A second player registers — registration writes a player, invalidating the
    // snapshot even though it was built moments ago.
    const b = await registerPlayer("Bravo");
    await addPost(b.player_id, "b_post", 5);

    lb = (await getLeaderboardAs(env, a)) as any;
    expect(lb.players.map((p: any) => p.display_name).sort()).toEqual(["Alpha", "Bravo"]);
    // Higher-level post sorts first on renown.
    expect(lb.players[0].display_name).toBe("Bravo");
  });
});
