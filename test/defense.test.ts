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

async function addPostSummary(playerId: string, postToken: string, level: number): Promise<void> {
  const raw = await env.PLAYERS.get(`player:${playerId}`, "json") as any;
  raw.post_summaries.push({
    post_token: postToken,
    level,
    chartered_at: Math.floor(Date.now() / 1000) - 86400 * 10,
  });
  await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
}

async function giveItem(playerId: string, type: string): Promise<string> {
  const raw = await env.PLAYERS.get(`player:${playerId}`, "json") as any;
  const itemId = crypto.randomUUID();
  raw.items.push({ id: itemId, type, assigned_at: Date.now(), used: false });
  await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
  return itemId;
}

describe("POST /api/defend/install", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("installs a defense_common item", async () => {
    const { player_id, secret } = await registerPlayer("Defender");
    await addPostSummary(player_id, "post_a", 2);
    const itemId = await giveItem(player_id, "defense_common");

    const body = JSON.stringify({ post_token: "post_a", item_id: itemId });
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/defend/install", { method: "POST", headers, body }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.defense_pct).toBe(0.08);
    expect(data.defense_item).toBe("defense_common");
  });

  it("installs a defense_rare item", async () => {
    const { player_id, secret } = await registerPlayer("RareDefender");
    await addPostSummary(player_id, "post_b", 3);
    const itemId = await giveItem(player_id, "defense_rare");

    const body = JSON.stringify({ post_token: "post_b", item_id: itemId });
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/defend/install", { method: "POST", headers, body }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.defense_pct).toBe(0.25);
  });

  it("replaces existing defense item (single slot)", async () => {
    const { player_id, secret } = await registerPlayer("Replacer");
    await addPostSummary(player_id, "post_c", 2);
    const item1 = await giveItem(player_id, "defense_common");
    const item2 = await giveItem(player_id, "defense_epic");

    // Install first
    const body1 = JSON.stringify({ post_token: "post_c", item_id: item1 });
    const headers1 = await makeAuthHeaders(player_id, secret, body1);
    await app.fetch(
      new Request("http://localhost/api/defend/install", { method: "POST", headers: headers1, body: body1 }),
      env,
    );

    // Install second — should replace
    const body2 = JSON.stringify({ post_token: "post_c", item_id: item2 });
    const headers2 = await makeAuthHeaders(player_id, secret, body2);
    const res = await app.fetch(
      new Request("http://localhost/api/defend/install", { method: "POST", headers: headers2, body: body2 }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.defense_pct).toBe(0.40);
    expect(data.defense_item).toBe("defense_epic");
  });

  it("rejects attack items as defense", async () => {
    const { player_id, secret } = await registerPlayer("WrongType");
    await addPostSummary(player_id, "post_e", 1);
    const itemId = await giveItem(player_id, "attack_common");

    const body = JSON.stringify({ post_token: "post_e", item_id: itemId });
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/defend/install", { method: "POST", headers, body }),
      env,
    );

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("not a defensive");
  });

  it("rejects if post does not belong to player", async () => {
    const { player_id, secret } = await registerPlayer("WrongPost");
    const itemId = await giveItem(player_id, "defense_common");

    const body = JSON.stringify({ post_token: "nonexistent", item_id: itemId });
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/defend/install", { method: "POST", headers, body }),
      env,
    );

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("Post not found");
  });
});

describe("POST /api/defend/restore", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("restores HP with provisions", async () => {
    const { player_id, secret } = await registerPlayer("Restorer");
    await addPostSummary(player_id, "post_r", 2);

    await env.DEFENSE.put(
      `defense:${player_id}:post_r`,
      JSON.stringify({
        base_defense: 10, survey_bonus: 0,
        defense_item: null, defense_value: 0,
        hp: 50, max_hp: 100, hp_updated_at: 0,
      }),
    );

    const body = JSON.stringify({ post_token: "post_r", provisions_spent: 5 });
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/defend/restore", { method: "POST", headers, body }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.new_hp).toBe(75);
    expect(data.max_hp).toBe(100);
  });

  it("caps restoration at max_hp", async () => {
    const { player_id, secret } = await registerPlayer("OverRestore");
    await addPostSummary(player_id, "post_s", 1);

    await env.DEFENSE.put(
      `defense:${player_id}:post_s`,
      JSON.stringify({
        base_defense: 10, survey_bonus: 0,
        defense_item: null, defense_value: 0,
        hp: 45, max_hp: 50, hp_updated_at: 0,
      }),
    );

    const body = JSON.stringify({ post_token: "post_s", provisions_spent: 100 });
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/defend/restore", { method: "POST", headers, body }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.new_hp).toBe(50);
  });

  it("rejects if already at max HP", async () => {
    const { player_id, secret } = await registerPlayer("FullHP");
    await addPostSummary(player_id, "post_t", 1);

    const body = JSON.stringify({ post_token: "post_t", provisions_spent: 5 });
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/defend/restore", { method: "POST", headers, body }),
      env,
    );

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("maximum");
  });
});

describe("GET /api/player/:id/defense", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("returns defense values for own posts", async () => {
    const { player_id, secret } = await registerPlayer("DefViewer");
    await addPostSummary(player_id, "post_v1", 2);
    await addPostSummary(player_id, "post_v2", 3);

    const body = "";
    const headers = await makeAuthHeaders(player_id, secret, body);

    const res = await app.fetch(
      new Request(`http://localhost/api/player/${player_id}/defense`, { headers }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.posts).toHaveLength(2);
    expect(data.posts[0].post_token).toBe("post_v1");
    expect(data.posts[0].hp).toBe(100); // level 2 = 100 HP
    expect(data.posts[0].max_hp).toBe(100);
    expect(data.posts[0].defense_item).toBeNull();
  });

  it("rejects viewing another player's defense", async () => {
    const player1 = await registerPlayer("Player1");
    const player2 = await registerPlayer("Player2");
    await addPostSummary(player2.player_id, "post_x", 1);

    const body = "";
    const headers = await makeAuthHeaders(player1.player_id, player1.secret, body);

    const res = await app.fetch(
      new Request(`http://localhost/api/player/${player2.player_id}/defense`, { headers }),
      env,
    );

    expect(res.status).toBe(403);
  });
});

describe("POST /api/defend/boost (cap)", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  async function boost(playerId: string, secret: string, postToken: string, itemIds: string[]) {
    const body = JSON.stringify({ post_token: postToken, item_ids: itemIds });
    const headers = await makeAuthHeaders(playerId, secret, body);
    return app.fetch(
      new Request("http://localhost/api/defend/boost", { method: "POST", headers, body }),
      env,
    );
  }

  it("caps concurrent live boosts at MAX_ACTIVE_BOOSTS (2)", async () => {
    const { player_id, secret } = await registerPlayer("Booster");
    await addPostSummary(player_id, "post_a", 3);
    const i1 = await giveItem(player_id, "defense_common");
    const i2 = await giveItem(player_id, "defense_common");
    const i3 = await giveItem(player_id, "defense_common");

    // First two land.
    const r1 = await boost(player_id, secret, "post_a", [i1, i2]);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).boosts_active).toBe(2);

    // A third is rejected, and the item is not consumed.
    const r2 = await boost(player_id, secret, "post_a", [i3]);
    expect(r2.status).toBe(400);
    const raw = (await env.PLAYERS.get(`player:${player_id}`, "json")) as any;
    expect(raw.items.find((i: any) => i.id === i3).used).toBe(false);
  });

  it("rejects a single batch that would exceed the cap", async () => {
    const { player_id, secret } = await registerPlayer("BigBatch");
    await addPostSummary(player_id, "post_a", 3);
    const ids = [
      await giveItem(player_id, "defense_common"),
      await giveItem(player_id, "defense_common"),
      await giveItem(player_id, "defense_common"),
    ];
    const r = await boost(player_id, secret, "post_a", ids);
    expect(r.status).toBe(400);
    // None consumed — atomic rejection.
    const raw = (await env.PLAYERS.get(`player:${player_id}`, "json")) as any;
    expect(raw.items.every((i: any) => !i.used)).toBe(true);
  });
});
