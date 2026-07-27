import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { snapshotRead, MutationBuffer } from "../src/kv/composite.js";
import { NS } from "../src/kv/schema.js";

let env: Env;

describe("composite snapshot + atomic mutations", () => {
  beforeEach(() => { env = makeEnv(); });

  it("snapshotRead returns exact keys and prefix ranges across namespaces in one call", async () => {
    await env.PLAYERS.put("player:p1", JSON.stringify({ id: "p1" }));
    await env.DEFENSE.put("defense:p1:hexA", "A");
    await env.DEFENSE.put("defense:p1:hexB", "B");
    await env.DEFENSE.put("defense:p2:hexC", "C"); // different player — must not leak
    await env.ATTACKS.put("araidlast:p1", JSON.stringify({ raid_id: "r1" }));

    const snap = await snapshotRead(
      env,
      [
        { ns: NS.PLAYERS, key: "player:p1" },
        { ns: NS.ATTACKS, key: "araidlast:p1" },
        { ns: NS.PLAYERS, key: "player:missing" },
      ],
      [{ ns: NS.DEFENSE, key: "defense:p1:" }],
    );

    expect(JSON.parse(snap.exact[0]!).id).toBe("p1");
    expect(JSON.parse(snap.exact[1]!).raid_id).toBe("r1");
    expect(snap.exact[2]).toBeNull();

    // Range keys come back with the namespace prefix stripped to the logical key,
    // and are scoped to p1 only.
    const rows = snap.ranges[0];
    expect(rows.map((r) => r.key).sort()).toEqual(["defense:p1:hexA", "defense:p1:hexB"]);
    expect(rows.map((r) => r.value).sort()).toEqual(["A", "B"]);
  });

  it("MutationBuffer applies puts and deletes across namespaces atomically", async () => {
    await env.PLAYERS.put("player:p1", "old");
    await env.ATTACKS.put("araid:p1", "lock");

    const buf = new MutationBuffer();
    buf.put(NS.PLAYERS, "player:p1", "new");
    buf.put(NS.DEFENSE, "defense:p1:hexA", JSON.stringify({ hp: 50 }));
    buf.del(NS.ATTACKS, "araid:p1");
    await buf.commit(env);

    expect(await env.PLAYERS.get("player:p1")).toBe("new");
    expect(await env.DEFENSE.get("defense:p1:hexA", "json")).toEqual({ hp: 50 });
    expect(await env.ATTACKS.get("araid:p1")).toBeNull();
  });

  it("an empty MutationBuffer commit is a no-op", async () => {
    const buf = new MutationBuffer();
    expect(buf.empty).toBe(true);
    await buf.commit(env); // must not throw
  });

  it("put honors a TTL (expired entries read back as null)", async () => {
    const buf = new MutationBuffer();
    buf.put(NS.META, "temp", "v", 1);
    await buf.commit(env);
    expect(await env.META.get("temp")).toBe("v");
  });

  it("snapshotRead handles far more exact keys than the bound-parameter chunk", async () => {
    // Well past the 100-key chunk: the cron resolving many due raids reads
    // several keys each, so a snapshot must chunk its IN (...) lookup rather than
    // build one oversized statement that trips SQLite's bound-parameter ceiling.
    const N = 250;
    for (let i = 0; i < N; i++) {
      await env.PLAYERS.put(`player:p${i}`, JSON.stringify({ id: `p${i}` }));
    }
    const refs = Array.from({ length: N }, (_, i) => ({ ns: NS.PLAYERS, key: `player:p${i}` }));
    // Interleave a couple of guaranteed-missing keys to prove alignment survives chunking.
    refs.splice(150, 0, { ns: NS.PLAYERS, key: "player:absent" });

    const snap = await snapshotRead(env, refs, []);
    expect(snap.exact.length).toBe(refs.length);
    expect(snap.exact[150]).toBeNull();
    expect(JSON.parse(snap.exact[0]!).id).toBe("p0");
    expect(JSON.parse(snap.exact[snap.exact.length - 1]!).id).toBe(`p${N - 1}`);
  });

  it("getMany reads past the 99-key bound-variable ceiling via chunking", async () => {
    // The leaderboard rebuild getMany's every player; at 100+ players an
    // unchunked lookup would trip SQLite's 100-variable limit.
    const N = 150;
    for (let i = 0; i < N; i++) {
      await env.PLAYERS.put(`player:p${i}`, `v${i}`);
    }
    const keys = Array.from({ length: N }, (_, i) => `player:p${i}`);
    const values = await (env.PLAYERS as any).getMany(keys);
    expect(values.length).toBe(N);
    expect(values[0]).toBe("v0");
    expect(values[N - 1]).toBe(`v${N - 1}`);
  });

  it("snapshotRead caps a range at the requested limit", async () => {
    for (let i = 0; i < 20; i++) {
      // Zero-pad so lexical order is stable and predictable.
      await env.DEFENSE.put(`defense:p1:hex${String(i).padStart(2, "0")}`, String(i));
    }
    const snap = await snapshotRead(env, [], [{ ns: NS.DEFENSE, key: "defense:p1:", limit: 5 }]);
    expect(snap.ranges[0].length).toBe(5);
    // ORDER BY key means the first 5 lexicographically.
    expect(snap.ranges[0].map((r) => r.value)).toEqual(["0", "1", "2", "3", "4"]);
  });
});
