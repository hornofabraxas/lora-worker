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

async function giveProbe(playerId: string): Promise<string> {
  const raw = await env.PLAYERS.get(`player:${playerId}`, "json") as any;
  const probeId = crypto.randomUUID();
  raw.items.push({ id: probeId, type: "probe", assigned_at: Date.now(), used: false });
  await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
  return probeId;
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

describe("POST /api/scout", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("consumes a probe and returns target intel", async () => {
    const scouter = await registerPlayer("Scouter");
    const target = await registerPlayer("Target");

    await addPostSummary(target.player_id, "abc123", 3);
    const probeId = await giveProbe(scouter.player_id);

    const body = JSON.stringify({
      target_player_id: target.player_id,
      probe_item_id: probeId,
    });
    const headers = await makeAuthHeaders(scouter.player_id, scouter.secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/scout", {
        method: "POST",
        headers,
        body,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.post_level).toBe(3);
    expect(data.post_count).toBe(1);
    expect(typeof data.post_age_days).toBe("number");
    expect(typeof data.scout_id).toBe("string");
  });

  it("marks the probe as used", async () => {
    const scouter = await registerPlayer("Scouter2");
    const target = await registerPlayer("Target2");

    await addPostSummary(target.player_id, "def456", 2);
    const probeId = await giveProbe(scouter.player_id);

    const body = JSON.stringify({
      target_player_id: target.player_id,
      probe_item_id: probeId,
    });
    const headers = await makeAuthHeaders(scouter.player_id, scouter.secret, body);

    await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers, body }),
      env,
    );

    const player = await env.PLAYERS.get(`player:${scouter.player_id}`, "json") as any;
    const probe = player.items.find((i: any) => i.id === probeId);
    expect(probe.used).toBe(true);
  });

  it("queues a notification for the target", async () => {
    const scouter = await registerPlayer("Scouter3");
    const target = await registerPlayer("Target3");

    await addPostSummary(target.player_id, "ghi789", 1);
    const probeId = await giveProbe(scouter.player_id);

    const body = JSON.stringify({
      target_player_id: target.player_id,
      probe_item_id: probeId,
    });
    const headers = await makeAuthHeaders(scouter.player_id, scouter.secret, body);

    await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers, body }),
      env,
    );

    const notifs = await env.SCOUTS.get(`notifications:${target.player_id}`, "json") as any;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe("scouted");
  });

  it("rejects scouting yourself", async () => {
    const player = await registerPlayer("SelfScouter");
    await addPostSummary(player.player_id, "xyz000", 1);
    const probeId = await giveProbe(player.player_id);

    const body = JSON.stringify({
      target_player_id: player.player_id,
      probe_item_id: probeId,
    });
    const headers = await makeAuthHeaders(player.player_id, player.secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers, body }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects if probe is already used", async () => {
    const scouter = await registerPlayer("Scouter4");
    const target = await registerPlayer("Target4");

    await addPostSummary(target.player_id, "jkl012", 2);
    const probeId = await giveProbe(scouter.player_id);

    const body = JSON.stringify({
      target_player_id: target.player_id,
      probe_item_id: probeId,
    });
    const headers1 = await makeAuthHeaders(scouter.player_id, scouter.secret, body);
    await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers: headers1, body }),
      env,
    );

    const headers2 = await makeAuthHeaders(scouter.player_id, scouter.secret, body);
    const res = await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers: headers2, body }),
      env,
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("already used");
  });

  it("rejects if target has no posts", async () => {
    const scouter = await registerPlayer("Scouter5");
    const target = await registerPlayer("Target5");
    const probeId = await giveProbe(scouter.player_id);

    const body = JSON.stringify({
      target_player_id: target.player_id,
      probe_item_id: probeId,
    });
    const headers = await makeAuthHeaders(scouter.player_id, scouter.secret, body);

    const res = await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers, body }),
      env,
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("no posts");
  });

  async function setCentroid(playerId: string, lat: number, lng: number): Promise<void> {
    const raw = await env.PLAYERS.get(`player:${playerId}`, "json") as any;
    raw.coarse_centroid = { lat, lng };
    await env.PLAYERS.put(`player:${playerId}`, JSON.stringify(raw));
  }

  it("reveals a fuzzed distance (nearest 50mi) when both centroids are known", async () => {
    const scouter = await registerPlayer("ScouterD");
    const target = await registerPlayer("TargetD");
    await addPostSummary(target.player_id, "dist01", 2);
    await setCentroid(scouter.player_id, 0, 0);
    await setCentroid(target.player_id, 51.5, -0.1); // ~3600mi from (0,0)
    const probeId = await giveProbe(scouter.player_id);

    const body = JSON.stringify({ target_player_id: target.player_id, probe_item_id: probeId });
    const headers = await makeAuthHeaders(scouter.player_id, scouter.secret, body);
    const res = await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers, body }),
      env,
    );
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(typeof data.distance_mi).toBe("number");
    expect(data.distance_mi % 50).toBe(0);
    expect(data.distance_mi).toBeGreaterThan(3000);
  });

  it("returns null distance when a centroid is unknown", async () => {
    const scouter = await registerPlayer("ScouterN");
    const target = await registerPlayer("TargetN");
    await addPostSummary(target.player_id, "dist02", 1);
    await setCentroid(scouter.player_id, 0, 0); // target has no centroid
    const probeId = await giveProbe(scouter.player_id);

    const body = JSON.stringify({ target_player_id: target.player_id, probe_item_id: probeId });
    const headers = await makeAuthHeaders(scouter.player_id, scouter.secret, body);
    const res = await app.fetch(
      new Request("http://localhost/api/scout", { method: "POST", headers, body }),
      env,
    );
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.distance_mi).toBeNull();
  });
});
