import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { registerViewer, getLeaderboardAs } from "./helpers/auth.js";

const ADMIN = "test-admin-secret";
let env: Env;

beforeEach(() => {
  env = makeEnv();
  (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = ADMIN;
});

function seedReq(body: unknown, secret: string | null = ADMIN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["x-admin-secret"] = secret;
  return new Request("http://localhost/api/admin/seed-player", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const SAMPLE = {
  display_name: "TestPlayer2",
  coarse_cells: ["8329a0fffffffff"],
  coarse_centroid: { lat: 51.5, lng: -0.1 },
  posts: [
    { post_token: "88aaaa0001fffff", level: 2 },
    { post_token: "88aaaa0003fffff", level: 3, defense: { defense_item: "defense_common", defense_value: 10 } },
    { post_token: "88aaaa0005fffff", level: 4, defense: { defense_item: "defense_rare", defense_value: 50 } },
  ],
};

describe("admin seed/inspect/delete", () => {
  it("rejects a missing or wrong admin secret", async () => {
    expect((await app.fetch(seedReq(SAMPLE, null), env)).status).toBe(403);
    expect((await app.fetch(seedReq(SAMPLE, "nope"), env)).status).toBe(403);
  });

  it("seeds a player with posts + per-post defense and lists it on the leaderboard", async () => {
    const res = await app.fetch(seedReq(SAMPLE), env);
    expect(res.status).toBe(201);
    const seeded = await res.json() as { ok: boolean; player_id: string };
    expect(seeded.ok).toBe(true);

    const viewer = await registerViewer(env);
    const lb = await getLeaderboardAs<{
      players: { player_id: string; display_name: string; post_count: number }[];
    }>(env, viewer);
    const row = lb.players.find((p) => p.player_id === seeded.player_id);
    expect(row?.display_name).toBe("TestPlayer2");
    expect(row?.post_count).toBe(3);

    // Defense records materialise with the requested values + level-max HP.
    const dump = await (await app.fetch(
      new Request(`http://localhost/api/admin/player/${seeded.player_id}`, {
        headers: { "x-admin-secret": ADMIN },
      }),
      env,
    )).json() as { defenses: Record<string, { defense_value: number; hp: number; max_hp: number } | null> };
    expect(dump.defenses["88aaaa0001fffff"]?.defense_value).toBe(0);
    expect(dump.defenses["88aaaa0003fffff"]?.defense_value).toBe(10);
    expect(dump.defenses["88aaaa0005fffff"]?.defense_value).toBe(50);
    expect(dump.defenses["88aaaa0005fffff"]?.hp).toBe(275); // POST_MAX_HP[4]
  });

  it("requires overwrite:true to replace an existing id, then removes cleanly", async () => {
    const first = await (await app.fetch(seedReq(SAMPLE), env)).json() as { player_id: string };
    const id = first.player_id;

    // Same id without overwrite → 409.
    const clash = await app.fetch(seedReq({ ...SAMPLE, player_id: id }), env);
    expect(clash.status).toBe(409);

    // With overwrite → 200 and secret preserved.
    const again = await app.fetch(seedReq({ ...SAMPLE, player_id: id, overwrite: true }), env);
    expect(again.status).toBe(200);

    // Delete removes it from the leaderboard.
    const del = await app.fetch(
      new Request(`http://localhost/api/admin/player/${id}`, {
        method: "DELETE",
        headers: { "x-admin-secret": ADMIN },
      }),
      env,
    );
    expect(del.status).toBe(200);
    const viewer = await registerViewer(env);
    const lb = await getLeaderboardAs<{ players: { player_id: string }[] }>(env, viewer);
    expect(lb.players.find((p) => p.player_id === id)).toBeUndefined();
  });
});

describe("admin trim-items (legacy stockpile purge)", () => {
  function trimReq(body: unknown, secret: string | null = ADMIN): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["x-admin-secret"] = secret;
    return new Request("http://localhost/api/admin/trim-items", {
      method: "POST", headers, body: JSON.stringify(body),
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const withItems = {
    display_name: "Hoarder",
    coarse_cells: ["8329a0fffffffff"],
    player_id: "hoarder1",
    posts: [{ post_token: "88aaaa0001fffff", level: 2 }],
    items: [
      // 4 free defense_epic (assigned oldest→newest), 1 used, 1 installed.
      { id: "e0", type: "defense_epic", assigned_at: now - 500, used: false },
      { id: "e1", type: "defense_epic", assigned_at: now - 400, used: false },
      { id: "e2", type: "defense_epic", assigned_at: now - 300, used: false },
      { id: "e3", type: "defense_epic", assigned_at: now - 200, used: false },
      { id: "eu", type: "defense_epic", assigned_at: now - 100, used: true },
      { id: "ei", type: "defense_epic", assigned_at: now - 50, used: false, installed_post_token: "88aaaa0001fffff" },
    ],
  };

  it("dry-runs by default and only removes free items down to the keep count", async () => {
    await app.fetch(seedReq(withItems), env);

    // Dry run: reports what it would remove, changes nothing.
    const dry = await (await app.fetch(trimReq({ player_id: "hoarder1", keep: { defense_epic: 1 } }), env)).json() as any;
    expect(dry.applied).toBe(false);
    expect(dry.summary.defense_epic).toEqual({ before: 4, kept: 1, removed: 3 });
    expect(dry.removed_ids.sort()).toEqual(["e1", "e2", "e3"]); // keeps oldest e0
    const stillThere = (await env.PLAYERS.get(`player:hoarder1`, "json")) as any;
    expect(stillThere.items).toHaveLength(6);

    // Apply: removes the 3, leaves used + installed + the one kept.
    const applied = await (await app.fetch(trimReq({ player_id: "hoarder1", keep: { defense_epic: 1 }, apply: true }), env)).json() as any;
    expect(applied.applied).toBe(true);
    expect(applied.removed_count).toBe(3);
    const raw = (await env.PLAYERS.get(`player:hoarder1`, "json")) as any;
    const ids = raw.items.map((i: any) => i.id).sort();
    expect(ids).toEqual(["e0", "ei", "eu"]); // oldest free + installed + used survive
  });

  it("rejects without the admin secret", async () => {
    expect((await app.fetch(trimReq({ player_id: "x", keep: {} }, null), env)).status).toBe(403);
  });
});
