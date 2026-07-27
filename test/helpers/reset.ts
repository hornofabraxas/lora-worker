import { beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { CONSOLIDATED_DO_NAME } from "../../src/kv/do_store.js";

// The pinned vitest-pool-workers (0.18.1) doesn't auto-isolate per-test storage,
// so wipe the shared KvStore instance before each test. All namespaces now live
// in one consolidated instance (keys prefixed per namespace), so one clear resets
// every namespace. Registered as a setupFile in vitest.config.ts.
beforeEach(async () => {
  const kvDo = (env as unknown as { KV_DO: DurableObjectNamespace }).KV_DO;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (kvDo.get(kvDo.idFromName(CONSOLIDATED_DO_NAME)) as any).kvClear();
});
