/**
 * AES-256-GCM for secrets at rest (SimpleFIN Access URLs, setup tokens, TOTP secrets).
 * Uses Web Crypto so the same code runs in Node and in tests. The key is 32 bytes,
 * base64-encoded, supplied by SECRETS_KEY (or a Docker secret file). It never
 * touches the database or backups.
 *
 * Ciphertext format: `v1.<iv base64>.<ciphertext+tag base64>`
 */

const subtle = globalThis.crypto.subtle;

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Why `key` cannot be SECRETS_KEY, or null when it is 32 bytes of standard base64 (audit
 * a7-backup-deploy-secrets-06). Both the API and the worker check it at start-up, so a wrong
 * kind of key stops them with this message instead of failing the first sign-in or sync.
 */
export function secretsKeyProblem(key: string, name = "SECRETS_KEY"): string | null {
  const text = key.trim();
  const advice = `${name} must be 32 random bytes in base64 (openssl rand -base64 32)`;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return `${advice}; this value is not base64`;
  const bytes = atob(text).length;
  if (bytes === 32) return null;
  const hex = /^[0-9a-f]+$/i.test(text) ? " (it looks like hex: openssl rand -hex makes a different kind of key)" : "";
  return `${advice}; this one decodes to ${bytes} bytes${hex}`;
}

/** Values from .env.example that must never run in production (audit a7-backup-deploy-secrets-17). */
export const PLACEHOLDER_SECRETS: readonly string[] = ["change-me", "change-me-to-64-random-hex-chars"];

/** The error to stop on when `value` (named `name`) is an .env.example placeholder, else null. */
export function placeholderSecretProblem(name: string, value: string | undefined): string | null {
  return value !== undefined && PLACEHOLDER_SECRETS.includes(value.trim()) ? `${name} is the .env.example placeholder "${value.trim()}"; set a real secret in .env before running in production` : null;
}

/** A decryption failure says what it most likely means instead of Web Crypto's "operation-specific reason". */
export class SecretDecryptError extends Error {
  constructor() {
    super("A stored secret could not be decrypted with SECRETS_KEY: the key is not the one it was encrypted with, or the value is damaged");
    this.name = "SecretDecryptError";
  }
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64decode(keyB64.trim());
  if (raw.length !== 32) throw new Error("SECRETS_KEY must decode to exactly 32 bytes");
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decryptSecret(ciphertext: string, keyB64: string): Promise<string> {
  const [version, ivB64, ctB64] = ciphertext.split(".");
  if (version !== "v1" || !ivB64 || !ctB64) throw new Error("Unrecognized ciphertext format");
  const key = await importKey(keyB64);
  let pt: ArrayBuffer;
  try {
    pt = await subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivB64) }, key, b64decode(ctB64));
  } catch {
    throw new SecretDecryptError();
  }
  return new TextDecoder().decode(pt);
}

/** Generate a fresh base64 key suitable for SECRETS_KEY. */
export function generateSecretsKey(): string {
  return b64encode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
