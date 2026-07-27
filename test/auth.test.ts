import { describe, it, expect } from "vitest";
import { computeHmac } from "../src/middleware/auth.js";

describe("HMAC auth", () => {
  it("computeHmac produces consistent results", async () => {
    const a = await computeHmac("secret123", "hello world");
    const b = await computeHmac("secret123", "hello world");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("different secrets produce different signatures", async () => {
    const a = await computeHmac("secret1", "hello");
    const b = await computeHmac("secret2", "hello");
    expect(a).not.toBe(b);
  });

  it("different messages produce different signatures", async () => {
    const a = await computeHmac("secret", "message1");
    const b = await computeHmac("secret", "message2");
    expect(a).not.toBe(b);
  });
});
