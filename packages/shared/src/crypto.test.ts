import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateSecretsKey, placeholderSecretProblem, secretsKeyProblem, sha256Hex } from "./crypto.js";

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

describe("SECRETS_KEY checks (audit a7-backup-deploy-secrets-06, -17)", () => {
  it("secretsKeyProblem accepts 32 bytes of base64 and says what is wrong with anything else", () => {
    expect(secretsKeyProblem(generateSecretsKey())).toBeNull();
    expect(secretsKeyProblem("not-base64-at-all!!")).toMatch(/this value is not base64$/);
    expect(secretsKeyProblem("ab".repeat(32))).toMatch(/decodes to 48 bytes \(it looks like hex/);
    expect(secretsKeyProblem("MDEyMzQ1Njc4OWFiY2RlZg==", "SECRETS_KEY_OLD")).toMatch(/^SECRETS_KEY_OLD must be 32 random bytes in base64 \(openssl rand -base64 32\); this one decodes to 16 bytes$/);
  });

  it("a wrong key's decryption error says what it means", async () => {
    const ct = await encryptSecret("x", generateSecretsKey());
    await expect(decryptSecret(ct, generateSecretsKey())).rejects.toThrow("A stored secret could not be decrypted with SECRETS_KEY: the key is not the one it was encrypted with, or the value is damaged");
  });

  it("placeholderSecretProblem names the .env.example placeholders", () => {
    expect(placeholderSecretProblem("POSTGRES_PASSWORD", "change-me")).toContain('POSTGRES_PASSWORD is the .env.example placeholder "change-me"');
    expect(placeholderSecretProblem("SESSION_SECRET", "change-me-to-64-random-hex-chars")).not.toBeNull();
    expect(placeholderSecretProblem("POSTGRES_PASSWORD", "a-real-one")).toBeNull();
    expect(placeholderSecretProblem("POSTGRES_PASSWORD", undefined)).toBeNull();
  });
});
