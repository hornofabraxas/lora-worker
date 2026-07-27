import type { Env } from "../types.js";
import { consolidatedStub, nsKey } from "./do_store.js";

/**
 * Composite read/write helpers over the single consolidated KvStore instance.
 *
 * A snapshot pulls several exact keys and several prefix ranges — across logical
 * namespaces — in ONE RPC, so a status poll or raid resolution reads everything
 * it needs in a single round trip instead of one get/list per key. A
 * MutationBuffer accumulates every write an operation makes and flushes them in
 * ONE atomic RPC, so a multi-row change (a raid mutating defense + player + raid
 * record + attacker pointers + notification) can never be truncated half-applied.
 */

export interface NsRef {
  ns: string;
  key: string;
  /** Range refs only: max rows to pull for this prefix (default the store's
   *  DEFAULT_RANGE_LIMIT). Ignored for exact-key refs. */
  limit?: number;
  /** Range refs only: scan the prefix in descending key order, so `limit` yields
   *  the newest rows of a time-sortable keyspace (e.g. the bundle feed reading
   *  recent activity without knowing a checkpoint up front). */
  desc?: boolean;
}

export interface SnapshotResult {
  /** Values for the requested exact keys, aligned to input order; null if absent. */
  exact: (string | null)[];
  /** Rows for each requested range, aligned to input order. `key` has the
   *  namespace prefix stripped back to the logical key. */
  ranges: { key: string; value: string }[][];
}

/** One-RPC read of exact keys + prefix ranges, addressed by (namespace, key). */
export async function snapshotRead(
  env: Env,
  exact: NsRef[],
  ranges: NsRef[],
): Promise<SnapshotResult> {
  const stub = consolidatedStub(env.KV_DO!);
  const res = await stub.snapshot(
    exact.map((e) => nsKey(e.ns, e.key)),
    ranges.map((r) => nsKey(r.ns, r.key)),
    ranges.map((r) => r.limit ?? null),
    ranges.map((r) => r.desc ?? false),
  );
  return {
    exact: res.exact,
    ranges: res.ranges.map((rows, i) => {
      const prefix = nsKey(ranges[i].ns, "");
      return rows.map((row) => ({
        key: row.key.startsWith(prefix) ? row.key.slice(prefix.length) : row.key,
        value: row.value,
      }));
    }),
  };
}

/** Accumulates puts/deletes across namespaces and commits them atomically. */
export class MutationBuffer {
  private puts: { key: string; value: string; expiresAt: number | null }[] = [];
  private deletes: string[] = [];

  put(ns: string, key: string, value: string, ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : null;
    this.puts.push({ key: nsKey(ns, key), value, expiresAt });
  }

  del(ns: string, key: string): void {
    this.deletes.push(nsKey(ns, key));
  }

  get empty(): boolean {
    return this.puts.length === 0 && this.deletes.length === 0;
  }

  /** Flush every buffered write in one atomic RPC. No-op when empty. */
  async commit(env: Env): Promise<void> {
    if (this.empty) return;
    await consolidatedStub(env.KV_DO!).applyMutations(this.puts, this.deletes);
  }
}
