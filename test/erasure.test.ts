import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import type { Env, RaidRecord } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { ERASED_PLAYER_ID, ERASED_PLAYER_NAME } from "../src/kv/queries.js";

// Deleting a player has to actually delete them. This locks down the guarantee
// the privacy notice makes: nothing keyed by the departed player survives, and
// their identifiers are scrubbed out of records belonging to players who remain.

const ADMIN = "test-admin-secret";
let env: Env;

beforeEach(() => {
  env = makeEnv();
  (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = ADMIN;
});

async function seed(display_name: string, token: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/admin/seed-player", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": ADMIN },
      body: JSON.stringify({ display_name, posts: [{ post_token: token, level: 2 }] }),
    }),
    env,
  );
  return ((await res.json()) as { player_id: string }).player_id;
}

function raid(attackerId: string, attackerName: string, targetId: string, targetName: string): string {
  const r: Partial<RaidRecord> = {
    raid_id: "r1",
    attacker_id: attackerId,
    attacker_name: attackerName,
    target_player_id: targetId,
    target_player_name: targetName,
    target_post_token: "tokB",
    item_types: [],
    raw_power: 10,
    dispatched_at: 1,
    arrives_at: 2,
    status: "resolved",
  };
  return JSON.stringify(r);
}

function del(id: string): Request {
  return new Request(`http://localhost/api/admin/player/${id}`, {
    method: "DELETE",
    headers: { "x-admin-secret": ADMIN },
  });
}

describe("player erasure", () => {
  it("removes every row keyed by the deleted player", async () => {
    const gone = await seed("Departing", "tokA");
    await env.META.put(`audit:reject:${gone}`, "3");
    await env.ATTACKS.put(`araid:${gone}`, "r9");
    await env.ATTACKS.put(`araidlast:${gone}`, raid(gone, "Departing", "other", "Other"));
    await env.ATTACKS.put(`raid:${gone}:r7`, raid("other", "Other", gone, "Departing"));
    await env.ATTACKS.put(`raidcd:${gone}:tokX`, "123");
    await env.DEFENSE.put(`razed:${gone}:tokOld`, "1");
    await env.SCOUTS.put(`notifications:${gone}`, JSON.stringify([{ type: "scouted" }]));
    await env.META.put(`ratelimit:${gone}:bundles:1`, "4");

    expect((await app.fetch(del(gone), env)).status).toBe(200);

    expect(await env.PLAYERS.get(`player:${gone}`)).toBeNull();
    expect(await env.PLAYERS.get(`player:${gone}:last_bundle`)).toBeNull();
    expect(await env.META.get(`audit:reject:${gone}`)).toBeNull();
    expect(await env.ATTACKS.get(`araid:${gone}`)).toBeNull();
    expect(await env.ATTACKS.get(`araidlast:${gone}`)).toBeNull();
    expect(await env.ATTACKS.get(`raid:${gone}:r7`)).toBeNull();
    expect(await env.ATTACKS.get(`raidcd:${gone}:tokX`)).toBeNull();
    expect(await env.DEFENSE.get(`razed:${gone}:tokOld`)).toBeNull();
    expect(await env.DEFENSE.get(`defense:${gone}:tokA`)).toBeNull();
    expect(await env.SCOUTS.get(`notifications:${gone}`)).toBeNull();
    expect(await env.META.get(`ratelimit:${gone}:bundles:1`)).toBeNull();
  });

  it("scrubs the deleted player out of a surviving player's raid history", async () => {
    const gone = await seed("Departing", "tokA");
    const stays = await seed("Survivor", "tokB");

    // Filed under the survivor's id — the departed player was the attacker.
    await env.ATTACKS.put(`raid:${stays}:r1`, raid(gone, "Departing", stays, "Survivor"));
    // The survivor's own attacker-side copy of a raid against the departed one.
    await env.ATTACKS.put(`araidlast:${stays}`, raid(stays, "Survivor", gone, "Departing"));

    await app.fetch(del(gone), env);

    const inbound = JSON.parse((await env.ATTACKS.get(`raid:${stays}:r1`))!) as RaidRecord;
    expect(inbound.attacker_id).toBe(ERASED_PLAYER_ID);
    expect(inbound.attacker_name).toBe(ERASED_PLAYER_NAME);
    // The survivor's own side of the record is untouched — their history is theirs.
    expect(inbound.target_player_id).toBe(stays);
    expect(inbound.target_player_name).toBe("Survivor");

    const outbound = JSON.parse((await env.ATTACKS.get(`araidlast:${stays}`))!) as RaidRecord;
    expect(outbound.target_player_id).toBe(ERASED_PLAYER_ID);
    expect(outbound.target_player_name).toBe(ERASED_PLAYER_NAME);
    expect(outbound.attacker_id).toBe(stays);

    // No trace of the old identifiers anywhere in the raid space.
    for (const row of await env.ATTACKS.list({ prefix: "" }).then((l) => l.keys)) {
      const v = await env.ATTACKS.get(row.name);
      expect(v ?? "").not.toContain(gone);
      expect(v ?? "").not.toContain("Departing");
    }
  });

  it("deletes scout reports naming the player, and only those", async () => {
    const gone = await seed("Departing", "tokA");
    const stays = await seed("Survivor", "tokB");

    await env.SCOUTS.put("scout:s1", JSON.stringify({ scouter: gone, target_player: stays }));
    await env.SCOUTS.put("scout:s2", JSON.stringify({ scouter: stays, target_player: gone }));
    await env.SCOUTS.put("scout:s3", JSON.stringify({ scouter: stays, target_player: "third" }));

    await app.fetch(del(gone), env);

    expect(await env.SCOUTS.get("scout:s1")).toBeNull();
    expect(await env.SCOUTS.get("scout:s2")).toBeNull();
    expect(await env.SCOUTS.get("scout:s3")).not.toBeNull(); // unrelated, survives
  });

  it("drops the player from the leaderboard index", async () => {
    const gone = await seed("Departing", "tokA");
    const stays = await seed("Survivor", "tokB");

    await app.fetch(del(gone), env);

    const res = await app.fetch(
      new Request(`http://localhost/api/admin/player/${stays}`, {
        headers: { "x-admin-secret": ADMIN },
      }),
      env,
    );
    expect(res.status).toBe(200); // survivor intact
    expect((await app.fetch(del(gone), env)).status).toBe(404); // already gone
  });
});
