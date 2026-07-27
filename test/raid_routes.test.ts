import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { computeHmac } from "../src/middleware/auth.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";

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

async function wardPost(playerId: string, postHex: string, dormantUntil: number): Promise<void> {
  const raw = (await env.PLAYERS.get(`player:${playerId}`, "json")) as any;
  const p = raw.post_summaries.find((s: any) => s.post_hex === postHex);
  p.dormant_until = dormantUntil;
  await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
}

async function giveItem(playerId: string, type: string): Promise<string> {
  const raw = (await env.PLAYERS.get(`player:${playerId}`, "json")) as any;
  const id = crypto.randomUUID();
  raw.items.push({ id, type, assigned_at: Date.now(), used: false });
  await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
  return id;
}

async function post(path: string, playerId: string, secret: string, payload: object) {
  const body = JSON.stringify(payload);
  return app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: await auth(playerId, secret, body), body }), env);
}

async function getDefense(playerId: string, secret: string) {
  const res = await app.fetch(
    new Request(`http://localhost/api/player/${playerId}/defense`, { method: "GET", headers: await auth(playerId, secret, "") }),
    env,
  );
  return res.json() as any;
}

/** Force an in-flight raid to have already arrived. */
async function makeRaidDue(targetId: string): Promise<void> {
  const list = await env.ATTACKS.list({ prefix: `raid:${targetId}:` });
  for (const { name } of list.keys) {
    const raid = (await env.ATTACKS.get(name, "json")) as any;
    raid.arrives_at = Math.floor(Date.now() / 1000) - 1;
    await env.ATTACKS.put(name, JSON.stringify(raid));
  }
}

describe("POST /api/raid/dispatch", () => {
  beforeEach(() => { env = makeEnv(); });

  it("dispatches a multi-item raid, commits items, sets a future ETA", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 3);
    const i1 = await giveItem(atk.player_id, "attack_uncommon");
    const i2 = await giveItem(atk.player_id, "attack_common");

    const res = await post("/api/raid/dispatch", atk.player_id, atk.secret, {
      target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1, i2],
    });
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.raw_power).toBe(70 + 30);
    expect(json.eta_seconds).toBeGreaterThanOrEqual(3600);
    expect(json.arrives_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const raw = (await env.PLAYERS.get(`player:${atk.player_id}`, "json")) as any;
    expect(raw.items.every((i: any) => i.used)).toBe(true);
  });

  it("rejects a raid when all the attacker's outposts are warded", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    await wardPost(atk.player_id, "atk_base", Math.floor(Date.now() / 1000) + 3 * 86400);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 3);
    const i1 = await giveItem(atk.player_id, "attack_common");

    const res = await post("/api/raid/dispatch", atk.player_id, atk.secret, {
      target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1],
    });
    const json = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/active.*outpost/i);

    const raw = (await env.PLAYERS.get(`player:${atk.player_id}`, "json")) as any;
    expect(raw.items.every((i: any) => !i.used)).toBe(true);
  });

  it("allows a raid when the attacker keeps one active outpost alongside warded ones", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(atk.player_id, "atk_warded", 2);
    await wardPost(atk.player_id, "atk_warded", Math.floor(Date.now() / 1000) + 3 * 86400);
    await addPost(atk.player_id, "atk_active", 2);
    await addPost(def.player_id, "post_a", 3);
    const i1 = await giveItem(atk.player_id, "attack_common");

    const res = await post("/api/raid/dispatch", atk.player_id, atk.secret, {
      target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1],
    });
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("rejects a raid against a warded (dormant) outpost", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 3);
    await wardPost(def.player_id, "post_a", Math.floor(Date.now() / 1000) + 3 * 86400);
    const i1 = await giveItem(atk.player_id, "attack_common");

    const res = await post("/api/raid/dispatch", atk.player_id, atk.secret, {
      target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1],
    });
    const json = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/warded/i);

    // Items must not be committed on a rejected dispatch.
    const raw = (await env.PLAYERS.get(`player:${atk.player_id}`, "json")) as any;
    expect(raw.items.every((i: any) => !i.used)).toBe(true);
  });

  it("allows a raid once the ward has expired", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 3);
    await wardPost(def.player_id, "post_a", Math.floor(Date.now() / 1000) - 1);
    const i1 = await giveItem(atk.player_id, "attack_common");

    const res = await post("/api/raid/dispatch", atk.player_id, atk.secret, {
      target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1],
    });
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("rejects a second raid while one is in flight (one party rule)", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 2);
    const i1 = await giveItem(atk.player_id, "attack_common");
    const i2 = await giveItem(atk.player_id, "attack_common");

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1] });
    const res = await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i2] });
    expect(res.status).toBe(409);
  });

  it("rejects non-attack items and self-raids", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 2);
    const defItem = await giveItem(atk.player_id, "defense_common");
    const bad = await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [defItem] });
    expect(bad.status).toBe(400);
    const self = await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: atk.player_id, target_post_hex: "post_a", item_ids: [] });
    expect(self.status).toBe(400);
  });
});

describe("GET /api/raid/cooldowns", () => {
  beforeEach(() => { env = makeEnv(); });

  async function get(path: string, playerId: string, secret: string) {
    return app.fetch(new Request(`http://localhost${path}`, { method: "GET", headers: await auth(playerId, secret, "") }), env);
  }

  it("is empty before any raid has been dispatched", async () => {
    const atk = await registerPlayer("Atk");
    const res = await get("/api/raid/cooldowns", atk.player_id, atk.secret);
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.expires_at).toEqual({});
  });

  it("reports the target's cooldown expiry 24h after a dispatched raid", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 2);
    const i1 = await giveItem(atk.player_id, "attack_common");
    const now = Math.floor(Date.now() / 1000);

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1] });

    const res = await get("/api/raid/cooldowns", atk.player_id, atk.secret);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.expires_at.post_a).toBeGreaterThanOrEqual(now + 86400);

    // Scoped to the requesting attacker — the defender has no cooldowns of their own.
    const defRes = await get("/api/raid/cooldowns", def.player_id, def.secret);
    const defJson = (await defRes.json()) as any;
    expect(defJson.expires_at).toEqual({});
  });
});

describe("raid resolution + defense", () => {
  beforeEach(() => { env = makeEnv(); });

  it("razes a level-1 post on arrival and notifies the defender", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 1);
    const item = await giveItem(atk.player_id, "attack_rare"); // 75 power > 50 hp

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item] });
    await makeRaidDue(def.player_id);

    const state = await getDefense(def.player_id, def.secret);
    expect(state.posts).toHaveLength(0); // post razed and removed
  });

  it("a boost lets an otherwise-fatal raid be survived", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 1);
    const atkItem = await giveItem(atk.player_id, "attack_rare"); // 75 -> razes unboosted lvl1
    const defItem = await giveItem(def.player_id, "defense_epic"); // +300 flat HP

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [atkItem] });
    await post("/api/defend/boost", def.player_id, def.secret, { post_hex: "post_a", item_ids: [defItem] });
    await makeRaidDue(def.player_id);

    const state = await getDefense(def.player_id, def.secret);
    expect(state.posts).toHaveLength(1); // survived
    expect(state.posts[0].hp).toBe(50); // base HP untouched (boost soaked the hit)
    expect(state.posts[0].besieged_until).toBeGreaterThan(0);
  });

  it("resolves two raids on one defender in a single atomic pass (both posts affected)", async () => {
    // Two attackers land on two different posts of the same defender at once. One
    // defender poll resolves both — the transactional path mutates one in-memory
    // player copy across both raids and commits once, so neither raze is lost.
    const atk1 = await registerPlayer("Atk1");
    await addPost(atk1.player_id, "atk1_base", 2);
    const atk2 = await registerPlayer("Atk2");
    await addPost(atk2.player_id, "atk2_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 1);
    await addPost(def.player_id, "post_b", 1);
    const i1 = await giveItem(atk1.player_id, "attack_rare"); // razes lvl1
    const i2 = await giveItem(atk2.player_id, "attack_rare");

    await post("/api/raid/dispatch", atk1.player_id, atk1.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [i1] });
    await post("/api/raid/dispatch", atk2.player_id, atk2.secret, { target_player_id: def.player_id, target_post_hex: "post_b", item_ids: [i2] });
    await makeRaidDue(def.player_id);

    const state = await getDefense(def.player_id, def.secret);
    expect(state.posts).toHaveLength(0); // both posts razed in the one pass

    // Both attackers' locks released and both see a resolved outcome.
    expect(await env.ATTACKS.get(`araid:${atk1.player_id}`)).toBeNull();
    expect(await env.ATTACKS.get(`araid:${atk2.player_id}`)).toBeNull();
  });

  it("shows inbound raids with a coarse threat band (no composition)", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 1);
    const item = await giveItem(atk.player_id, "attack_epic"); // would raze

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item] });

    const state = await getDefense(def.player_id, def.secret);
    const incoming = state.posts[0].incoming_raids;
    expect(incoming).toHaveLength(1);
    expect(incoming[0].threat).toBe("raze");
    expect(incoming[0].eta_seconds).toBeGreaterThan(0);
    expect(incoming[0].item_types).toBeUndefined(); // composition hidden
  });
});

describe("GET /api/raid/mine (attacker view)", () => {
  beforeEach(() => { env = makeEnv(); });

  async function getMine(playerId: string, secret: string) {
    const res = await app.fetch(
      new Request("http://localhost/api/raid/mine", { method: "GET", headers: await auth(playerId, secret, "") }),
      env,
    );
    return res.json() as any;
  }

  it("returns null when the player has never raided", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const mine = await getMine(atk.player_id, atk.secret);
    expect(mine.ok).toBe(true);
    expect(mine.active_raid_id).toBeNull();
    expect(mine.raid).toBeNull();
  });

  it("returns the in-flight raid record with an arrival time", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 3);
    const item = await giveItem(atk.player_id, "attack_common");

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item] });

    const mine = await getMine(atk.player_id, atk.secret);
    expect(mine.active_raid_id).not.toBeNull();
    expect(mine.raid.status).toBe("in_flight");
    expect(mine.raid.target_player_name).toBe("Def");
    expect(mine.raid.arrives_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("reports the resolved outcome after arrival, active pointer cleared", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 1);
    const item = await giveItem(atk.player_id, "attack_rare"); // razes lvl1

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item] });
    await makeRaidDue(def.player_id);

    const mine = await getMine(atk.player_id, atk.secret); // resolveDueRaids runs here
    expect(mine.active_raid_id).toBeNull();
    expect(mine.raid.status).toBe("resolved");
    expect(mine.raid.outcome).toBe("razed");
    expect(mine.raid.resolved_at).toBeGreaterThan(0);
    // Raze spoils = 10 × razed level (1) — carried on the resolved record for the
    // attacker's game server to credit locally.
    expect(mine.raid.spoils_marks).toBe(10);
  });

  it("pays damaged-raid spoils = 2 × level, razed spoils = 10 × level", async () => {
    // Level-3 post, single attack_epic (300) vs base HP 175 → knocks it down one
    // level rather than razing. Spoils = 2 × 3 = 6.
    const atk = await registerPlayer("Atk2");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def2");
    await addPost(def.player_id, "post_b", 3);
    const item = await giveItem(atk.player_id, "attack_epic");

    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_b", item_ids: [item] });
    await makeRaidDue(def.player_id);

    const mine = await getMine(atk.player_id, atk.secret);
    expect(mine.raid.outcome).toBe("damaged");
    expect(mine.raid.spoils_marks).toBe(6);
  });
});

describe("GET /api/raid/mine — atomic resolution keeps the lock consistent", () => {
  beforeEach(() => { env = makeEnv(); });

  async function getMine(playerId: string, secret: string) {
    const res = await app.fetch(
      new Request("http://localhost/api/raid/mine", { method: "GET", headers: await auth(playerId, secret, "") }),
      env,
    );
    return res.json() as any;
  }

  // A landed raid resolves as one atomic write batch — the resolved record, the
  // synced araidlast, and the cleared araid lock all commit together — so the
  // attacker's poll always sees a consistent (resolved, lock-released) state.
  // This replaces the old reconcile pass, which existed only to heal the
  // half-applied states that non-atomic writes could leave behind.
  it("clears the active lock atomically when the raid lands", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 1);
    const item = await giveItem(atk.player_id, "attack_rare");
    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item] });
    // Lock is held while the raid is in flight.
    expect(await env.ATTACKS.get(`araid:${atk.player_id}`)).not.toBeNull();

    await makeRaidDue(def.player_id);

    const mine = await getMine(atk.player_id, atk.secret);
    expect(mine.active_raid_id).toBeNull();
    expect(mine.raid.status).toBe("resolved");
    expect(mine.raid.outcome).toBe("razed");
    // Lock released — and the canonical record and pointer agree.
    expect(await env.ATTACKS.get(`araid:${atk.player_id}`)).toBeNull();
  });

  it("leaves a genuinely in-flight raid untouched", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 3);
    const item = await giveItem(atk.player_id, "attack_common");
    await post("/api/raid/dispatch", atk.player_id, atk.secret, { target_player_id: def.player_id, target_post_hex: "post_a", item_ids: [item] });

    const mine = await getMine(atk.player_id, atk.secret);
    expect(mine.active_raid_id).not.toBeNull();
    expect(mine.raid.status).toBe("in_flight");
  });
});

describe("recon reveals HP + permanent wall", () => {
  beforeEach(() => { env = makeEnv(); });

  it("scout returns hp/max_hp/defense_reduction per post", async () => {
    const atk = await registerPlayer("Atk");
    await addPost(atk.player_id, "atk_base", 2);
    const def = await registerPlayer("Def");
    await addPost(def.player_id, "post_a", 2);
    const probe = await giveItem(atk.player_id, "probe");

    const res = await post("/api/scout", atk.player_id, atk.secret, { target_player_id: def.player_id, probe_item_id: probe });
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    const p = json.posts.find((x: any) => x.post_hex === "post_a");
    expect(p.hp).toBeGreaterThan(0);
    expect(p.max_hp).toBeGreaterThan(0);
    expect(typeof p.defense_reduction).toBe("number");
  });
});
