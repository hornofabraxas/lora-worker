import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import type { Env, PlayerProfile } from "../src/types.js";
import { makeCountingEnv } from "./helpers/env.js";
import { putPlayer, getPlayerIndex, bumpAuditReject } from "../src/kv/queries.js";
import { setLastBundleTime } from "../src/kv/queries.js";
import { PLAYER_INDEX_KEY, LEADERBOARD_CACHE_KEY } from "../src/kv/schema.js";

// The admin reports used to issue a storage read per player. Cloudflare caps a
// request at 50 subrequests on the free plan, so that isn't a slow report at a
// few hundred players — it's a broken one. These tests pin the two properties
// that keep it working: the read cost is FLAT in roster size, and the response
// is bounded so a phone can render it.

const ADMIN = "test-admin-secret";
const ROSTER = 120;          // comfortably past the 50-subrequest ceiling
const REPORT_LIMIT = 50;     // must match admin.ts

let env: Env;
let rpcs: () => number;
let resetCount: () => void;

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  const counting = makeCountingEnv();
  env = counting.env;
  rpcs = counting.rpcs;
  resetCount = counting.resetCount;
  (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = ADMIN;
});

function req(path: string): Request {
  return new Request(`http://localhost/api/admin${path}`, {
    headers: { "x-admin-secret": ADMIN, "Content-Type": "application/json" },
  });
}

async function get(path: string): Promise<any> {
  return await (await app.fetch(req(path), env)).json();
}

function pid(i: number): string {
  return i.toString(16).padStart(32, "0");
}

/**
 * Write a roster straight to storage. `flagged` posts carry a first_level below
 * max, which is what makes the instant-max-level finding fire (growth the Worker
 * actually witnessed), so each such player produces exactly one reason.
 */
async function seedRoster(count: number, opts: { flagged?: boolean } = {}): Promise<void> {
  const now = NOW();
  const players: PlayerProfile[] = Array.from({ length: count }, (_, i) => {
    const hex = `88cc${i.toString(16).padStart(2, "0")}fffffffff`;
    return {
      player_id: pid(i),
      display_name: `Player${String(i).padStart(3, "0")}`,
      registered_at: now,
      coarse_cells: ["8329a0fffffffff"],
      items: [],
      post_summaries: [{ post_hex: hex, level: 5, chartered_at: now, coarse_cell: "", name: `Post${i}` }],
      secret_hash: "x".repeat(64),
      post_first_seen: { [hex]: now },
      post_first_level: { [hex]: opts.flagged ? 1 : 5 },
    } as PlayerProfile;
  });

  // Player profiles live under independent keys, so write them concurrently —
  // 120 sequential round-trips is what made this seed flirt with the 5s test
  // timeout on a loaded CI runner. The player index is a single read-modify-write
  // key, so it can't be raced across players; collapse it into one write after
  // the profiles land (mirroring addToPlayerIndex, including the leaderboard
  // cache invalidation a roster change triggers).
  await Promise.all(players.map((p) => putPlayer(env, p)));
  const index = await getPlayerIndex(env);
  const ids = new Set(index);
  for (const p of players) ids.add(p.player_id);
  await env.META.put(PLAYER_INDEX_KEY, JSON.stringify([...ids]));
  await env.META.delete(LEADERBOARD_CACHE_KEY);
}

describe("read cost is flat in roster size", () => {
  it("computes the flags report in a single storage round trip", async () => {
    await seedRoster(ROSTER, { flagged: true });
    resetCount();

    const data = await get("/flags");

    expect(data.ok).toBe(true);
    expect(data.checked).toBe(ROSTER);
    // One composite read covers acks + every profile + the audit counters.
    expect(rpcs()).toBe(1);
  });

  it("searches by name in a single round trip", async () => {
    await seedRoster(ROSTER);
    resetCount();

    const data = await get("/players/search?q=player007");

    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].display_name).toBe("Player007");
    expect(rpcs()).toBe(1);
  });

  it("reads one key — not the roster — when given a full player id", async () => {
    await seedRoster(ROSTER);
    resetCount();

    const data = await get(`/players/search?q=${pid(7)}`);

    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].player_id).toBe(pid(7));
    expect(data.matches[0].exact).toBe(true);
    expect(rpcs()).toBe(1);
  });

  it("lists names in a single round trip", async () => {
    await seedRoster(ROSTER);
    resetCount();

    const data = await get("/names");

    expect(data.ok).toBe(true);
    expect(rpcs()).toBe(1);
  });

  it("stays under the free-plan subrequest ceiling for every report", async () => {
    await seedRoster(ROSTER, { flagged: true });
    for (const path of ["/flags", "/names", "/players/search?q=player"]) {
      resetCount();
      await get(path);
      expect(rpcs()).toBeLessThan(50);
    }
  });
});

describe("responses are bounded", () => {
  it("caps the flags report and reports what it withheld", async () => {
    await seedRoster(ROSTER, { flagged: true });

    const data = await get("/flags");

    expect(data.flagged).toHaveLength(REPORT_LIMIT);
    expect(data.total).toBe(ROSTER);
    expect(data.truncated).toBe(true);
    expect(data.checked).toBe(ROSTER);
  });

  it("caps search results and reports the true match count", async () => {
    await seedRoster(ROSTER);

    const data = await get("/players/search?q=player");

    expect(data.matches).toHaveLength(REPORT_LIMIT);
    expect(data.total).toBe(ROSTER);
    expect(data.truncated).toBe(true);
  });

  it("caps the names report", async () => {
    await seedRoster(ROSTER);

    const data = await get("/names");

    // Each player contributes a player row + one post row.
    expect(data.shown).toBeLessThanOrEqual(REPORT_LIMIT + 1);
    expect(data.total).toBe(ROSTER * 2);
    expect(data.truncated).toBe(true);
  });

  it("never splits a player's card across the cap", async () => {
    await seedRoster(ROSTER);

    const data = await get("/names");

    // A card with posts but no player row would mean the cap cut mid-player.
    for (const p of data.players) {
      expect(p.include_player || p.posts.length > 0).toBe(true);
    }
  });
});

describe("names filtering happens on the server", () => {
  it("filters by query across player and post names", async () => {
    await seedRoster(20);

    const data = await get("/names?q=player007");

    expect(data.players).toHaveLength(1);
    expect(data.players[0].display_name).toBe("Player007");
    expect(data.players[0].include_player).toBe(true);
    expect(data.players[0].posts).toHaveLength(0);
    expect(data.truncated).toBe(false);
  });

  it("matches a post by its hex", async () => {
    await seedRoster(20);

    const data = await get("/names?q=88cc05fffffffff");

    expect(data.players).toHaveLength(1);
    expect(data.players[0].include_player).toBe(false);
    expect(data.players[0].posts[0].post_hex).toBe("88cc05fffffffff");
  });

  it("narrows to players or posts by type", async () => {
    await seedRoster(20);

    const players = await get("/names?type=player");
    expect(players.total).toBe(20);
    for (const p of players.players) expect(p.posts).toHaveLength(0);

    const posts = await get("/names?type=post");
    expect(posts.total).toBe(20);
    for (const p of posts.players) expect(p.include_player).toBe(false);
  });
});

describe("roster scan reads profiles, not the keys that share their prefix", () => {
  it("ignores last_bundle markers", async () => {
    await seedRoster(5);
    // Every active player has one of these under `player:<id>:last_bundle`.
    for (let i = 0; i < 5; i++) await setLastBundleTime(env, pid(i), NOW());

    const flags = await get("/flags");
    expect(flags.checked).toBe(5);

    const names = await get("/names");
    expect(names.players).toHaveLength(5);
    expect(names.total).toBe(10);
  });
});

describe("audit rejects still reach the report", () => {
  it("attaches counters from the sparse prefix scan to the right player", async () => {
    await seedRoster(5);
    for (let i = 0; i < 25; i++) await bumpAuditReject(env, pid(3));

    const data = await get("/flags");
    const row = data.flagged.find((r: any) => r.player_id === pid(3));

    expect(row).toBeDefined();
    expect(row.audit_rejects).toBe(25);
    expect(row.reasons.some((r: any) => r.code === "audit_rejects")).toBe(true);
    // Nobody else picks up a counter they didn't earn.
    expect(data.flagged.filter((r: any) => r.audit_rejects > 0)).toHaveLength(1);
  });
});
