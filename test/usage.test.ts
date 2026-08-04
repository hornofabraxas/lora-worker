import { describe, it, expect } from "vitest";
import { fetchUsage, sumRequests, WORKERS_FREE_DAILY, DO_FREE_DAILY } from "../src/logic/usage.js";

function graphqlResponse(workerReqs: number, doReqs: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({
      data: { viewer: { accounts: [{
        workersInvocationsAdaptive: [{ sum: { requests: workerReqs } }],
        durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: doReqs } }],
      }] } },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("usage report", () => {
  it("reports not-configured when secrets are unset", async () => {
    const r = await fetchUsage({}, new Date(), (async () => new Response("")) as unknown as typeof fetch);
    expect(r.configured).toBe(false);
    expect(r.workers).toBeUndefined();
  });

  it("computes fractions against the free-tier daily ceilings", async () => {
    const r = await fetchUsage(
      { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" },
      new Date(),
      graphqlResponse(50_000, 90_000),
    );
    expect(r.configured).toBe(true);
    expect(r.workers).toEqual({ requests: 50_000, limit: WORKERS_FREE_DAILY, fraction: 0.5 });
    expect(r.durableObjects).toEqual({ requests: 90_000, limit: DO_FREE_DAILY, fraction: 0.9 });
    expect(r.since).toMatch(/T00:00:00\.000Z$/);
  });

  it("clamps the fraction at 1 when over the free ceiling", async () => {
    const r = await fetchUsage(
      { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" },
      new Date(),
      graphqlResponse(250_000, 0),
    );
    expect(r.workers?.requests).toBe(250_000);
    expect(r.workers?.fraction).toBe(1);
  });

  it("surfaces GraphQL errors as a thrown message", async () => {
    const errResp = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "authentication error" }] }),
        { status: 200 })) as unknown as typeof fetch;
    await expect(fetchUsage(
      { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" }, new Date(), errResp,
    )).rejects.toThrow(/authentication error/);
  });

  it("throws a helpful message when the account row is absent", async () => {
    const empty = (async () =>
      new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }),
        { status: 200 })) as unknown as typeof fetch;
    await expect(fetchUsage(
      { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" }, new Date(), empty,
    )).rejects.toThrow(/CF_ACCOUNT_ID/);
  });

  it("sums requests across grouped rows", () => {
    expect(sumRequests([{ sum: { requests: 3 } }, { sum: { requests: 4 } }])).toBe(7);
    expect(sumRequests(undefined)).toBe(0);
    expect(sumRequests([{}])).toBe(0);
  });
});
