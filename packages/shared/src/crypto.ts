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
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivB64) }, key, b64decode(ctB64));
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
