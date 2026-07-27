import { env as testEnv } from "cloudflare:test";
import { kvAdapter } from "../../src/kv/do_store.js";
import type { Env } from "../../src/types.js";

// The seven KV namespace bindings the Worker uses, each backed by the real
// KvStore Durable Object (via kvAdapter) instead of an in-memory mock. The
// vitest-pool-workers runtime gives every test isolated storage, so a fresh
// makeEnv() per test starts empty. shimEnv passes this through unchanged
// (no KV_DO key), so routes talk directly to these DO-backed adapters.
const KV_BINDINGS = ["LEDGER", "PLAYERS", "ATTACKS", "DEFENSE", "SCOUTS", "META"] as const;

// Every RPC method KvStore exposes. Listed explicitly because the counting stub
// below re-exports them one by one; a new KvStore method must be added here or
// callers of makeCountingEnv will see it as undefined.
const KV_STORE_METHODS = [
  "kvGet", "kvPut", "kvDelete", "kvList", "kvGetMany", "kvListValues",
  "snapshot", "applyMutations", "kvClear", "kvPurgeExpired",
] as const;

/**
 * Like makeEnv, but every Durable Object method call is counted — both the ones
 * the KV adapters make and the composite snapshot/applyMutations calls, since
 * both funnel through the same stub.
 *
 * A DO method call is one subrequest, and Cloudflare caps a request at 50 of them
 * on the free plan. That makes "how many RPCs does this endpoint issue" a
 * correctness property, not a performance note: an endpoint whose reads scale
 * with the roster stops working at a few dozen players. Tests assert the count so
 * a per-player fan-out can't quietly come back.
 */
export function makeCountingEnv(): { env: Env; rpcs: () => number; resetCount: () => void } {
  const kvDo = (testEnv as unknown as { KV_DO: DurableObjectNamespace }).KV_DO;
  let count = 0;

  const countingNs = {
    idFromName: (name: string) => kvDo.idFromName(name),
    get: (id: DurableObjectId) => {
      // Each method is re-dispatched through the stub itself (`stub[name](...)`)
      // rather than detached and re-applied: workerd's RPC proxy resolves the
      // call off its own receiver, and handing it any other `this` makes it try
      // to serialize a stub ("ServiceStub serialization requires the
      // 'experimental' compat flag"). Counting happens in the wrapper only.
      const stub = kvDo.get(id) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const wrap = (name: string) => (...args: unknown[]) => {
        count++;
        return stub[name](...args);
      };
      const counted: Record<string, unknown> = {};
      for (const name of KV_STORE_METHODS) counted[name] = wrap(name);
      return counted;
    },
  } as unknown as DurableObjectNamespace;

  const e = {} as Record<string, unknown>;
  for (const name of KV_BINDINGS) {
    e[name] = kvAdapter(countingNs as never, name);
  }
  e.KV_DO = countingNs;
  return {
    env: e as unknown as Env,
    rpcs: () => count,
    resetCount: () => { count = 0; },
  };
}

export function makeEnv(): Env {
  const kvDo = (testEnv as unknown as { KV_DO: DurableObjectNamespace }).KV_DO;
  const e = {} as Record<string, unknown>;
  for (const name of KV_BINDINGS) {
    e[name] = kvAdapter(kvDo, name);
  }
  // Composite helpers (snapshot/applyMutations) reach the shared instance through
  // env.KV_DO directly, so expose it here too — production always has it.
  e.KV_DO = kvDo;
  return e as unknown as Env;
}
