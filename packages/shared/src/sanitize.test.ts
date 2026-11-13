import { describe, expect, it } from "vitest";
import { errorMessageText, sanitizeText } from "./sanitize.js";

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

describe("sanitizeText and invisible formatting (a4-sync-parse-16)", () => {
  it("strips bidirectional overrides, embeddings, isolates and zero-width characters", () => {
    // U+202E would show "00.005$" as "$500.00".
    expect(sanitizeText("REFUND \u202E00.005$ \u200Bx\u2066y\u2069 \u200E\u200F\u202A\u202B\u202C\u202D\u2060\uFEFF\u061Cz")).toBe("REFUND 00.005$ xy z");
  });
  it("keeps the joiners that emoji and some scripts need", () => {
    expect(sanitizeText("\u{1F468}\u200D\u{1F469} caf\u00E9 \u0645\u200C\u0646")).toBe("\u{1F468}\u200D\u{1F469} caf\u00E9 \u0645\u200C\u0646");
  });
});

describe("errorMessageText (a4-sync-parse-11)", () => {
  it("sanitizes and bounds an error's message before it is stored for display", () => {
    const text = errorMessageText(new Error(`Not a money amount: "<b>${"x".repeat(5000)}</b>"`));
    expect(text).toBe(`Not a money amount: "${"x".repeat(279)}`);
    expect(text.length).toBe(300);
    expect(errorMessageText("plain <i>string</i>")).toBe("plain string");
    expect(errorMessageText({ weird: true })).toBe("[object Object]");
  });
});

describe("sanitizeText and markup that is not a complete tag (a6-text-rules-accounts-01)", () => {
  it("leaves no angle bracket behind, so an unclosed tag cannot open one where HTML is set", () => {
    const name = "Savings <meta http-equiv=refresh content=0;url=/api/health?";
    expect(sanitizeText(name, 100)).toBe("Savings meta http-equiv=refresh content=0;url=/api/health?");
    expect(sanitizeText("a < b > c <<x>> <img src=x onerror=alert(1)", 100)).toBe("a c img src=x onerror=alert(1)");
    expect(sanitizeText("<b>KING</b> SOOPERS")).toBe("KING SOOPERS");
  });
});

describe("sanitizeText on enormous fields (a6-text-rules-accounts-11)", () => {
  it("takes linear time on long runs of '<' and cuts before any pattern runs", () => {
    for (const text of ["<".repeat(300_000), `<${"a".repeat(300_000)}`, "<a".repeat(150_000), ` ${"\u0000".repeat(300_000)}x`]) {
      const t0 = performance.now();
      const out = sanitizeText(text, 500);
      expect(performance.now() - t0).toBeLessThan(100);
      expect(out.length).toBeLessThanOrEqual(500);
    }
    expect(sanitizeText("x".repeat(1_000_000), 500)).toBe("x".repeat(500));
  });
  it("never cuts a surrogate pair in half", () => {
    const out = sanitizeText(`${"x".repeat(9)}\u{1F600}`, 10);
    expect(out).toBe("x".repeat(9));
  });
});

describe("sanitizeText and Unicode normalization (a6-text-rules-accounts-17)", () => {
  it("stores one spelling (NFC) of an accented letter", () => {
    expect(sanitizeText("Café Rio")).toBe("Café Rio");
    expect(sanitizeText("Café Rio")).toBe(sanitizeText("Café Rio"));
  });
});
