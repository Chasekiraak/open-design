import { describe, expect, it } from "vitest";

import { resolvePackagedAmrProfile } from "../src/config.js";

describe("resolvePackagedAmrProfile", () => {
  it("accepts a whitespace-trimmed feature-test profile", () => {
    expect(resolvePackagedAmrProfile(" feature-test ")).toBe("feature-test");
  });

  it("maps empty values to null", () => {
    expect(resolvePackagedAmrProfile(undefined)).toBeNull();
    expect(resolvePackagedAmrProfile("   ")).toBeNull();
  });

  it("rejects unsupported profiles", () => {
    expect(() => resolvePackagedAmrProfile("staging")).toThrow(
      "unsupported packaged AMR profile; expected prod, test, feature-test, or local: staging",
    );
  });
});
