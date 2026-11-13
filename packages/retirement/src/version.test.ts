import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256.js";
import { DATA_CHECKSUM, DATA_MANIFEST, DATA_VERSION, ENGINE_VERSION, dataChecksum, parseDataManifest } from "./version.js";

const MANIFEST_PATH = new URL("../data/manifest.json", import.meta.url);
const nodeSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("versions (engine-and-returns decision 31; seams §8 D1)", () => {
  it("ENGINE_VERSION is 1.0.0", () => {
    expect(ENGINE_VERSION).toBe("1.0.0");
  });

  it("D1 DATA_VERSION equals dataVersion of data/manifest.json, which starts at 2026.11.0", () => {
    const onDisk = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { dataVersion: string };
    expect(DATA_VERSION).toBe(onDisk.dataVersion);
    expect(DATA_VERSION).toBe("2026.11.0");
  });

  it("D1 DATA_CHECKSUM is the SHA-256 of the files' hashes joined by newlines in manifest order", () => {
    const onDisk = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { files: Array<{ sha256: string }> };
    expect(DATA_CHECKSUM).toBe(nodeSha256(onDisk.files.map((f) => f.sha256).join("\n")));
    expect(DATA_MANIFEST.files.map((f) => f.sha256)).toEqual(onDisk.files.map((f) => f.sha256));
  });

  it("D1 dataChecksum: order matters, no trailing newline", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const m = (hashes: string[]) =>
      parseDataManifest({ dataVersion: "2026.11.0", firstTaxYear: 2026, lastPublishedYear: 2027, files: hashes.map((sha256, i) => ({ path: `f${i}`, sha256 })) });
    expect(dataChecksum(m([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(dataChecksum(m([a, b]))).toBe(nodeSha256(`${a}\n${b}`));
    expect(dataChecksum(m([b, a]))).toBe(nodeSha256(`${b}\n${a}`));
    expect(dataChecksum(m([a, b]))).not.toBe(dataChecksum(m([b, a])));
  });

  it("parseDataManifest keeps the optional provenance fields and refuses malformed manifests", () => {
    const ok = parseDataManifest({
      dataVersion: "2026.11.0",
      firstTaxYear: 2026,
      lastPublishedYear: 2027,
      files: [{ path: "x.csv", sha256: "0".repeat(64), sourceUrl: "https://example.invalid/x", retrieved: "2026-11-10", description: "x" }],
    });
    expect(ok.files[0]).toEqual({ path: "x.csv", sha256: "0".repeat(64), sourceUrl: "https://example.invalid/x", retrieved: "2026-11-10", description: "x" });
    const base = { dataVersion: "2026.11.0", firstTaxYear: 2026, lastPublishedYear: 2027, files: [] as unknown[] };
    expect(() => parseDataManifest(null)).toThrow(/not an object/);
    expect(() => parseDataManifest({ ...base, dataVersion: "v1" })).toThrow(/dataVersion/);
    expect(() => parseDataManifest({ ...base, firstTaxYear: 2026.5 })).toThrow(/firstTaxYear/);
    expect(() => parseDataManifest({ ...base, lastPublishedYear: "2027" })).toThrow(/lastPublishedYear/);
    expect(() => parseDataManifest({ ...base, files: {} })).toThrow(/files must be an array/);
    expect(() => parseDataManifest({ ...base, files: [{ path: "a", sha256: "ABC" }] })).toThrow(/sha256/);
    expect(() => parseDataManifest({ ...base, files: [{ path: "", sha256: "0".repeat(64) }] })).toThrow(/path/);
    expect(() =>
      parseDataManifest({ ...base, files: [{ path: "a", sha256: "0".repeat(64) }, { path: "a", sha256: "1".repeat(64) }] }),
    ).toThrow(/listed twice/);
    expect(() => parseDataManifest({ ...base, files: [{ path: "a", sha256: "0".repeat(64), retrieved: 20261110 }] })).toThrow(/retrieved/);
  });
});

describe("sha256Hex (FIPS 180-4)", () => {
  it("published test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("agrees with node:crypto at every padding boundary and on non-ASCII text", () => {
    for (let n = 0; n <= 130; n++) expect(sha256Hex("x".repeat(n))).toBe(nodeSha256("x".repeat(n)));
    for (const s of ["€ ü 日本 😀", "\u0000\u007f\u0080߿ࠀ￿", "a\nb\r\n"]) expect(sha256Hex(s)).toBe(nodeSha256(s));
    const long = "0123456789abcdef".repeat(4096);
    expect(sha256Hex(long)).toBe(nodeSha256(long));
  });
});
