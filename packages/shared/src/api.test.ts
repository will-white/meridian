import { describe, expect, it } from "vitest";
import { AlertQuery, QueryBoolean } from "./api.js";

describe("QueryBoolean", () => {
  it('reads "false" and "0" as false, "true" and "1" as true, and rejects anything else', () => {
    expect(QueryBoolean.parse("false")).toBe(false);
    expect(QueryBoolean.parse("0")).toBe(false);
    expect(QueryBoolean.parse("true")).toBe(true);
    expect(QueryBoolean.parse("1")).toBe(true);
    expect(QueryBoolean.safeParse("yes").success).toBe(false);
    expect(QueryBoolean.safeParse("").success).toBe(false);
  });
});

describe("AlertQuery", () => {
  it("defaults both flags to false and keeps an explicit false (the design's GET /alerts?includeDismissed=false&includeResolved=false)", () => {
    expect(AlertQuery.parse({})).toEqual({ includeDismissed: false, includeResolved: false, limit: 100 });
    expect(AlertQuery.parse({ includeDismissed: "false", includeResolved: "false" })).toMatchObject({ includeDismissed: false, includeResolved: false });
    expect(AlertQuery.parse({ includeDismissed: "true", includeResolved: "0", kind: "missed_charge", limit: "5" })).toEqual({
      includeDismissed: true,
      includeResolved: false,
      kind: "missed_charge",
      limit: 5,
    });
  });
});
