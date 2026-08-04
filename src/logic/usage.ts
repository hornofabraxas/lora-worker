// Reads today's Cloudflare usage (Worker requests + Durable Object requests) for
// the admin Usage tab. Durable Object *requests* — not reads/writes/storage — are
// the binding constraint on this game's plan (100k/day free), and Worker requests
// share the same 100k/day free cap; those two counters, as a percentage of the
// free-tier daily ceiling, are the gauge an operator actually watches. See
// project-lora-multiplayer-system "Scaling" for the budget these percentages track.
//
// Everything here is read-only analytics via the GraphQL Analytics API. It is kept
// out of admin.ts so the GraphQL shape can be unit-tested without standing up the
// whole admin router.

// Free-tier daily ceilings the percentages are measured against. Both are the
// Cloudflare free-plan limits; on the $5 Workers Paid plan these become the
// "included" allotment before usage billing, so the percentage stays the useful
// early-warning gauge either way.
export const WORKERS_FREE_DAILY = 100_000;
export const DO_FREE_DAILY = 100_000;

// The deployed Worker's script name (wrangler.toml `name`). Worker-invocation
// analytics are filtered by it; DO analytics are account-wide (this account runs
// only this Worker's DO).
export const SCRIPT_NAME = "lora-worker";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export interface UsageMetric {
  requests: number;
  limit: number;
  /** requests / limit, clamped to [0, 1] for a progress bar; percent = *100. */
  fraction: number;
}

export interface UsageReport {
  ok: true;
  configured: boolean;
  /** Present only when configured. */
  since?: string;
  workers?: UsageMetric;
  durableObjects?: UsageMetric;
  /** Documented planning figure, surfaced for context alongside the live counts. */
  freeTierPlayerCeiling?: number;
}

function startOfUtcDayIso(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString();
}

function metric(requests: number, limit: number): UsageMetric {
  const safe = Number.isFinite(requests) && requests > 0 ? requests : 0;
  return { requests: safe, limit, fraction: Math.min(1, Math.max(0, safe / limit)) };
}

// The Analytics API groups Worker invocations and DO invocations into separate
// datasets; one query pulls both for the current UTC day. `sum { requests }` is
// summed across returned groups in case the API buckets by dimension.
const QUERY = `query Usage($account: String!, $script: String!, $since: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { scriptName: $script, datetime_geq: $since }
      ) { sum { requests } }
      durableObjectsInvocationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $since }
      ) { sum { requests } }
    }
  }
}`;

interface SumRow { sum?: { requests?: number } }

export function sumRequests(rows: SumRow[] | undefined): number {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((acc, r) => acc + (r?.sum?.requests ?? 0), 0);
}

// Fetches the report. `fetchImpl` is injectable so tests can supply a fake
// GraphQL response without a network call. Throws with a readable message on any
// transport/GraphQL error so the route can surface it to the operator.
export async function fetchUsage(
  env: { CF_ACCOUNT_ID?: string; CF_ANALYTICS_TOKEN?: string },
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<UsageReport> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return { ok: true, configured: false };
  }
  const since = startOfUtcDayIso(now);
  const res = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { account: env.CF_ACCOUNT_ID, script: SCRIPT_NAME, since },
    }),
  });
  if (!res.ok) {
    throw new Error(`Cloudflare Analytics API returned ${res.status}`);
  }
  const body = (await res.json()) as {
    data?: { viewer?: { accounts?: Array<{
      workersInvocationsAdaptive?: SumRow[];
      durableObjectsInvocationsAdaptiveGroups?: SumRow[];
    }> } };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors && body.errors.length) {
    throw new Error(body.errors.map((e) => e.message).filter(Boolean).join("; ") || "GraphQL error");
  }
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) {
    // No account row means the token can't see this account (wrong id or scope).
    throw new Error("No analytics for this account — check CF_ACCOUNT_ID and the token's account scope.");
  }
  return {
    ok: true,
    configured: true,
    since,
    workers: metric(sumRequests(account.workersInvocationsAdaptive), WORKERS_FREE_DAILY),
    durableObjects: metric(sumRequests(account.durableObjectsInvocationsAdaptiveGroups), DO_FREE_DAILY),
    freeTierPlayerCeiling: 560,
  };
}
