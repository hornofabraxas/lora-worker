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
      body: JSON.stringify({ display_name: name }),
    }),
    env,
  );
  return res.json();
}

// The leaderboard requires player auth now (it was the last public read). A GET
// signs the empty body, same as the game server's client does.
async function fetchLeaderboard(playerId: string, secret: string): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await computeHmac(secret, playerId + timestamp + "");
  return app.fetch(
    new Request("http://localhost/api/leaderboard", {
      headers: {
        "X-Player-ID": playerId,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
    }),
    env,
  );
}

async function pushBundle(playerId: string, secret: string, surveyCount: number, activeTitle?: string) {
  const bundleBody = JSON.stringify({
    survey_count: surveyCount,
    discoveries: 0,
    ...(activeTitle !== undefined ? { active_title: activeTitle } : {}),
    timestamp: Math.floor(Date.now() / 1000),
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = playerId + timestamp + bundleBody;
  const signature = await computeHmac(secret, message);
  await app.fetch(
    new Request("http://localhost/api/bundle", {
      method: "POST",
      headers: {
        "X-Player-ID": playerId,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
        "Content-Type": "application/json",
      },
      body: bundleBody,
    }),
    env,
  );
}

describe("GET /api/leaderboard", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.fetch(new Request("http://localhost/api/leaderboard"), env);
    expect(res.status).toBe(401);
  });

  it("returns registered players", async () => {
    const alice = await registerPlayer("Alice");
    await registerPlayer("Bob");

    const res = await fetchLeaderboard(alice.player_id, alice.secret);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.players.length).toBe(2);
    expect(data.players.map((p: any) => p.display_name).sort()).toEqual(["Alice", "Bob"]);
  });

  it("includes post_count and total_renown", async () => {
    const charlie = await registerPlayer("Charlie");

    const res = await fetchLeaderboard(charlie.player_id, charlie.secret);
    const data = await res.json() as any;
    expect(data.players[0].post_count).toBe(0);
    expect(data.players[0].total_renown).toBe(0);
  });

  it("active_title defaults to null before any bundle sets one", async () => {
    const erin = await registerPlayer("Erin");

    const res = await fetchLeaderboard(erin.player_id, erin.secret);
    const data = await res.json() as any;
    expect(data.players[0].active_title).toBeNull();
  });

  it("echoes the active_title pushed in a bundle", async () => {
    const { player_id, secret } = await registerPlayer("Fiona");
    await pushBundle(player_id, secret, 0, "Warlord");

    const res = await fetchLeaderboard(player_id, secret);
    const data = await res.json() as any;
    const fiona = data.players.find((p: any) => p.display_name === "Fiona");
    expect(fiona.active_title).toBe("Warlord");
  });

  it("stores only registry titles — free text is dropped", async () => {
    const { player_id, secret } = await registerPlayer("Mallory");
    await pushBundle(player_id, secret, 0, "Visit evil.example for free marks");

    const res = await fetchLeaderboard(player_id, secret);
    const data = await res.json() as any;
    const mallory = data.players.find((p: any) => p.display_name === "Mallory");
    expect(mallory.active_title).toBeFalsy();
  });
});

describe("removed federation-era reads", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("GET /api/player/:id/public is gone", async () => {
    const { player_id } = await registerPlayer("Dave");
    const res = await app.fetch(
      new Request(`http://localhost/api/player/${player_id}/public`),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/ledger/since is gone", async () => {
    const res = await app.fetch(new Request("http://localhost/api/ledger/since?t=0"), env);
    expect(res.status).toBe(404);
  });
});
