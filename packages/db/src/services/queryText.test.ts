import { describe, expect, it } from "vitest";
import { containsPattern, decodeCursor, encodeCursor } from "./queryText.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("containsPattern", () => {
  it("wraps the text in % and matches the caller's %, _ and \\ literally", () => {
    expect(containsPattern("coffee")).toBe("%coffee%");
    expect(containsPattern("100%")).toBe("%100\\%%");
    expect(containsPattern("_")).toBe("%\\_%");
    expect(containsPattern("a\\b")).toBe("%a\\\\b%");
    expect(containsPattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
    expect(containsPattern("")).toBe("%%");
  });
});

describe("keyset cursors", () => {
  it("round-trips the fields a list page ended on", () => {
    expect(decodeCursor(encodeCursor(["2026-11-10", ID]), ["date", "uuid"])).toEqual(["2026-11-10", ID]);
    expect(decodeCursor(encodeCursor(["2026-11-10", 12, ID]), ["date", "int", "uuid"])).toEqual(["2026-11-10", "12", ID]);
    expect(decodeCursor(encodeCursor(["2026-11-10 16:35:52.123456+00", ID]), ["timestamp", "uuid"])).toEqual(["2026-11-10 16:35:52.123456+00", ID]);
    expect(decodeCursor(encodeCursor(["2026-11-10 16:35:52+05:30", ID]), ["timestamp", "uuid"])).toEqual(["2026-11-10 16:35:52+05:30", ID]);
    expect(encodeCursor(["2026-11-10", ID])).toBe(b64(`2026-11-10|${ID}`));
  });

  it("refuses anything this server did not issue", () => {
    const refused: Array<[string, Parameters<typeof decodeCursor>[1]]> = [
      [b64("x|y"), ["date", "uuid"]],
      [b64(`2026-02-31|${ID}`), ["date", "uuid"]], // not a calendar date
      [b64("2026-01-01|'; drop table x; --"), ["date", "uuid"]],
      [b64(`2026-01-01|${ID}|extra`), ["date", "uuid"]], // too many fields
      [b64("2026-01-01"), ["date", "uuid"]], // too few
      [b64(`2026-01-01|${ID}`) + "=", ["date", "uuid"]], // padded: not the canonical encoding
      [`${b64(`2026-01-01|${ID}`)} `, ["date", "uuid"]],
      ["\u0000\u0000", ["date", "uuid"]],
      ["", ["date", "uuid"]],
      [b64(`2026-01-01|1.5|${ID}`), ["date", "int", "uuid"]],
      [b64(`2026-01-01|99999999999|${ID}`), ["date", "int", "uuid"]], // does not fit an integer column
      [b64(`2026-01-01|NaN|${ID}`), ["date", "int", "uuid"]],
      [b64(`2026-01-01 25:00:00+00|${ID}`), ["timestamp", "uuid"]],
      [b64(`2026-02-30 10:00:00+00|${ID}`), ["timestamp", "uuid"]],
      [b64(`2026-01-01T10:00:00Z|${ID}`), ["timestamp", "uuid"]],
      [b64(`2026-01-01|${ID}`), ["timestamp", "uuid"]],
    ];
    for (const [cursor, fields] of refused) expect(decodeCursor(cursor, fields), JSON.stringify(cursor)).toBeUndefined();
  });
});
