import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * A software passkey for the API tests (audit a10-conformance-ledger-09): an ES256 key pair
 * that answers WebAuthn options the way a platform authenticator does, with "none"
 * attestation. Only what the server checks is modelled: the client data, the authenticator
 * data (RP id hash, flags, counter, the attested credential) and the signature.
 */

const b64url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

/** CBOR (RFC 8949) for what an attestation object holds: unsigned and negative integers, byte and text strings, maps. */
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

export interface SoftPasskeyOptions {
  origin: string;
  /** Flags the authenticator reports; user verification on by default. */
  userVerified?: boolean;
}

export class SoftPasskey {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  counter = 0;
  userHandle: string | null = null;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private authData(rpId: string, flags: number, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      const coseKey = new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(this.publicJwk.x, "base64url"))],
        [-3, new Uint8Array(Buffer.from(this.publicJwk.y, "base64url"))],
      ]);
      parts.push(Buffer.alloc(16), idLength, this.credentialId, cbor(coseKey));
    }
    return Buffer.concat(parts);
  }

  /** The answer to registration options (`navigator.credentials.create()`). */
  register(options: { challenge: string; rp: { id: string }; user: { id: string } }, opts: SoftPasskeyOptions) {
    this.userHandle = options.user.id;
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: opts.origin, crossOrigin: false });
    const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04) | 0x40; // UP, UV, AT
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(this.authData(options.rp.id, flags, true))]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }

  /** The answer to authentication options (`navigator.credentials.get()`); the counter moves on unless `counter` says otherwise. */
  answer(options: { challenge: string; rpId: string }, opts: SoftPasskeyOptions & { counter?: number; tamper?: boolean; userHandle?: string }) {
    this.counter = opts.counter ?? this.counter + 1;
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: opts.origin, crossOrigin: false });
    const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04);
    const authenticatorData = this.authData(options.rpId, flags, false);
    let signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    if (opts.tamper) signature = sign("sha256", Buffer.from("something else"), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...((opts.userHandle ?? this.userHandle) ? { userHandle: opts.userHandle ?? this.userHandle! } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }
}
