import { DurableObject } from "cloudflare:workers";

// Instance every logical namespace resolves to. Consolidated (2026-07-22): all
// namespaces now share ONE KvStore instance, so a request can read/write across
// them in a single RPC (see snapshot/applyMutations) instead of one round trip
// per namespace. The adapter keeps them logically isolated by prefixing each key
// with its namespace (see NS_SEP), so nothing collides in the shared table.
export const CONSOLIDATED_DO_NAME = "main";

// Namespace/key separator. 0x1F (unit separator) never appears in an app key
// (keys are lowercase ascii, digits, ':' and '_'), and sorts below all of them,
// so per-namespace range scans stay correctly bounded within the shared table.
export const NS_SEP = "\x1f";

// Backstop ceiling for a single prefix scan when the caller names no tighter
// limit. Callers should pass a limit sized to what they actually need (see the
// composite range refs); this only exists so nothing ever issues a truly
// unbounded pull that grows with the whole keyspace.
export const DEFAULT_RANGE_LIMIT = 10000;

// Max keys per IN (...) lookup. workerd's DO SQLite caps a statement at 100 bound
// variables total; these lookups also bind `now`, so the ceiling for keys is 99.
// Chunk conservatively below that so a large exact-key read — the cron resolving
// many due raids, or a leaderboard rebuild over 100+ players — is split into
// safe statements instead of tripping "too many SQL variables". Shared by the
// snapshot lookup and the kvGetMany adapter chunking.
const EXACT_KEY_CHUNK = 90;

/**
 * KvStore — a generic SQLite-backed Durable Object that emulates the subset of
 * the KV interface this Worker uses (get/put/delete/list + TTL), plus batched
 * (getMany/listValues) and composite (snapshot/applyMutations) operations.
 *
 * Why DO over KV: Cloudflare KV free tier caps at 1,000 writes/day (~8 active
 * players). SQLite-backed Durable Objects are on the same free plan but allow
 * 100,000 rows written/day. The KV-compatible adapter keeps every route, query
 * helper, and existing test untouched.
 *
 * Why one instance: a single instance lets a poll/bundle/raid-resolution touch
 * player + defense + raid rows in one RPC (the per-op RPC count, not the write
 * budget, was the free-tier ceiling) and lets a raid resolve as one atomic
 * write batch. Per-player sharding remains the later step if *write concurrency*
 * ever becomes the wall — see docs/do-consolidation-2026-07.md.
 */
export class KvStore extends DurableObject {
  private initialized = false;

  private init(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)",
    );
    this.initialized = true;
  }

  private static now(): number {
    return Math.floor(Date.now() / 1000);
  }

  async kvGet(key: string): Promise<string | null> {
    this.init();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
        key,
        KvStore.now(),
      )
      .toArray();
    return rows.length ? (rows[0].value as string) : null;
  }

  async kvPut(key: string, value: string, expiresAt: number | null): Promise<void> {
    this.init();
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      key,
      value,
      expiresAt,
    );
  }

  async kvDelete(key: string): Promise<void> {
    this.init();
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }

  /** Returns key names with the given prefix (range scan, no LIKE wildcards). */
  async kvList(prefix: string, limit: number | null): Promise<string[]> {
    this.init();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT key FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?",
        prefix,
        prefix + "￿",
        KvStore.now(),
        limit ?? DEFAULT_RANGE_LIMIT,
      )
      .toArray();
    return rows.map((r) => r.key as string);
  }

  /**
   * Batched multi-key read — one RPC (and one SQL statement) for N keys instead
   * of N round trips. Returns values aligned to the input order, null for any
   * key that is missing or expired. Callers chunk large key sets (see the
   * adapter) to stay within SQLite's bound-parameter ceiling.
   */
  async kvGetMany(keys: string[]): Promise<(string | null)[]> {
    this.init();
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(",");
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT key, value FROM kv WHERE key IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?)`,
        ...keys,
        KvStore.now(),
      )
      .toArray();
    const found = new Map<string, string>();
    for (const r of rows) found.set(r.key as string, r.value as string);
    return keys.map((k) => found.get(k) ?? null);
  }

  /**
   * Like kvList but returns key *and* value in the same RPC — so a prefix scan
   * that needs the row bodies (raids, ledger bundles, per-post defense) doesn't
   * pay a follow-up get per key. Same range-scan semantics as kvList.
   */
  async kvListValues(
    prefix: string,
    limit: number | null,
    start: string | null = null,
  ): Promise<{ key: string; value: string }[]> {
    this.init();
    // `start` (when given) is the inclusive lower bound within the prefix range,
    // so a time-sortable keyspace can be read from a point rather than the top.
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT key, value FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?",
        start ?? prefix,
        prefix + "￿",
        KvStore.now(),
        limit ?? DEFAULT_RANGE_LIMIT,
      )
      .toArray();
    return rows.map((r) => ({ key: r.key as string, value: r.value as string }));
  }

  /**
   * Composite read: fetch several exact keys and several prefix ranges in ONE
   * RPC. Powers the hot paths (status poll, bundle, raid resolution, leaderboard
   * rebuild) that previously issued a get/list per key. Returns raw strings; the
   * Worker owns all decoding and game logic.
   */
  async snapshot(
    exactKeys: string[],
    rangePrefixes: string[],
    rangeLimits: (number | null)[] = [],
    rangeDescs: boolean[] = [],
  ): Promise<{ exact: (string | null)[]; ranges: { key: string; value: string }[][] }> {
    this.init();
    const now = KvStore.now();

    // Chunk the exact-key lookup so a large snapshot (e.g. the cron resolving
    // many due raids, which reads 4 keys per raid) can never exceed SQLite's
    // bound-parameter ceiling in a single IN (...) clause.
    const found = new Map<string, string>();
    for (let i = 0; i < exactKeys.length; i += EXACT_KEY_CHUNK) {
      const chunk = exactKeys.slice(i, i + EXACT_KEY_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT key, value FROM kv WHERE key IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?)`,
          ...chunk,
          now,
        )
        .toArray();
      for (const r of rows) found.set(r.key as string, r.value as string);
    }
    const exact = exactKeys.map((k) => found.get(k) ?? null);

    // Each range carries its own row cap (default DEFAULT_RANGE_LIMIT) and an
    // optional descending order, so a prefix scan pulls only what the caller needs
    // — the whole keyspace behind the prefix is never read. DESC + a limit yields
    // the newest rows of a time-sortable keyspace (the direction is derived from a
    // boolean, never user text, so interpolating it is safe).
    const ranges = rangePrefixes.map((prefix, i) => {
      const order = rangeDescs[i] ? "DESC" : "ASC";
      return this.ctx.storage.sql
        .exec(
          `SELECT key, value FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key ${order} LIMIT ?`,
          prefix,
          prefix + "￿",
          now,
          rangeLimits[i] ?? DEFAULT_RANGE_LIMIT,
        )
        .toArray()
        .map((r) => ({ key: r.key as string, value: r.value as string }));
    });

    return { exact, ranges };
  }

  /**
   * Atomic multi-key write: apply every put and delete in ONE RPC. Because a DO
   * runs each method to completion single-threaded, the whole batch commits or
   * (on a thrown error) leaves the prior state — so an operation spanning several
   * rows (raid resolution mutates defense + player + raid record + attacker
   * pointers + notification) can no longer be truncated half-applied.
   */
  async applyMutations(
    puts: { key: string; value: string; expiresAt: number | null }[],
    deletes: string[],
  ): Promise<void> {
    this.init();
    for (const p of puts) {
      this.ctx.storage.sql.exec(
        "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        p.key,
        p.value,
        p.expiresAt,
      );
    }
    for (const key of deletes) {
      this.ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", key);
    }
  }

  /** Test helper: drop every row so each test starts from empty isolated
   * storage. Never called in production. */
  async kvClear(): Promise<void> {
    this.init();
    this.ctx.storage.sql.exec("DELETE FROM kv");
  }

  /** Housekeeping: drop expired rows. Called from the scheduled cron. */
  async kvPurgeExpired(): Promise<number> {
    this.init();
    const cursor = this.ctx.storage.sql.exec(
      "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
      KvStore.now(),
    );
    return cursor.rowsWritten;
  }
}

type KvStoreStub = DurableObjectStub<KvStore>;

/**
 * The KV surface plus the two batch reads the adapter adds on top. Routes/queries
 * that want batching cast their namespace binding via `batch()` — production and
 * the test suite both run the real DO-backed adapter, so the methods are always
 * present.
 */
export interface BatchKV extends KVNamespace {
  getMany(keys: string[]): Promise<(string | null)[]>;
  listValues(prefix: string, limit?: number, start?: string): Promise<{ name: string; value: string }[]>;
}

export function batch(ns: KVNamespace): BatchKV {
  return ns as unknown as BatchKV;
}

/** Resolve the one shared KvStore instance every namespace lives in. */
export function consolidatedStub(ns: DurableObjectNamespace<KvStore>): KvStoreStub {
  return ns.get(ns.idFromName(CONSOLIDATED_DO_NAME));
}

/** The stored key for a logical (namespace, key) pair in the shared table. */
export function nsKey(namespace: string, key: string): string {
  return namespace + NS_SEP + key;
}

/**
 * Wraps the shared KvStore instance in the KVNamespace-compatible surface the
 * Worker relies on, scoped to one logical `name` (LEDGER, PLAYERS, ...). Every
 * key is transparently prefixed with `name` so the namespaces stay isolated in
 * the single underlying table; the prefix is stripped from anything returned.
 */
export function kvAdapter(
  ns: DurableObjectNamespace<KvStore>,
  name: string,
): KVNamespace {
  const stub: KvStoreStub = consolidatedStub(ns);
  const prefix = name + NS_SEP;
  const strip = (k: string) => (k.startsWith(prefix) ? k.slice(prefix.length) : k);

  const get = async (key: string, options?: unknown): Promise<unknown> => {
    const raw = await stub.kvGet(prefix + key);
    if (raw === null) return null;
    const asJson =
      options === "json" ||
      (typeof options === "object" && options !== null && (options as { type?: string }).type === "json");
    return asJson ? JSON.parse(raw) : raw;
  };

  const put = async (
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number },
  ): Promise<void> => {
    let expiresAt: number | null = null;
    if (options?.expirationTtl) expiresAt = Math.floor(Date.now() / 1000) + options.expirationTtl;
    else if (options?.expiration) expiresAt = options.expiration;
    await stub.kvPut(prefix + key, value, expiresAt);
  };

  const del = async (key: string): Promise<void> => {
    await stub.kvDelete(prefix + key);
  };

  const list = async (options?: { prefix?: string; limit?: number }) => {
    const names = await stub.kvList(prefix + (options?.prefix ?? ""), options?.limit ?? null);
    return {
      keys: names.map((n) => ({ name: strip(n) })),
      list_complete: true,
      cacheStatus: null,
    };
  };

  const getWithMetadata = async (key: string, options?: unknown) => ({
    value: await get(key, options),
    metadata: null,
    cacheStatus: null,
  });

  // Chunked (EXACT_KEY_CHUNK) so a large key set can't blow past SQLite's 100
  // bound-variable ceiling — kvGetMany also binds `now`, so the same 99-key limit
  // applies. Each chunk is one DO RPC (and one subrequest), so even hundreds of
  // players resolve in a few round trips rather than N.
  const getMany = async (keys: string[]): Promise<(string | null)[]> => {
    const out: (string | null)[] = [];
    for (let i = 0; i < keys.length; i += EXACT_KEY_CHUNK) {
      const values = await stub.kvGetMany(keys.slice(i, i + EXACT_KEY_CHUNK).map((k) => prefix + k));
      for (const v of values) out.push(v);
    }
    return out;
  };

  const listValues = async (p?: string, limit?: number, start?: string) => {
    const rows = await stub.kvListValues(
      prefix + (p ?? ""),
      limit ?? null,
      start !== undefined ? prefix + start : null,
    );
    return rows.map((r) => ({ name: strip(r.key), value: r.value }));
  };

  return { get, put, delete: del, list, getWithMetadata, getMany, listValues } as unknown as KVNamespace;
}
