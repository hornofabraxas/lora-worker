import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";

let env: Env;

beforeEach(() => {
  env = makeEnv();
});

function register(name = "P", ip?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return app.fetch(
    new Request("http://localhost/api/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ display_name: name }),
    }),
    env,
  );
}

describe("registration caps (opt-in)", () => {
  it("are off by default — many registrations all succeed", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await register(`P${i}`)).status).toBe(201);
    }
  });

  it("MAX_TOTAL_PLAYERS closes registration once the roster is full", async () => {
    env.MAX_TOTAL_PLAYERS = "2";
    expect((await register("A")).status).toBe(201);
    expect((await register("B")).status).toBe(201);
    const third = await register("C");
    expect(third.status).toBe(403);
    expect((await third.json() as { error: string }).error).toMatch(/roster full/i);
  });

  it("REGISTER_DAILY_LIMIT caps registrations per UTC day", async () => {
    env.REGISTER_DAILY_LIMIT = "2";
    expect((await register("A")).status).toBe(201);
    expect((await register("B")).status).toBe(201);
    expect((await register("C")).status).toBe(429);
  });

  it("REGISTER_IP_DAILY_LIMIT caps per client IP, independently per IP", async () => {
    env.REGISTER_IP_DAILY_LIMIT = "1";
    expect((await register("A", "203.0.113.7")).status).toBe(201);
    // Same IP again → blocked.
    expect((await register("B", "203.0.113.7")).status).toBe(429);
    // A different IP is unaffected.
    expect((await register("C", "203.0.113.8")).status).toBe(201);
  });

  it("skips the per-IP cap when CF-Connecting-IP is absent", async () => {
    env.REGISTER_IP_DAILY_LIMIT = "1";
    // No IP header on either request → per-IP cap can't be keyed, so both pass.
    expect((await register("A")).status).toBe(201);
    expect((await register("B")).status).toBe(201);
  });
});
