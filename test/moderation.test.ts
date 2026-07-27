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

function adminReq(path: string, method: string, body?: unknown, secret: string | null = ADMIN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["x-admin-secret"] = secret;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedPlayer(displayName: string, postHex = "88aaaa0001fffff"): Promise<string> {
  const res = await app.fetch(adminReq("/api/admin/seed-player", "POST", {
    display_name: displayName,
    coarse_cells: ["8329a0fffffffff"],
    coarse_centroid: { lat: 51.5, lng: -0.1 },
    posts: [{ post_hex: postHex, level: 3 }],
  }), env);
  const seeded = await res.json() as { player_id: string };
  return seeded.player_id;
}

async function leaderboardRow(id: string) {
  const viewer = await registerViewer(env);
  const lb = await getLeaderboardAs<{
    players: { player_id: string; display_name: string; posts: { post_hex: string; name: string }[] }[];
  }>(env, viewer);
  return lb.players.find((p) => p.player_id === id);
}

describe("name moderation", () => {
  it("guards the moderation endpoints behind the admin secret", async () => {
    expect((await app.fetch(adminReq("/api/admin/names", "GET", undefined, null), env)).status).toBe(403);
    expect((await app.fetch(adminReq("/api/admin/censor", "POST", { type: "player", player_id: "x" }, "nope"), env)).status).toBe(403);
  });

  it("censors a player display name with a replacement and clears it", async () => {
    const id = await seedPlayer("BadName");

    // Replacement label wins on the public leaderboard.
    await app.fetch(adminReq("/api/admin/censor", "POST", {
      type: "player", player_id: id, replacement: "Explorer",
    }), env);
    expect((await leaderboardRow(id))?.display_name).toBe("Explorer");

    // Clearing restores the original name.
    await app.fetch(adminReq(`/api/admin/censor?type=player&player_id=${id}`, "DELETE"), env);
    expect((await leaderboardRow(id))?.display_name).toBe("BadName");
  });

  it("empty replacement falls back to a neutral label", async () => {
    const id = await seedPlayer("StillBad");
    await app.fetch(adminReq("/api/admin/censor", "POST", { type: "player", player_id: id }), env);
    expect((await leaderboardRow(id))?.display_name).toBe("Surveyor");
  });

  it("censors a post name (with fallback) on the leaderboard", async () => {
    const hex = "88aaaa0007fffff";
    const id = await seedPlayer("CleanName", hex);
    await app.fetch(adminReq("/api/admin/censor", "POST", {
      type: "post", player_id: id, post_hex: hex,
    }), env);
    const row = await leaderboardRow(id);
    expect(row?.posts.find((p) => p.post_hex === hex)?.name).toBe("Outpost");
  });

  it("requires post_hex when censoring a post", async () => {
    const id = await seedPlayer("NoHex");
    const res = await app.fetch(adminReq("/api/admin/censor", "POST", { type: "post", player_id: id }), env);
    expect(res.status).toBe(400);
  });

  it("lists names with their active overrides via GET /api/admin/names", async () => {
    const id = await seedPlayer("Listed");
    await app.fetch(adminReq("/api/admin/censor", "POST", {
      type: "player", player_id: id, replacement: "Renamed",
    }), env);
    const dump = await (await app.fetch(adminReq("/api/admin/names", "GET"), env)).json() as {
      players: { player_id: string; display_name: string; display_name_public: string; player_override: string | null }[];
    };
    const entry = dump.players.find((p) => p.player_id === id);
    expect(entry?.display_name).toBe("Listed");
    expect(entry?.display_name_public).toBe("Renamed");
    expect(entry?.player_override).toBe("Renamed");
  });
});
