import app from "../../src/index.js";
import { computeHmac } from "../../src/middleware/auth.js";
import type { Env } from "../../src/types.js";

export interface Creds {
  player_id: string;
  secret: string;
}

/** Register a throwaway player to authenticate reads with (the leaderboard
 *  requires player auth now). Adds a row to the roster — assert by id, not by
 *  exact roster contents, in tests that use one. */
export async function registerViewer(env: Env, name = "Viewer"): Promise<Creds> {
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

/** Signed GET /api/leaderboard as the given player; returns the parsed body. */
export async function getLeaderboardAs<T = unknown>(env: Env, creds: Creds): Promise<T> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await computeHmac(creds.secret, creds.player_id + timestamp + "");
  const res = await app.fetch(
    new Request("http://localhost/api/leaderboard", {
      headers: {
        "X-Player-ID": creds.player_id,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
    }),
    env,
  );
  return res.json() as Promise<T>;
}
