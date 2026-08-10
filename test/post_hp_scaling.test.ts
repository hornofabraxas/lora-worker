import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { computeHmac } from "../src/middleware/auth.js";
import { defenseKey, notificationsKey } from "../src/kv/schema.js";
import type { Env, DefenseValues } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";

// POST_MAX_HP: {1:50, 2:100, 3:175, 4:275, 5:400}

let env: Env;

beforeEach(() => {
  env = makeEnv();
});

async function registerPlayer(name = "P"): Promise<{ player_id: string; secret: string }> {
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

/** Seed a defense row at an arbitrary HP pool — mimics a row that materialized
 *  at a low level and was never rewritten upward when the post was upgraded. */
async function seedDefense(pid: string, token: string, maxHp: number, hp: number): Promise<void> {
  const row: DefenseValues = {
    base_defense: 10, survey_bonus: 0, defense_item: null, defense_value: 0,
    hp, max_hp: maxHp, hp_updated_at: Math.floor(Date.now() / 1000),
  };
  await env.DEFENSE.put(defenseKey(pid, token), JSON.stringify(row));
}

async function getDefense(pid: string, token: string): Promise<DefenseValues> {
  return (await env.DEFENSE.get(defenseKey(pid, token), "json")) as DefenseValues;
}

async function sendBundle(
  pid: string, secret: string, postLevel: number, token = "post_a",
): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    survey_count: 0,
    discoveries: 0,
    timestamp: ts,
    post_summaries: [{ post_token: token, level: postLevel, chartered_at: ts - 86400 }],
  });
  const timestamp = String(ts);
  const signature = await computeHmac(secret, pid + timestamp + body);
  return app.fetch(
    new Request("http://localhost/api/bundle", {
      method: "POST",
      headers: {
        "X-Player-ID": pid, "X-Timestamp": timestamp, "X-Signature": signature,
        "Content-Type": "application/json",
      },
      body,
    }),
    env,
  );
}

describe("post HP reconciles up to level on bundle", () => {
  it("raises an under-levelled defense row's pool to match the post level", async () => {
    const { player_id, secret } = await registerPlayer();
    await seedDefense(player_id, "post_a", 50, 50); // stuck at L1 HP
    const res = await sendBundle(player_id, secret, 5); // post is actually L5
    expect(res.status).toBe(200);
    const def = await getDefense(player_id, "post_a");
    expect(def.max_hp).toBe(400);
    expect(def.hp).toBe(400);
  });

  it("preserves battle damage — adds the delta, keeps the missing HP", async () => {
    const { player_id, secret } = await registerPlayer();
    await seedDefense(player_id, "post_a", 100, 60); // L2 pool, 40 damage taken
    await sendBundle(player_id, secret, 5);
    const def = await getDefense(player_id, "post_a");
    expect(def.max_hp).toBe(400);
    expect(def.hp).toBe(360); // still 40 short of full
  });

  it("is a no-op when the pool already matches the level", async () => {
    const { player_id, secret } = await registerPlayer();
    await seedDefense(player_id, "post_a", 400, 250);
    await sendBundle(player_id, secret, 5);
    const def = await getDefense(player_id, "post_a");
    expect(def.max_hp).toBe(400);
    expect(def.hp).toBe(250); // untouched
  });

  it("never lowers the pool (a lower asserted level leaves a bigger pool alone)", async () => {
    const { player_id, secret } = await registerPlayer();
    await seedDefense(player_id, "post_a", 400, 400);
    await sendBundle(player_id, secret, 2); // client asserts L2, pool is L5
    const def = await getDefense(player_id, "post_a");
    expect(def.max_hp).toBe(400); // reconcile only raises
  });

  it("does NOT raise while a raid knockdown for the post is still pending", async () => {
    const { player_id, secret } = await registerPlayer();
    await seedDefense(player_id, "post_a", 175, 175); // knocked down to L3 by a raid
    // The raid_damaged notification is still queued for delivery; the client is
    // about to lower its asserted level, so a level-5 assertion here is stale.
    await env.SCOUTS.put(notificationsKey(player_id), JSON.stringify([
      { type: "raid_damaged", message: "hit", timestamp: Math.floor(Date.now() / 1000),
        data: { post_token: "post_a", level_after: 3 } },
    ]));
    await sendBundle(player_id, secret, 5);
    const def = await getDefense(player_id, "post_a");
    expect(def.max_hp).toBe(175); // guard held — HP the raid removed was not handed back
  });
});
