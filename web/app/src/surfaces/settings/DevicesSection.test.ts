import { describe, expect, it } from "vitest";
import { normaliseCode } from "./DevicesSection.tsx";

describe("the code the CLI shows", () => {
  it("is read however it is typed", () => {
    for (const raw of ["BCDF-GHJK", "bcdf-ghjk", "bcdfghjk", " bcdf ghjk "]) expect(normaliseCode(raw), raw).toBe("BCDF-GHJK");
  });

  it("is only ever letters the gate draws codes from", () => {
    // The gate uses no vowels and no digits, so these can never be a code.
    for (const raw of ["ABCD-1234", "BCDF-GHJ1", "BCDF-GHJA", "BCDF-GHJ", "BCDF-GHJKL"]) expect(normaliseCode(raw), raw).toBeNull();
  });
});
