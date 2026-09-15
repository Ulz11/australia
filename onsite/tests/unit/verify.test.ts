import { describe, it, expect } from "vitest";
import { checkLicence, isExpired, namesMatch, licenceWords } from "@/lib/verify";

describe("licence checking — honest by default", () => {
  it("a state we can't check automatically is 'unchecked', never 'verified'", async () => {
    const r = await checkLicence({ kind: "WC", number: "123456", issued_state: "VIC", holder_name: "Batbayar Erdene" });
    expect(r.status).toBe("unchecked");
    expect(r.note).toMatch(/WorkSafe Victoria/);
  });
  it("NSW with no API key configured falls back to a human check, not a guess", async () => {
    delete process.env.NSW_LICENCE_API_KEY;
    const r = await checkLicence({ kind: "WC", number: "123456", issued_state: "NSW", holder_name: "Batbayar Erdene" });
    expect(r.status).toBe("unchecked");
    expect(r.via).toBe("manual");
  });
  it("an out-of-date card is caught locally, no register needed", async () => {
    const r = await checkLicence({ kind: "WC", number: "1", issued_state: "NSW", holder_name: "X Y", expires_on: "2020-01-01" });
    expect(r.status).toBe("expired");
  });
  it("isExpired only counts dates already past", () => {
    expect(isExpired("2020-06-30")).toBe(true);
    expect(isExpired("2099-01-01")).toBe(false);
    expect(isExpired(null)).toBe(false);
  });
});

describe("namesMatch — registers spell names differently", () => {
  it("matches across middle names, order and punctuation", () => {
    expect(namesMatch("BATBAYAR ERDENE", "Batbayar Erdene")).toBe(true);
    expect(namesMatch("Erdene, Batbayar B.", "Batbayar Erdene")).toBe(true);
  });
  it("does not match a different person", () => {
    expect(namesMatch("Tom Walsh", "Batbayar Erdene")).toBe(false);
  });
});

describe("licenceWords", () => {
  it("never says 'checked' for something we haven't checked", () => {
    expect(licenceWords({ status: "unchecked" }).label).toMatch(/not checked/i);
    expect(licenceWords({ status: "verified", issued_state: "NSW" }).label).toMatch(/✓/);
    expect(licenceWords({ status: "expired", expires_on: "2020-01-01" }).tone).toBe("red");
  });
});
