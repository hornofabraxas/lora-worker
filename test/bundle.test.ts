import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { computeHmac } from "../src/middleware/auth.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";


let env: Env;

async function registerPlayer(name: string = "TestPlayer"): Promise<{ player_id: string; secret: string }> {
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

async function makeAuthHeaders(
  playerId: string,
  secret: string,
  body: string,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = playerId + timestamp + body;
  const signature = await computeHmac(secret, message);
  return {
    "X-Player-ID": playerId,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
    "Content-Type": "application/json",
  };
}

describe("POST /api/register", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("registers a new player", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "NewPlayer", coarse_cells: ["831a00fffffffff"] }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(typeof data.player_id).toBe("string");
    expect(typeof data.secret).toBe("string");
    expect(data.secret).toHaveLength(64);
  });

  it("rejects empty display_name", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "", coarse_cells: ["831a00fffffffff"] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("registers without coarse_cells (field retired with the ledger)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Test" }),
      }),
      env,
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /api/bundle", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("accepts a valid bundle and returns drops", async () => {
    const { player_id, secret } = await registerPlayer();

    const bundleBody = JSON.stringify({
      survey_count: 5,
      discoveries: 2,
      provisions_earned: 100,
      xp_earned: 50,
      field_notes_earned: 10,
      post_surveys: [],
      coarse_cells: ["831a00fffffffff"],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.drops)).toBe(true);
    expect(Array.isArray(data.notifications)).toBe(true);
    // Ledger feed retired: bundles no longer echo other players' activity.
    expect(data.ledger_entries_since).toBeUndefined();
  });

  async function pushBundle(player_id: string, secret: string, extra: Record<string, unknown>) {
    const body = JSON.stringify({
      survey_count: 0, discoveries: 0, provisions_earned: 0, xp_earned: 0,
      field_notes_earned: 0, post_surveys: [], coarse_cells: [],
      timestamp: Math.floor(Date.now() / 1000), ...extra,
    });
    const headers = await makeAuthHeaders(player_id, secret, body);
    return app.fetch(new Request("http://localhost/api/bundle", { method: "POST", headers, body }), env);
  }

  it("mints a tier-IV contract munition grant into the inventory", async () => {
    const { player_id, secret } = await registerPlayer();
    const res = await pushBundle(player_id, secret, {
      item_grants: [{ id: "contract-7-attack_epic", type: "attack_epic" }],
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    const minted = data.all_items.filter((i: any) => i.id === "contract-7-attack_epic");
    expect(minted).toHaveLength(1);
    expect(minted[0].type).toBe("attack_epic");
  });

  it("is idempotent — a re-sent grant id never double-mints", async () => {
    const { player_id, secret } = await registerPlayer();
    const now = Math.floor(Date.now() / 1000);
    await pushBundle(player_id, secret, {
      timestamp: now,
      item_grants: [{ id: "contract-7-defense_epic", type: "defense_epic" }],
    });
    const res = await pushBundle(player_id, secret, {
      timestamp: now + 1,
      item_grants: [{ id: "contract-7-defense_epic", type: "defense_epic" }],
    });
    const data = await res.json() as any;
    const minted = data.all_items.filter((i: any) => i.id === "contract-7-defense_epic");
    expect(minted).toHaveLength(1);
  });

  it("refuses to grant non-epic (or unknown) item types", async () => {
    const { player_id, secret } = await registerPlayer();
    const res = await pushBundle(player_id, secret, {
      item_grants: [
        { id: "g-common", type: "attack_common" },
        { id: "g-probe", type: "probe" },
        { id: "g-bogus", type: "free_money" },
      ],
    });
    const data = await res.json() as any;
    const sneaked = data.all_items.filter((i: any) =>
      ["g-common", "g-probe", "g-bogus"].includes(i.id));
    expect(sneaked).toHaveLength(0);
  });

  it("rejects without auth headers", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ survey_count: 1, timestamp: 1000 }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects invalid signature", async () => {
    const { player_id } = await registerPlayer();

    const bundleBody = JSON.stringify({
      survey_count: 1,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      coarse_cells: [],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers: {
          "X-Player-ID": player_id,
          "X-Timestamp": String(Math.floor(Date.now() / 1000)),
          "X-Signature": "bad_signature_00000000000000000000000000000000000000000000000000",
          "Content-Type": "application/json",
        },
        body: bundleBody,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects survey_count over maximum", async () => {
    const { player_id, secret } = await registerPlayer();

    const bundleBody = JSON.stringify({
      survey_count: 999,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      coarse_cells: [],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    expect(res.status).toBe(400);
  });

  it("returns surveys_accepted and daily cap info", async () => {
    const { player_id, secret } = await registerPlayer("CapTest");

    const bundleBody = JSON.stringify({
      survey_count: 10,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      coarse_cells: ["831a00fffffffff"],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.surveys_accepted).toBe(10);
    expect(data.daily_surveys_remaining).toBe(40); // 50 - 10
  });

  it("at the daily cap, drops surplus surveys but still applies admin updates", async () => {
    const { player_id, secret } = await registerPlayer("CapExhaust");

    // Seed the daily counter to the cap
    const date = new Date().toISOString().slice(0, 10);
    await env.META.put(`daily_surveys:${player_id}:${date}`, "50");

    // A capped-out player's bundle still carries administration — a charter and a
    // title change — which must persist even though the surveys are dropped.
    const bundleBody = JSON.stringify({
      survey_count: 5,
      discoveries: 2,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      coarse_cells: [],
      post_summaries: [{ post_token: "hex_admin", level: 1, chartered_at: Math.floor(Date.now() / 1000), coarse_cell: "831a00fffffffff" }],
      active_title: "Steadfast",
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    // Accepted (200), surveys dropped to 0, cap flagged for the client.
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.surveys_accepted).toBe(0);
    expect(data.daily_surveys_remaining).toBe(0);
    expect(data.daily_survey_cap_reached).toBe(true);

    // The administration in the same bundle still landed.
    const stored = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    expect(stored.post_summaries.find((p: any) => p.post_token === "hex_admin")).toBeDefined();
    expect(stored.active_title).toBe("Steadfast");
  });

  it("caps surveys_accepted when near daily limit", async () => {
    const { player_id, secret } = await registerPlayer("CapPartial");

    const date = new Date().toISOString().slice(0, 10);
    await env.META.put(`daily_surveys:${player_id}:${date}`, "45");

    const bundleBody = JSON.stringify({
      survey_count: 10,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      coarse_cells: [],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.surveys_accepted).toBe(5); // only 5 remaining
    expect(data.daily_surveys_remaining).toBe(0);
  });

  it("accepts a post level decrease (combat reconciliation)", async () => {
    // The game server reconciles a post's level down after a raid knocks it a
    // level (its raid notification carries the new level), so a decrease must be
    // accepted — the old hard rejection undid combat outcomes.
    const { player_id, secret } = await registerPlayer("LevelDrop");

    const raw = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    raw.post_summaries = [{
      post_token: "hex_a", level: 3,
      chartered_at: Math.floor(Date.now() / 1000) - 86400,
      coarse_cell: "831a00fffffffff",
    }];
    await env.PLAYERS.put(`player:${player_id}`, JSON.stringify(raw));

    const bundleBody = JSON.stringify({
      survey_count: 1,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      post_summaries: [{ post_token: "hex_a", level: 2, chartered_at: Math.floor(Date.now() / 1000) - 86400, coarse_cell: "831a00fffffffff" }],
      coarse_cells: [],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const stored = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    expect(stored.post_summaries.find((p: any) => p.post_token === "hex_a").level).toBe(2);
  });

  it("keeps a razed post gone even if the bundle re-sends it, then re-allows it after reconcile", async () => {
    const { player_id, secret } = await registerPlayer("Razed");

    // Simulate a raze: the post is gone from the profile and tombstoned.
    const raw = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    raw.post_summaries = [];
    await env.PLAYERS.put(`player:${player_id}`, JSON.stringify(raw));
    const { addRazeTombstone } = await import("../src/kv/queries.js");
    await addRazeTombstone(env, player_id, "hex_razed");

    // A lagging server re-sends the razed post: it must not come back.
    const body1 = JSON.stringify({
      survey_count: 0, discoveries: 0, provisions_earned: 0, xp_earned: 0,
      field_notes_earned: 0, post_surveys: [], coarse_cells: [],
      post_summaries: [{ post_token: "hex_razed", level: 2, chartered_at: 1, coarse_cell: "831a00fffffffff" }],
      timestamp: Math.floor(Date.now() / 1000),
    });
    const res1 = await app.fetch(new Request("http://localhost/api/bundle", {
      method: "POST", headers: await makeAuthHeaders(player_id, secret, body1), body: body1,
    }), env);
    expect(res1.status).toBe(200);
    let stored = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    expect(stored.post_summaries.find((p: any) => p.post_token === "hex_razed")).toBeUndefined();

    // Server reconciled (stops sending it): the tombstone self-clears.
    const body2 = JSON.stringify({
      survey_count: 0, discoveries: 0, provisions_earned: 0, xp_earned: 0,
      field_notes_earned: 0, post_surveys: [], coarse_cells: [], post_summaries: [],
      timestamp: Math.floor(Date.now() / 1000) + 1,
    });
    const res2 = await app.fetch(new Request("http://localhost/api/bundle", {
      method: "POST", headers: await makeAuthHeaders(player_id, secret, body2), body: body2,
    }), env);
    expect(res2.status).toBe(200);
    const { listRazeTombstones } = await import("../src/kv/queries.js");
    expect((await listRazeTombstones(env, player_id)).has("hex_razed")).toBe(false);

    // A fresh charter of the same location now sticks.
    const body3 = JSON.stringify({
      survey_count: 0, discoveries: 0, provisions_earned: 0, xp_earned: 0,
      field_notes_earned: 0, post_surveys: [], coarse_cells: [],
      post_summaries: [{ post_token: "hex_razed", level: 1, chartered_at: Math.floor(Date.now() / 1000), coarse_cell: "831a00fffffffff" }],
      timestamp: Math.floor(Date.now() / 1000) + 2,
    });
    const res3 = await app.fetch(new Request("http://localhost/api/bundle", {
      method: "POST", headers: await makeAuthHeaders(player_id, secret, body3), body: body3,
    }), env);
    expect(res3.status).toBe(200);
    stored = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    expect(stored.post_summaries.find((p: any) => p.post_token === "hex_razed").level).toBe(1);
  });

  it("allows post level jump > 1", async () => {
    const { player_id, secret } = await registerPlayer("LevelJump");

    // Give player a level 1 post
    const raw = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    raw.post_summaries = [{
      post_token: "hex_a", level: 1,
      chartered_at: Math.floor(Date.now() / 1000) - 86400,
      coarse_cell: "831a00fffffffff",
    }];
    await env.PLAYERS.put(`player:${player_id}`, JSON.stringify(raw));

    const bundleBody = JSON.stringify({
      survey_count: 1,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      post_summaries: [{ post_token: "hex_a", level: 3, chartered_at: Math.floor(Date.now() / 1000) - 86400, coarse_cell: "831a00fffffffff" }],
      coarse_cells: [],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    expect(res.status).toBe(200);
  });

  it("allows post level +1 upgrade", async () => {
    const { player_id, secret } = await registerPlayer("LevelOK");

    const raw = await env.PLAYERS.get(`player:${player_id}`, "json") as any;
    raw.post_summaries = [{
      post_token: "hex_b", level: 2,
      chartered_at: Math.floor(Date.now() / 1000) - 86400,
      coarse_cell: "831a00fffffffff",
    }];
    await env.PLAYERS.put(`player:${player_id}`, JSON.stringify(raw));

    const bundleBody = JSON.stringify({
      survey_count: 1,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      post_summaries: [{ post_token: "hex_b", level: 3, chartered_at: Math.floor(Date.now() / 1000) - 86400, coarse_cell: "831a00fffffffff" }],
      coarse_cells: [],
      timestamp: Math.floor(Date.now() / 1000),
    });

    const headers = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers,
        body: bundleBody,
      }),
      env,
    );

    expect(res.status).toBe(200);
  });

  it("rejects duplicate timestamp", async () => {
    const { player_id, secret } = await registerPlayer();
    const ts = Math.floor(Date.now() / 1000);

    const bundleBody = JSON.stringify({
      survey_count: 1,
      discoveries: 0,
      provisions_earned: 0,
      xp_earned: 0,
      field_notes_earned: 0,
      post_surveys: [],
      coarse_cells: [],
      timestamp: ts,
    });

    const headers1 = await makeAuthHeaders(player_id, secret, bundleBody);
    await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers: headers1,
        body: bundleBody,
      }),
      env,
    );

    const headers2 = await makeAuthHeaders(player_id, secret, bundleBody);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", {
        method: "POST",
        headers: headers2,
        body: bundleBody,
      }),
      env,
    );
    expect(res.status).toBe(409);
  });
});

describe("item grant weekly cap", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  async function push(playerId: string, secret: string, ts: number, grants: { id: string; type: string }[]) {
    const body = JSON.stringify({
      survey_count: 0, discoveries: 0, timestamp: ts, item_grants: grants,
    });
    const headers = await makeAuthHeaders(playerId, secret, body);
    const res = await app.fetch(
      new Request("http://localhost/api/bundle", { method: "POST", headers, body }),
      env,
    );
    return res.json() as Promise<any>;
  }

  it("stops minting past 4 grants in a week, even across bundles with fresh ids", async () => {
    const { player_id, secret } = await registerPlayer("GrantFarm");
    const t0 = Math.floor(Date.now() / 1000) - 10;

    // First bundle: 4 fresh-id grants — the per-bundle cap — all mint.
    const first = await push(player_id, secret, t0, [
      { id: "g1", type: "attack_epic" },
      { id: "g2", type: "attack_epic" },
      { id: "g3", type: "defense_epic" },
      { id: "g4", type: "defense_epic" },
    ]);
    expect(first.all_items.filter((i: any) => i.id.startsWith("g")).length).toBe(4);

    // Second bundle, fresh ids: weekly budget is spent, nothing more mints.
    const second = await push(player_id, secret, t0 + 5, [
      { id: "g5", type: "attack_epic" },
      { id: "g6", type: "defense_epic" },
    ]);
    expect(second.all_items.filter((i: any) => ["g5", "g6"].includes(i.id)).length).toBe(0);
  });

  it("a retried (already-held) grant id burns no weekly budget", async () => {
    const { player_id, secret } = await registerPlayer("GrantRetry");
    const t0 = Math.floor(Date.now() / 1000) - 10;

    await push(player_id, secret, t0, [
      { id: "c1", type: "attack_epic" },
      { id: "c2", type: "attack_epic" },
      { id: "c3", type: "attack_epic" },
    ]);
    // Retry c1-c3 plus one genuinely new grant: the retries dedupe without
    // counting, so the new grant still fits under the weekly 4.
    const res = await push(player_id, secret, t0 + 5, [
      { id: "c1", type: "attack_epic" },
      { id: "c2", type: "attack_epic" },
      { id: "c3", type: "attack_epic" },
      { id: "c4", type: "defense_epic" },
    ]);
    expect(res.all_items.filter((i: any) => i.id === "c4").length).toBe(1);
    expect(res.all_items.filter((i: any) => i.id.startsWith("c")).length).toBe(4);
  });
});
