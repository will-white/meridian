import { describe, expect, it } from "vitest";
import { sanitizeText } from "./sanitize.js";

describe("sanitizeText", () => {
  it("strips control characters, tags and extra whitespace", () => {
    expect(sanitizeText("  KING\u0000 <script>alert(1)</script>SOOPERS\n\n#12  ")).toBe("KING alert(1)SOOPERS #12");
  });
  it("caps the length and tolerates non-strings", () => {
    expect(sanitizeText("x".repeat(500), 10)).toBe("xxxxxxxxxx");
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(42)).toBe("42");
  });
});
