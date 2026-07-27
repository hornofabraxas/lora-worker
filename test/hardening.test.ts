import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { computeHmac } from "../src/middleware/auth.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { registerViewer, getLeaderboardAs } from "./helpers/auth.js";

const ADMIN = "test-admin-secret";
let env: Env;

beforeEach(() => {
  env = makeEnv();
  (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = ADMIN;
});

const NOW = () => Math.floor(Date.now() / 1000);

async function registerPlayer(name = "TestPlayer"): Promise<{ player_id: string; secret: string }> {
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

async function authHeaders(playerId: string, secret: string, body: string): Promise<Record<string, string>> {
  const timestamp = String(NOW());
  const signature = await computeHmac(secret, playerId + timestamp + body);
  return {
    "X-Player-ID": playerId,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
    "Content-Type": "application/json",
  };
}

async function pushBundle(
  playerId: string,
  secret: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const body = JSON.stringify({
    survey_count: 1,
    discoveries: 0,
    provisions_earned: 0,
    xp_earned: 0,
    field_notes_earned: 0,
    post_surveys: [],
    coarse_cells: [],
    timestamp: NOW(),
    ...overrides,
  });
  return app.fetch(
    new Request("http://localhost/api/bundle", {
      method: "POST",
      headers: await authHeaders(playerId, secret, body),
      body,
    }),
    env,
  );
}

async function inspect(playerId: string): Promise<any> {
  const res = await app.fetch(
    new Request(`http://localhost/api/admin/player/${playerId}`, {
      headers: { "x-admin-secret": ADMIN },
    }),
    env,
  );
  return (await res.json()).player;
}

describe("bundle write-time invariants", () => {
  it("rejects a bundle timestamp far from server time", async () => {
    const { player_id, secret } = await registerPlayer();
    const res = await pushBundle(player_id, secret, { timestamp: NOW() + 100000 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Timestamp too far/);
  });

  it("rejects discoveries exceeding survey_count", async () => {
    const { player_id, secret } = await registerPlayer();
    const res = await pushBundle(player_id, secret, { survey_count: 2, discoveries: 5 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/discoveries/);
  });

  it("pins post charter age to first-seen (no backdating)", async () => {
    const { player_id, secret } = await registerPlayer();
    const backdated = NOW() - 86400 * 100; // claim 100 days old
    const res = await pushBundle(player_id, secret, {
      post_summaries: [{ post_hex: "88aa01fffffffff", level: 2, chartered_at: backdated, coarse_cell: "" }],
    });
    expect(res.status).toBe(200);
    const player = await inspect(player_id);
    const post = player.post_summaries.find((p: any) => p.post_hex === "88aa01fffffffff");
    // Clamped up to ~now, not the backdated value.
    expect(post.chartered_at).toBeGreaterThan(NOW() - 300);
  });

  it("clamps the stored post count to the hard ceiling", async () => {
    const { player_id, secret } = await registerPlayer();
    const posts = Array.from({ length: 9 }, (_, i) => ({
      post_hex: `88aa0${i}fffffffff`,
      level: 1,
      chartered_at: NOW() - i,
      coarse_cell: "",
    }));
    expect((await pushBundle(player_id, secret, { post_summaries: posts })).status).toBe(200);
    const player = await inspect(player_id);
    expect(player.post_summaries.length).toBe(6);
  });

  it("clamps dormant_until to the ward ceiling", async () => {
    const { player_id, secret } = await registerPlayer();
    const farFuture = NOW() + 86400 * 100;
    await pushBundle(player_id, secret, {
      post_summaries: [{ post_hex: "88aa02fffffffff", level: 1, chartered_at: NOW(), coarse_cell: "", dormant_until: farFuture }],
    });
    const player = await inspect(player_id);
    const post = player.post_summaries.find((p: any) => p.post_hex === "88aa02fffffffff");
    expect(post.dormant_until).toBeLessThanOrEqual(NOW() + 86400 * 31 + 1);
    expect(post.dormant_until).toBeLessThan(farFuture);
  });

  it("ignores a centroid move within the same day", async () => {
    const { player_id, secret } = await registerPlayer();
    await pushBundle(player_id, secret, { timestamp: NOW(), coarse_centroid: { lat: 10, lng: 10 } });
    await pushBundle(player_id, secret, { timestamp: NOW() + 1, coarse_centroid: { lat: 40, lng: 40 } });
    const player = await inspect(player_id);
    expect(player.coarse_centroid).toEqual({ lat: 10, lng: 10 });
  });
});

describe("bundle rate limit (inlined into the route snapshot/commit)", () => {
  it("allows 6 bundles an hour, then 429s the 7th", async () => {
    const { player_id, secret } = await registerPlayer();
    for (let i = 0; i < 6; i++) {
      const res = await pushBundle(player_id, secret, { timestamp: NOW() + i });
      expect(res.status).toBe(200);
    }
    const over = await pushBundle(player_id, secret, { timestamp: NOW() + 6 });
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/Rate limit/);
  });

  it("counts a rejected bundle against the rate limit", async () => {
    // The old middleware incremented before the body ran, so a request that trips
    // a cheap validation error still burned a slot — otherwise a modified client
    // spams the endpoint for free by deliberately failing validation. Now that the
    // increment lives in the commit, an early reject must still flush it.
    const { player_id, secret } = await registerPlayer();
    // 5 valid bundles → 5 slots used.
    for (let i = 0; i < 5; i++) {
      expect((await pushBundle(player_id, secret, { timestamp: NOW() + i })).status).toBe(200);
    }
    // A rejected bundle (survey_count over max) must consume the 6th slot.
    const bad = await pushBundle(player_id, secret, { survey_count: 999, timestamp: NOW() + 5 });
    expect(bad.status).toBe(400);
    // So the next *valid* bundle is the 7th request and is rate-limited. If the
    // reject had NOT counted, this would be the 6th slot and succeed (200).
    const next = await pushBundle(player_id, secret, { timestamp: NOW() + 6 });
    expect(next.status).toBe(429);
  });

  it("does not count an auth failure against the rate limit", async () => {
    // A bad signature is rejected before the rate-limit increment is buffered, so
    // it must not consume a slot (matches auth-before-ratelimit ordering).
    const { player_id, secret } = await registerPlayer();
    const body = JSON.stringify({
      survey_count: 1, discoveries: 0, provisions_earned: 0, xp_earned: 0,
      field_notes_earned: 0, post_surveys: [], coarse_cells: [], timestamp: NOW(),
    });
    for (let i = 0; i < 8; i++) {
      const res = await app.fetch(new Request("http://localhost/api/bundle", {
        method: "POST",
        headers: {
          "X-Player-ID": player_id,
          "X-Timestamp": String(NOW()),
          "X-Signature": "bad_signature_00000000000000000000000000000000000000000000000000",
          "Content-Type": "application/json",
        },
        body,
      }), env);
      expect(res.status).toBe(401);
    }
    // Rate limit untouched: a valid bundle still succeeds.
    expect((await pushBundle(player_id, secret, { timestamp: NOW() })).status).toBe(200);
  });
});

describe("shop purchase cap", () => {
  it("rejects buys past the daily cap", async () => {
    const { player_id, secret } = await registerPlayer();
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) {
      const body = JSON.stringify({ item_type: "probe", purchase_id: `buy_${i}` });
      last = await app.fetch(
        new Request("http://localhost/api/shop/buy", {
          method: "POST",
          headers: await authHeaders(player_id, secret, body),
          body,
        }),
        env,
      );
    }
    expect(last!.status).toBe(429);
    expect((await last!.json()).error).toMatch(/Daily purchase cap/);
  });
});

describe("registration invite gate", () => {
  beforeEach(() => {
    (env as unknown as { REGISTER_SECRET: string }).REGISTER_SECRET = "invite123";
  });

  async function register(body: unknown): Promise<Response> {
    return app.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it("rejects registration without the invite code", async () => {
    const res = await register({ display_name: "X", coarse_cells: ["831a00fffffffff"] });
    expect(res.status).toBe(403);
  });

  it("rejects a wrong invite code", async () => {
    const res = await register({ display_name: "X", coarse_cells: ["831a00fffffffff"], invite_code: "nope" });
    expect(res.status).toBe(403);
  });

  it("accepts the correct invite code", async () => {
    const res = await register({ display_name: "X", coarse_cells: ["831a00fffffffff"], invite_code: "invite123" });
    expect(res.status).toBe(201);
  });
});

describe("freeze / unfreeze", () => {
  async function freeze(id: string, frozen?: boolean): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost/api/admin/freeze/${id}`, {
        method: "POST",
        headers: { "x-admin-secret": ADMIN, "Content-Type": "application/json" },
        body: JSON.stringify(frozen === undefined ? {} : { frozen }),
      }),
      env,
    );
  }

  it("rejects a frozen player's writes and restores on unfreeze", async () => {
    const { player_id, secret } = await registerPlayer();
    expect((await freeze(player_id)).status).toBe(200);

    const blocked = await pushBundle(player_id, secret);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toMatch(/suspended/i);

    expect((await freeze(player_id, false)).status).toBe(200);
    expect((await pushBundle(player_id, secret)).status).toBe(200);
  });

  it("requires the admin secret", async () => {
    const { player_id } = await registerPlayer();
    const res = await app.fetch(
      new Request(`http://localhost/api/admin/freeze/${player_id}`, { method: "POST" }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("admin flags report", () => {
  it("flags players with too many posts and instant-max-level posts", async () => {
    const seed = {
      display_name: "Suspect",
      coarse_cells: ["8329a0fffffffff"],
      posts: [
        // Climbed 1 -> max under our own observation: the real signal.
        { post_hex: "88bb01fffffffff", level: 5, chartered_at: NOW(), first_level: 1 },
        { post_hex: "88bb02fffffffff", level: 1, chartered_at: NOW() - 86400 * 30 },
        { post_hex: "88bb03fffffffff", level: 1, chartered_at: NOW() - 86400 * 30 },
        { post_hex: "88bb04fffffffff", level: 1, chartered_at: NOW() - 86400 * 30 }, // 4 posts > game max 3
      ],
    };
    await app.fetch(
      new Request("http://localhost/api/admin/seed-player", {
        method: "POST",
        headers: { "x-admin-secret": ADMIN, "Content-Type": "application/json" },
        body: JSON.stringify(seed),
      }),
      env,
    );

    const res = await app.fetch(
      new Request("http://localhost/api/admin/flags", { headers: { "x-admin-secret": ADMIN } }),
      env,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    const row = data.flagged.find((r: any) => r.display_name === "Suspect");
    expect(row).toBeDefined();
    expect(row.reasons.some((r: any) => r.code === "posts_over_max")).toBe(true);
    expect(row.reasons.some((r: any) => r.code.startsWith("instant_max_level:"))).toBe(true);
    expect(row.reasons.some((r: any) => /holds 4 posts/.test(r.text))).toBe(true);
  });
});

describe("leaderboard hides distance", () => {
  async function seedPlayer(body: unknown): Promise<string> {
    const res = await app.fetch(
      new Request("http://localhost/api/admin/seed-player", {
        method: "POST",
        headers: { "x-admin-secret": ADMIN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    return (await res.json()).player_id;
  }

  it("never exposes proximity on the leaderboard — it is scout-only now", async () => {
    await seedPlayer({
      display_name: "A", coarse_centroid: { lat: 0, lng: 0 },
      posts: [{ post_hex: "88cc01fffffffff", level: 1 }],
    });
    await seedPlayer({
      display_name: "B", coarse_centroid: { lat: 51.5, lng: -0.1 },
      posts: [{ post_hex: "88cc02fffffffff", level: 1 }],
    });

    const viewer = await registerViewer(env);
    const data = await getLeaderboardAs<any>(env, viewer);
    const b = data.players.find((p: any) => p.display_name === "B");
    expect(b.distance_band).toBeUndefined();
    expect(b.distance_mi).toBeUndefined();
  });
});
