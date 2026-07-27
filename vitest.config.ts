import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Every suite runs inside the real Workers runtime (Miniflare) so the KvStore
// Durable Object + kvAdapter are exercised for real — no mock KV, no
// `cloudflare:workers` stub. KV-backed suites build their env from the KV_DO
// binding via test/helpers/env.ts; the pool gives each test isolated storage.
// Bindings/migrations come from wrangler.toml.
const options = { wrangler: { configPath: "./wrangler.toml" } };

export default defineConfig({
  plugins: [cloudflareTest(options)],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/helpers/reset.ts"],
    pool: cloudflarePool(options),
  },
});
