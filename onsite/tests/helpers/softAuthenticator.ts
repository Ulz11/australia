/**
 * A software passkey for tests: an ES256 key made with node's crypto, answering registration with a `none`
 * attestation and sign-in with a real signature — the bytes a phone would send, built by hand and nothing more.
 *
 * Every field that a test wants to get wrong on purpose (origin, rpID, challenge, counter, flags, signature) can
 * be overridden per call.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// ------------------------------------------------------------------ the little CBOR a passkey needs
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
const head = (major: number, n: number) => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
};
export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/** WebAuthn authenticator data flags. */
export const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 } as const;

export type Overrides = {
  origin?: string;
  rpID?: string;
  challenge?: string;
  type?: string;
  counter?: number;
  flags?: number;
  tamper?: boolean;
  userHandle?: string | null;
};

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly keys: { privateKey: KeyObject; publicKey: KeyObject };
  readonly synced: boolean;
  counter: number;
  userHandle: string | null = null;

  /** `counter: 0` behaves like a synced passkey (iCloud Keychain, Google Password Manager): it never counts. */
  constructor(readonly rpID: string, readonly origin: string, opts: { counter?: number; synced?: boolean } = {}) {
    this.keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.counter = opts.counter ?? 0;
    this.synced = opts.synced ?? this.counter === 0;
  }
  get id() { return b64u(this.credentialId); }

  private coseKey() {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    return cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  }

  private clientData(type: string, challenge: string, o: Overrides) {
    return Buffer.from(JSON.stringify({ type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
  }

  private authData(o: Overrides, attested: boolean) {
    const baseFlags = FLAGS.UP | FLAGS.UV | (this.synced ? FLAGS.BE | FLAGS.BS : 0) | (attested ? FLAGS.AT : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(o.counter ?? this.counter);
    const parts: Uint8Array[] = [sha256(o.rpID ?? this.rpID), Buffer.from([o.flags ?? baseFlags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey());        // AAGUID all zeros, as `none` sends
    }
    return Buffer.concat(parts);
  }

  /** navigator.credentials.create(), as @simplewebauthn/browser hands it to the server. */
  register(options: { challenge: string; user: { id: string } }, o: Overrides = {}) {
    this.userHandle = options.user.id;
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(o, true)]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, o)),
        attestationObject: b64u(attestationObject),
        transports: ["internal", "hybrid"] as ("internal" | "hybrid")[],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }

  /** navigator.credentials.get(). Counts up unless synced (or told a counter). */
  signIn(options: { challenge: string }, o: Overrides = {}) {
    if (!this.synced && o.counter === undefined) this.counter += 1;
    const authData = this.authData(o, false);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, o);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);   // DER, as ES256 passkeys send
    if (o.tamper) signature[signature.length - 1] ^= 0xff;
    const userHandle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        authenticatorData: b64u(authData),
        clientDataJSON: b64u(clientDataJSON),
        signature: b64u(signature),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }
}
