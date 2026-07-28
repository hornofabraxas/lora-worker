import { Hono } from "hono";
import type { Env } from "./types.js";
import { clientVersionMiddleware } from "./middleware/version.js";
import register from "./routes/register.js";
import bundle from "./routes/bundle.js";
import leaderboard from "./routes/leaderboard.js";
import scout from "./routes/scout.js";
import defense from "./routes/defense.js";
import raid from "./routes/raid.js";
import shop from "./routes/shop.js";
import admin from "./routes/admin.js";
import adminUi from "./routes/admin_ui.js";
import status from "./routes/status.js";
import { backfillPlayerIndex, regenPostHp } from "./logic/cron.js";
import { resolveDueRaids } from "./logic/resolve.js";
import { rebuildLeaderboardCache } from "./logic/leaderboard.js";
import { KvStore, kvAdapter, consolidatedStub } from "./kv/do_store.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", clientVersionMiddleware);

app.get("/", (c) => c.json({ name: "lora-worker", version: "0.1.0" }));

app.route("", register);
app.route("", bundle);
app.route("", leaderboard);
app.route("", scout);
app.route("", defense);
app.route("", raid);
app.route("", shop);
app.route("", admin);
app.route("", adminUi);
app.route("", status);

const KV_BINDINGS = ["PLAYERS", "ATTACKS", "DEFENSE", "SCOUTS", "META"] as const;

/**
 * In production, replace the KV namespace bindings with DO-backed adapters so
 * all storage runs on SQLite Durable Objects (100k writes/day vs KV's 1k).
 * When KV_DO is absent (unit tests supply mock KV directly), pass env through
 * unchanged so the existing suite keeps working without modification.
 */
function shimEnv(env: Env): Env {
  if (!env.KV_DO) return env;
  const shimmed: Env = { ...env };
  for (const name of KV_BINDINGS) {
    (shimmed as unknown as Record<string, KVNamespace>)[name] = kvAdapter(env.KV_DO, name);
  }
  return shimmed;
}

export { KvStore };

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> => {
    return app.fetch(request, shimEnv(env), ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const e = shimEnv(env);
    await resolveDueRaids(e); // backstop: resolve raids landed on inactive defenders
    await backfillPlayerIndex(e);
    await regenPostHp(e);
    // Refresh the leaderboard snapshot from truth (backstop for any drift; also
    // keeps a warm snapshot ready between player writes).
    await rebuildLeaderboardCache(e);
    // Housekeeping: drop expired rows (rate-limit / daily-cap counters). One
    // shared instance now, so a single purge covers every namespace.
    if (env.KV_DO) {
      await consolidatedStub(env.KV_DO).kvPurgeExpired();
    }
  },
};
