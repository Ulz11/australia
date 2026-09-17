/**
 * Face ID / fingerprint sign-in, the parts that need no database: who we are to the browser (and when we refuse to
 * be anyone), what a device is called, and the account name a phone's passkey list shows.
 */
import { describe, it, expect } from "vitest";
import { deviceLabel, maskedPhone, passkeyDisplayName, passkeyUserName, relyingParty, userHandle, userHandleB64 } from "@/lib/passkeys";
import { ceremonyEnd, unlockWords } from "@/lib/passkeyClient";

describe("the relying party comes from the site's own address", () => {
  it("rpID is the hostname of NEXT_PUBLIC_BASE_URL and the only origin is that URL's", () => {
    expect(relyingParty({ NEXT_PUBLIC_BASE_URL: "https://onsite-au.vercel.app", NODE_ENV: "production" }))
      .toEqual({ rpID: "onsite-au.vercel.app", origin: "https://onsite-au.vercel.app", rpName: "OnSite" });
    // a path, a trailing slash or capitals change nothing: the origin is scheme + host (+ port)
    expect(relyingParty({ NEXT_PUBLIC_BASE_URL: " https://OnSite-AU.vercel.app/login/ ", NODE_ENV: "production" }))
      .toEqual({ rpID: "onsite-au.vercel.app", origin: "https://onsite-au.vercel.app", rpName: "OnSite" });
    expect(relyingParty({ NEXT_PUBLIC_BASE_URL: "https://staging.example.com.au:8443", NODE_ENV: "production" }))
      .toEqual({ rpID: "staging.example.com.au", origin: "https://staging.example.com.au:8443", rpName: "OnSite" });
  });

  it("localhost over plain http works under next dev only", () => {
    expect(relyingParty({ NEXT_PUBLIC_BASE_URL: "http://localhost:3000", NODE_ENV: "development" }))
      .toEqual({ rpID: "localhost", origin: "http://localhost:3000", rpName: "OnSite" });
    for (const NODE_ENV of ["production", "test", undefined]) expect(relyingParty({ NEXT_PUBLIC_BASE_URL: "http://localhost:3000", NODE_ENV }), NODE_ENV).toBeNull();
  });

  it("WEBAUTHN_RP_ID overrides the rpID — the host itself or a parent domain of it, nothing else", () => {
    const base = { NEXT_PUBLIC_BASE_URL: "https://app.onsite.com.au", NODE_ENV: "production" };
    expect(relyingParty({ ...base, WEBAUTHN_RP_ID: "onsite.com.au" })).toEqual({ rpID: "onsite.com.au", origin: "https://app.onsite.com.au", rpName: "OnSite" });
    expect(relyingParty({ ...base, WEBAUTHN_RP_ID: " APP.onsite.com.au " })?.rpID).toBe("app.onsite.com.au");
    expect(relyingParty({ ...base, WEBAUTHN_RP_ID: "" })?.rpID).toBe("app.onsite.com.au");
    for (const bad of ["evil.com", "other.onsite.com.au", "nsite.com.au", "com.au.evil"])
      expect(relyingParty({ ...base, WEBAUTHN_RP_ID: bad }), bad).toBeNull();
  });

  it("fails closed: no base URL, one that isn't a URL, or one that isn't https outside development", () => {
    for (const NEXT_PUBLIC_BASE_URL of [undefined, "", "   ", "onsite-au.vercel.app", "not a url", "ftp://onsite-au.vercel.app", "http://onsite-au.vercel.app"])
      expect(relyingParty({ NEXT_PUBLIC_BASE_URL, NODE_ENV: "production" }), String(NEXT_PUBLIC_BASE_URL)).toBeNull();
    expect(relyingParty({})).toBeNull();
    expect(relyingParty({ NEXT_PUBLIC_BASE_URL: "ftp://localhost", NODE_ENV: "development" })).toBeNull();
  });
});

describe("what Me calls a device", () => {
  const UA = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.7258.76 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
    android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
    androidTablet: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    samsung: "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
    chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    linux: "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
  };

  it("in plain words, from the user agent", () => {
    expect(deviceLabel(UA.iphone)).toBe("iPhone");
    expect(deviceLabel(UA.iphoneChrome)).toBe("iPhone");
    expect(deviceLabel(UA.ipad)).toBe("iPad");
    expect(deviceLabel(UA.android)).toBe("Android phone");
    expect(deviceLabel(UA.samsung)).toBe("Android phone");
    expect(deviceLabel(UA.androidTablet)).toBe("Android tablet");
    expect(deviceLabel(UA.mac)).toBe("Mac");
    expect(deviceLabel(UA.windows)).toBe("Windows PC");
    expect(deviceLabel(UA.chromebook)).toBe("Chromebook");
    expect(deviceLabel(UA.linux)).toBe("Linux computer");
    expect(deviceLabel("")).toBe("Phone or computer");
    expect(deviceLabel("curl/8.7.1")).toBe("Phone or computer");
  });

  it("an iPad asking for the desktop site is still an iPad, going by its touch screen", () => {
    expect(deviceLabel(UA.ipadDesktop, { touch: true })).toBe("iPad");
    expect(deviceLabel(UA.ipadDesktop, { touch: false })).toBe("Mac");
    expect(deviceLabel(UA.ipadDesktop)).toBe("Mac");
  });

  it("the sign-in words follow the phone: Face ID on Apple, fingerprint on Android, both elsewhere", () => {
    expect(unlockWords(UA.iphone)).toBe("Face ID");
    expect(unlockWords(UA.android)).toBe("your fingerprint");
    expect(unlockWords(UA.windows)).toBe("Face ID or fingerprint");
  });
});

describe("the account name a phone's passkey list shows", () => {
  const PHONES = ["+61400000101", "+61412345678", "+61498765432", "+97699112233", "+14155550123"];
  const spellings = (e164: string) => {
    const d = e164.replace(/\D/g, "");
    const local = d.startsWith("61") ? `0${d.slice(2)}` : d;
    return [e164, d, local, d.slice(-9), local.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3")];
  };
  const digitsOf = (s: string) => s.replace(/\D/g, "");

  it("is the name and a masked number: 'Batbayar · 04•• ••• 101'", () => {
    expect(passkeyUserName({ name: "Batbayar", phone: "+61400000101" })).toBe("Batbayar · 04•• ••• 101");
    expect(passkeyUserName({ name: "  Dave Carter ", phone: "+61412345678" })).toBe("Dave Carter · 04•• ••• 678");
    expect(passkeyUserName({ name: null, phone: "+61412345678" })).toBe("04•• ••• 678");
    expect(passkeyUserName({ name: "", phone: "+61412345678" })).toBe("04•• ••• 678");
    expect(passkeyUserName({ name: "Enkh", phone: "+97699112233" })).toBe("Enkh · •••• 233");
    expect(passkeyDisplayName({ name: "Batbayar", phone: "+61400000101" })).toBe("Batbayar");
    expect(passkeyDisplayName({ name: null, phone: "+61400000101" })).toBe("04•• ••• 101");
    expect(maskedPhone("+61400000101")).toBe("04•• ••• 101");
  });

  it("never contains the full phone number, in any spelling — even when someone typed it as their name", () => {
    for (const phone of PHONES) {
      for (const name of [null, "Batbayar", phone, `Call me ${phone.replace("+61", "0")}`, `Dave ${digitsOf(phone).slice(-9)}`]) {
        for (const shown of [passkeyUserName({ name, phone }), passkeyDisplayName({ name, phone })]) {
          for (const s of spellings(phone)) expect(shown, `${name} / ${phone}`).not.toContain(s);
          // at most the last three digits of the number survive, whatever else the name holds
          expect(digitsOf(shown).includes(digitsOf(phone).slice(-9)), shown).toBe(false);
        }
      }
    }
  });

  it("the passkey's user id is the 16 bytes of the random users.id — opaque, stable, never the phone", () => {
    const id = "3f2c1a9e-7b44-4d1e-9c0a-5e6f7a8b9c0d";
    expect(userHandle(id)).toEqual(new Uint8Array(Buffer.from("3f2c1a9e7b444d1e9c0a5e6f7a8b9c0d", "hex")));
    expect(userHandle(id).byteLength).toBe(16);
    expect(userHandleB64(id)).toBe(Buffer.from("3f2c1a9e7b444d1e9c0a5e6f7a8b9c0d", "hex").toString("base64url"));
    expect(userHandleB64(id)).toBe(userHandleB64(id));
  });
});

describe("how a browser ceremony ended, in the words we show", () => {
  const dom = (name: string) => Object.assign(new Error("x"), { name });
  it("sorts what @simplewebauthn/browser throws", () => {
    expect(ceremonyEnd({ code: "ERROR_CEREMONY_ABORTED", name: "WebAuthnError", cause: dom("AbortError") })).toBe("aborted");
    expect(ceremonyEnd({ code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", name: "WebAuthnError", cause: dom("NotAllowedError") })).toBe("cancelled");
    expect(ceremonyEnd({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", name: "WebAuthnError", cause: dom("InvalidStateError") })).toBe("exists");
    expect(ceremonyEnd(dom("NotAllowedError"))).toBe("cancelled");
    expect(ceremonyEnd(new Error("WebAuthn is not supported in this browser"))).toBe("other");
    expect(ceremonyEnd(null)).toBe("other");
  });
});
