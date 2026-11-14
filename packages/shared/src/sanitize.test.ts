import { readFileSync } from "node:fs";
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
  it("removes each invisible code point on its own (a6-text-rules-accounts, second round)", () => {
    const removed = [0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
    for (const code of removed) expect(sanitizeText(`a${String.fromCodePoint(code)}b`), code.toString(16)).toBe("ab");
    for (const code of [0x200c, 0x200d]) expect(sanitizeText(`a${String.fromCodePoint(code)}b`), code.toString(16)).toBe(`a${String.fromCodePoint(code)}b`);
  });
  it("is written with escapes, not with the invisible characters themselves (a6-text-rules-accounts, second round)", () => {
    // A class of raw bidi and zero-width characters cannot be read in review, is flagged as
    // Trojan Source, and one editor normalization could empty it without anyone seeing.
    const source = readFileSync(new URL("./sanitize.ts", import.meta.url), "utf8");
    const raw = [...source].filter((ch) => /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u.test(ch));
    expect(raw.map((ch) => ch.codePointAt(0)!.toString(16))).toEqual([]);
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
  it("leaves no '<' that could open a tag, so an unclosed tag cannot open one where HTML is set", () => {
    const name = "Savings <meta http-equiv=refresh content=0;url=/api/health?";
    expect(sanitizeText(name, 100)).toBe("Savings meta http-equiv=refresh content=0;url=/api/health?");
    // Second round: a "<" or ">" that cannot start a tag is text, and stays (see below).
    expect(sanitizeText("a < b > c <<x>> <img src=x onerror=alert(1)", 100)).toBe("a < b > c <> img src=x onerror=alert(1)");
    expect(sanitizeText("<b>KING</b> SOOPERS")).toBe("KING SOOPERS");
  });
});

/** What an HTML parser reads as the start of a tag, a comment or a declaration: "<" then a letter, "!", "/" or "?". */
const OPENS_MARKUP = /<[\p{L}!/?]/u;

describe("sanitizeText and the angle brackets people type (a6-text-rules-accounts, second round)", () => {
  it("keeps a comparison sign or an arrow that cannot start a tag", () => {
    for (const typed of ["Trim if price < 50", "ER <0.1% vs 0.03%", "Sold > 1 yr held", "TRANSFER -> SAVINGS", "a < b > c", "<= 10 shares", "<3 years", "Fund A <> Fund B", "x << y >> z"]) {
      expect(sanitizeText(typed, 2000), typed).toBe(typed);
    }
  });
  it("still leaves nothing that can open a tag, a comment or a declaration, and is stable", () => {
    const hostile = [
      ["Savings <meta http-equiv=refresh content=0;url=/api/health?", "Savings meta http-equiv=refresh content=0;url=/api/health?"],
      ["<<<<a href=//x", "a href=//x"],
      ["<!-- hidden", "!-- hidden"],
      ["</script", "/script"],
      ["<?xml version", "?xml version"],
      ["<\u200Bimg src=x onerror=alert(1)", "img src=x onerror=alert(1)"],
      ["<\u0000svg onload=alert(1)", "svg onload=alert(1)"],
      ["<\u202Eiframe", "iframe"],
      ["<<b>script>alert(1)", "script>alert(1)"],
      ["<\u00E9t\u00E9", "\u00E9t\u00E9"],
      ["price < 50 <b>bold</b> <i", "price < 50 bold i"],
    ] as const;
    for (const [input, expected] of hostile) {
      const out = sanitizeText(input, 200);
      expect(out, input).toBe(expected);
      expect(out, input).not.toMatch(OPENS_MARKUP);
      expect(sanitizeText(out, 200), input).toBe(out);
    }
    // Every '<' followed by every printable ASCII character and a few others: none is left able to open markup.
    for (let c = 0x20; c < 0x7f; c++) {
      for (const tail of ["", "x", " y"]) {
        const out = sanitizeText(`a<${String.fromCharCode(c)}${tail}`, 50);
        expect(out, `a<${String.fromCharCode(c)}${tail}`).not.toMatch(OPENS_MARKUP);
      }
    }
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
