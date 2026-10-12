import { describe, it, expect } from "vitest";
import { courseTerm, matchesTerm } from "../../src/utils/term.js";

describe("courseTerm", () => {
  it("reads the term from NYU course codes", () => {
    expect(courseTerm("FA26_CSCI-UA_473_1_001_crse")).toEqual({ code: "FA26", label: "Fall 2026" });
    expect(courseTerm("519-1254_SP25 MA-UY MATH-UA 148 3054 001 A")).toEqual({ code: "SP25", label: "Spring 2025" });
    expect(courseTerm("SU25_MATH-UA_123_6W1_001")).toEqual({ code: "SU25", label: "Summer 2025" });
  });

  it("falls back to the start date when the code has no term", () => {
    expect(courseTerm("Basic Algorithms", "2026-01-20T05:00:00.000Z")?.label).toBe("Spring 2026");
    expect(courseTerm(null, "2026-09-02T04:00:00.000Z")?.label).toBe("Fall 2026");
    expect(courseTerm(null, "2026-05-18T04:00:00.000Z")?.label).toBe("Summer 2026");
  });

  it("gives no term to an undated, uncoded org unit", () => {
    expect(courseTerm("815-50768-82595-VIP Central", null)).toBeNull();
  });
});

describe("matchesTerm", () => {
  it("accepts the code or the label in any case", () => {
    const term = courseTerm("FA26_CSCI-UA_473");
    expect(matchesTerm(term, "fa26")).toBe(true);
    expect(matchesTerm(term, "Fall  2026")).toBe(true);
    expect(matchesTerm(term, "SP26")).toBe(false);
    expect(matchesTerm(null, "FA26")).toBe(false);
  });
});
