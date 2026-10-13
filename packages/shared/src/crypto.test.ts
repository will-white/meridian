import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateSecretsKey, sha256Hex } from "./crypto.js";

describe("secrets", () => {
  it("round-trips and produces a fresh IV each time", async () => {
    const key = generateSecretsKey();
    const a = await encryptSecret("https://user:pass@bridge.simplefin.org/simplefin", key);
    const b = await encryptSecret("https://user:pass@bridge.simplefin.org/simplefin", key);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(await decryptSecret(a, key)).toBe("https://user:pass@bridge.simplefin.org/simplefin");
  });
  it("rejects a wrong key or a tampered ciphertext", async () => {
    const key = generateSecretsKey();
    const ct = await encryptSecret("secret", key);
    await expect(decryptSecret(ct, generateSecretsKey())).rejects.toThrow();
    const [v, iv, body] = ct.split(".");
    const tampered = `${v}.${iv}.${body!.slice(0, -4)}AAAA`;
    await expect(decryptSecret(tampered, key)).rejects.toThrow();
  });
  it("rejects a key that is not 32 bytes", async () => {
    await expect(encryptSecret("x", btoa("short"))).rejects.toThrow(/32 bytes/);
  });
  it("hashes deterministically", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
