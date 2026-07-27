import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { computeHmac } from "../src/middleware/auth.js";

// The flags report's two jobs: don't cry wolf at players who simply arrived
// established, and let the operator retire a finding they've looked at without
// going blind to the next one.

const ADMIN = "test-admin-secret";
let env: Env;

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  env = makeEnv();
  (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = ADMIN;
});

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost/api/admin${path}`, {
    ...init,
    headers: { "x-admin-secret": ADMIN, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function seed(body: unknown): Promise<string> {
  const res = await app.fetch(req("/seed-player", { method: "POST", body: JSON.stringify(body) }), env);
  return (await res.json() as { player_id: string }).player_id;
}

async function flags(query = ""): Promise<any> {
  const res = await app.fetch(req(`/flags${query}`), env);
  return await res.json();
}

describe("instant-max-level flag only counts growth we witnessed", () => {
  it("does not flag a new registrant whose posts arrived already at max", async () => {
    // The exact shape of a real join: first-seen is registration, so charter age
    // is zero, and every post is already max level.
    await seed({
      display_name: "Veteran",
      coarse_cells: ["8329a0fffffffff"],
      posts: [
        { post_token: "88cc01fffffffff", level: 5, chartered_at: NOW() },
        { post_token: "88cc02fffffffff", level: 5, chartered_at: NOW() },
      ],
    });
    const data = await flags();
    expect(data.flagged.find((r: any) => r.display_name === "Veteran")).toBeUndefined();
  });

  it("does flag a post that climbed to max under observation", async () => {
    await seed({
      display_name: "Climber",
      coarse_cells: ["8329a0fffffffff"],
      posts: [{ post_token: "88cc03fffffffff", level: 5, chartered_at: NOW(), first_level: 1 }],
    });
    const row = (await flags()).flagged.find((r: any) => r.display_name === "Climber");
    expect(row).toBeDefined();
    expect(row.reasons[0].code).toBe("instant_max_level:88cc03fffffffff");
    expect(row.reasons[0].text).toMatch(/climbed from level 1 to max/);
  });

  it("does not flag a slow climb to max", async () => {
    await seed({
      display_name: "Grinder",
      coarse_cells: ["8329a0fffffffff"],
      posts: [{
        post_token: "88cc04fffffffff",
        level: 5,
        chartered_at: NOW() - 86400 * 40,
        first_seen: NOW() - 86400 * 40,
        first_level: 1,
      }],
    });
    expect((await flags()).flagged.find((r: any) => r.display_name === "Grinder")).toBeUndefined();
  });
});

describe("dismissing a finding", () => {
  async function seedNoisy(name: string): Promise<string> {
    return await seed({
      display_name: name,
      coarse_cells: ["8329a0fffffffff"],
      posts: [
        { post_token: "88dd01fffffffff", level: 1 },
        { post_token: "88dd02fffffffff", level: 1 },
        { post_token: "88dd03fffffffff", level: 1 },
        { post_token: "88dd04fffffffff", level: 1 }, // 4 posts > game max 3
      ],
    });
  }

  it("hides a dismissed row, and surfaces it again on request", async () => {
    const id = await seedNoisy("Noisy");
    expect((await flags()).flagged).toHaveLength(1);

    const res = await app.fetch(req(`/flags/dismiss/${id}`, { method: "POST" }), env);
    expect(res.status).toBe(200);

    const after = await flags();
    expect(after.flagged).toHaveLength(0);
    expect(after.dismissed).toBe(1);

    const shown = await flags("?include_dismissed=1");
    expect(shown.flagged).toHaveLength(1);
    expect(shown.flagged[0].dismissed).toBe(true);
    expect(shown.flagged[0].dismissed_at).toBeGreaterThan(0);
  });

  it("resurfaces the row when a NEW kind of finding appears", async () => {
    const id = await seedNoisy("Noisy2");
    await app.fetch(req(`/flags/dismiss/${id}`, { method: "POST" }), env);
    expect((await flags()).flagged).toHaveLength(0);

    // Same player picks up a second, unrelated finding: a post that climbed to
    // max under observation. Dismissing "too many posts" must not have muted it.
    await seed({
      player_id: id,
      display_name: "Noisy2",
      overwrite: true,
      coarse_cells: ["8329a0fffffffff"],
      posts: [
        { post_token: "88dd01fffffffff", level: 1 },
        { post_token: "88dd02fffffffff", level: 1 },
        { post_token: "88dd03fffffffff", level: 1 },
        { post_token: "88dd04fffffffff", level: 5, chartered_at: NOW(), first_level: 1 },
      ],
    });

    const after = await flags();
    expect(after.flagged).toHaveLength(1);
    expect(after.flagged[0].reasons.some((r: any) => r.code.startsWith("instant_max_level:"))).toBe(true);
  });

  it("stays dismissed when only the numbers in the text drift", async () => {
    // The row's text carries live values; dismissal is keyed on codes, so a
    // changing count must not resurrect a row the operator already cleared.
    const id = await seedNoisy("Noisy3");
    await app.fetch(req(`/flags/dismiss/${id}`, { method: "POST" }), env);
    await seed({
      player_id: id,
      display_name: "Noisy3",
      overwrite: true,
      coarse_cells: ["8329a0fffffffff"],
      posts: [
        { post_token: "88dd01fffffffff", level: 1 },
        { post_token: "88dd02fffffffff", level: 1 },
        { post_token: "88dd03fffffffff", level: 1 },
        { post_token: "88dd04fffffffff", level: 1 },
        { post_token: "88dd05fffffffff", level: 1 }, // now 5 posts, same finding
      ],
    });
    expect((await flags()).flagged).toHaveLength(0);
  });

  it("clears a dismissal on request", async () => {
    const id = await seedNoisy("Noisy4");
    await app.fetch(req(`/flags/dismiss/${id}`, { method: "POST" }), env);
    expect((await flags()).flagged).toHaveLength(0);

    const res = await app.fetch(req(`/flags/dismiss/${id}`, { method: "DELETE" }), env);
    expect(res.status).toBe(200);
    expect((await flags()).flagged).toHaveLength(1);
  });

  it("refuses to dismiss a player with nothing to dismiss", async () => {
    const id = await seed({
      display_name: "Clean",
      coarse_cells: ["8329a0fffffffff"],
      posts: [{ post_token: "88ee01fffffffff", level: 2 }],
    });
    const res = await app.fetch(req(`/flags/dismiss/${id}`, { method: "POST" }), env);
    expect(res.status).toBe(400);
    expect((await app.fetch(req("/flags/dismiss/nope-not-a-player", { method: "POST" }), env)).status).toBe(404);
  });
});

describe("a frozen account does not accumulate audit rejects", () => {
  it("keeps the suspension from manufacturing a second flag", async () => {
    const res = await app.fetch(req("/seed-player", {
      method: "POST",
      body: JSON.stringify({
        display_name: "Suspended",
        coarse_cells: ["8329a0fffffffff"],
        posts: [{ post_token: "88ff01fffffffff", level: 2 }],
      }),
    }), env);
    const { player_id, secret } = await res.json() as { player_id: string; secret: string };

    await app.fetch(req(`/freeze/${player_id}`, { method: "POST", body: JSON.stringify({ frozen: true }) }), env);

    // A frozen player's client keeps syncing on its normal interval. Well past
    // the flag threshold of 20, none of it should count against them: the
    // signature is valid, the block is the operator's own decision.
    const body = JSON.stringify({
      survey_count: 1, discoveries: 0, field_notes_earned: 0,
      post_surveys: [], coarse_cells: [], timestamp: NOW(),
    });
    for (let i = 0; i < 25; i++) {
      const ts = String(NOW());
      const sig = await computeHmac(secret, player_id + ts + body);
      const push = await app.fetch(new Request("http://localhost/api/bundle", {
        method: "POST",
        headers: { "X-Player-ID": player_id, "X-Timestamp": ts, "X-Signature": sig, "Content-Type": "application/json" },
        body,
      }), env);
      expect(push.status).toBe(403);
    }

    const row = (await flags("?include_dismissed=1")).flagged.find((r: any) => r.player_id === player_id);
    expect(row?.reasons.some((r: any) => r.code === "audit_rejects")).not.toBe(true);
  });
});

describe("player search", () => {
  beforeEach(async () => {
    await seed({ player_id: "abc123", display_name: "Bramblewick Ranger", coarse_cells: ["8329a0fffffffff"], posts: [] });
    await seed({ player_id: "def456", display_name: "bramblewick scout", coarse_cells: ["8329a0fffffffff"], posts: [] });
    await seed({ player_id: "999aaa", display_name: "Someone Else", coarse_cells: ["8329a0fffffffff"], posts: [] });
  });

  async function search(q: string): Promise<any> {
    return await (await app.fetch(req(`/players/search?q=${encodeURIComponent(q)}`), env)).json();
  }

  it("finds by exact player id", async () => {
    const d = await search("abc123");
    expect(d.matches[0].player_id).toBe("abc123");
    expect(d.matches[0].exact).toBe(true);
  });

  it("finds by display name, case-insensitively, returning every candidate", async () => {
    const d = await search("BRAMBLEWICK");
    expect(d.matches).toHaveLength(2);
    expect(d.matches.map((m: any) => m.player_id).sort()).toEqual(["abc123", "def456"]);
  });

  it("finds by partial name", async () => {
    expect((await search("scout")).matches[0].player_id).toBe("def456");
  });

  it("returns nothing for a miss, and rejects an empty query", async () => {
    expect((await search("nobodyhere")).matches).toHaveLength(0);
    expect((await app.fetch(req("/players/search?q="), env)).status).toBe(400);
  });
});
