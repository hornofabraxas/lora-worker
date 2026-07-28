import { describe, it, expect } from "vitest";
import { compareVersions, isVersionAtLeast } from "../src/logic/version.js";

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });

  it("treats a missing trailing segment as 0", () => {
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.1", "0.2")).toBeGreaterThan(0);
  });

  it("ignores a leading v and a build/prerelease suffix", () => {
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0+unknown", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0-rc1", "0.2.0")).toBe(0);
  });

  it("treats an unparsable string as version 0", () => {
    expect(compareVersions("garbage", "0.0.1")).toBeLessThan(0);
    expect(compareVersions("0.0.0", "garbage")).toBe(0);
  });
});

describe("isVersionAtLeast", () => {
  it("passes a client at or above the floor", () => {
    expect(isVersionAtLeast("0.3.0", "0.3.0")).toBe(true);
    expect(isVersionAtLeast("0.3.1", "0.3.0")).toBe(true);
    expect(isVersionAtLeast("1.0.0", "0.3.0")).toBe(true);
  });

  it("fails a client below the floor", () => {
    expect(isVersionAtLeast("0.2.0", "0.3.0")).toBe(false);
  });

  it("fails a missing version once a floor is set — can't tell 'pre-reporting client' from 'stripped header'", () => {
    expect(isVersionAtLeast(null, "0.3.0")).toBe(false);
    expect(isVersionAtLeast(undefined, "0.3.0")).toBe(false);
    expect(isVersionAtLeast("", "0.3.0")).toBe(false);
  });
});
