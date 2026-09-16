/**
 * "Use my location", searches and map taps, without a browser: the rounding a worker's home gets, and the
 * names built from Nominatim's answers. The GPS itself can't be granted in a test browser, so this is the proof.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { PINNED, locationError, pinFor, placeLabel, roundCoord, searchLabel, type NominatimPlace } from "@/lib/place";

/** Shaped like https://nominatim.openstreetmap.org/reverse?format=jsonv2 for a house in Marrickville. */
const HOUSE: NominatimPlace = {
  lat: "-33.9107821", lon: "151.1552087",
  display_name: "12, Smith Street, Marrickville, Sydney, Council of the Inner West, New South Wales, 2204, Australia",
  address: {
    house_number: "12", road: "Smith Street", suburb: "Marrickville", city: "Sydney", municipality: "Council of the Inner West",
    state: "New South Wales", "ISO3166-2-lvl4": "AU-NSW", postcode: "2204", country: "Australia", country_code: "au",
  },
};

describe("where a pin is stored", () => {
  it("rounds to two decimal places — the pin moves at most ~0.55 km north–south and ~0.46 km east–west in Sydney", () => {
    expect(roundCoord(-33.9107821)).toBe(-33.91);
    expect(roundCoord(151.1552087)).toBe(151.16);
    expect(roundCoord(-33.894999)).toBe(-33.89);
    expect(roundCoord(-33.8951)).toBe(-33.9);
    const km = (dLat: number, dLng: number, lat: number) => Math.hypot(dLat * 110.57, dLng * 111.32 * Math.cos((lat * Math.PI) / 180));
    for (const [lng, lat] of [[151.155, -33.905], [151.20499, -33.86501], [150.87361, -34.42459]]) {
      const [rLng, rLat] = pinFor(lng, lat, "suburb");
      expect(km(rLat - lat, rLng - lng, lat)).toBeLessThan(0.75);
    }
  });

  it("a home is rounded, a site is not — and the same way for GPS, a map tap and a search, since all three go through pinFor", () => {
    expect(pinFor(151.1552087, -33.9107821, "suburb")).toEqual([151.16, -33.91]);
    expect(pinFor(151.1552087, -33.9107821, "exact")).toEqual([151.1552087, -33.9107821]);
    const src = fs.readFileSync("components/AddressPin.tsx", "utf8");
    expect(src.match(/\bsetPt\(/g)).toHaveLength(1);                                   // the only setter is inside place()
    expect(src).toMatch(/const p = pinFor\(lng, lat, precision\);\s*setPt\(p\)/);
    expect(src).toMatch(/useState<\[number, number\] \| null>\(initial \? pinFor\(/);    // a home loaded from the database too
    expect(src).toMatch(/place\(g\.lng, g\.lat, true\)/);                              // search
    expect(src).toMatch(/place\(coords\.longitude, coords\.latitude, true\)/);         // Use my location
    expect(src).toMatch(/onPick=\{\(lng, lat\) => place\(lng, lat, false\)\}/);        // map tap
  });

  it("the site form asks for the exact spot; both places a worker sets their home ask for the suburb", () => {
    expect(fs.readFileSync("app/boss/projects/new/page.tsx", "utf8")).toMatch(/<AddressPin[^>]*precision="exact"/);
    expect(fs.readFileSync("app/onboarding/RoleForm.tsx", "utf8")).toMatch(/<AddressPin[^>]*precision="suburb"/);
    expect(fs.readFileSync("app/worker/me/MeForm.tsx", "utf8")).toMatch(/<AddressPin[^>]*precision="suburb"/);
  });

  it("the server rounds a home again, so an old app or a hand-made form can't store an exact one", () => {
    for (const f of ["actions/auth.ts", "actions/worker.ts"])
      expect(fs.readFileSync(f, "utf8"), f).toMatch(/const \[lng, lat\] = pinFor\(Number\(form\.get\("lng"\)\), Number\(form\.get\("lat"\)\), "suburb"\)/);
  });
});

describe("naming a point from Nominatim", () => {
  it("a site gets its street address: house number, road, suburb", () => {
    expect(placeLabel(HOUSE, "exact")).toBe("12 Smith Street, Marrickville");
  });

  it("a home gets the suburb and state and nothing narrower", () => {
    const label = placeLabel(HOUSE, "suburb");
    expect(label).toBe("Marrickville NSW");
    expect(label).not.toMatch(/12|Smith/);
  });

  it("copes with the parts Nominatim leaves out or names differently", () => {
    const at = (address: Record<string, string>) => ({ address });
    expect(placeLabel(at({ road: "Parramatta Road", suburb: "Annandale", state: "New South Wales" }), "exact")).toBe("Parramatta Road, Annandale");
    expect(placeLabel(at({ house_number: "3", pedestrian: "Pitt Street Mall", suburb: "Sydney", state: "New South Wales" }), "exact")).toBe("3 Pitt Street Mall, Sydney");
    expect(placeLabel(at({ suburb: "Newtown", state: "New South Wales" }), "exact")).toBe("Newtown");
    expect(placeLabel(at({ house_number: "9", road: "Auburn Street", town: "Goulburn", state: "New South Wales" }), "suburb")).toBe("Goulburn NSW");
    expect(placeLabel(at({ village: "Bundanoon", state: "New South Wales" }), "suburb")).toBe("Bundanoon NSW");
    expect(placeLabel(at({ city: "Melbourne", state: "Victoria" }), "suburb")).toBe("Melbourne VIC");
    expect(placeLabel(at({ suburb: "Fortitude Valley" }), "suburb")).toBe("Fortitude Valley");
    expect(placeLabel(at({ suburb: "Somewhere", state: "Nowhere State" }), "suburb")).toBe("Somewhere, Nowhere State");
  });

  it("an answer with nothing usable gives null, so the box falls back to a readable label and the pin still saves", () => {
    expect(placeLabel({ error: "Unable to geocode" }, "exact")).toBeNull();
    expect(placeLabel({ error: "Unable to geocode" }, "suburb")).toBeNull();
    expect(placeLabel({ address: { state: "New South Wales", country: "Australia" } }, "suburb")).toBeNull();
    expect(placeLabel(null, "exact")).toBeNull();
    expect(PINNED).toBe("Pinned on the map");
  });

  it("a typed search keeps its wording for a site, and is cut back to the suburb for a home", () => {
    expect(searchLabel(HOUSE, "exact")).toBe("12, Smith Street, Marrickville");
    expect(searchLabel(HOUSE, "suburb")).toBe("Marrickville NSW");
    expect(searchLabel({ display_name: "2204, Australia", address: { postcode: "2204" } }, "suburb")).toBe(PINNED);
  });
});

describe("when the phone can't give a location", () => {
  it("says what to do in plain words", () => {
    expect(locationError(1)).toBe("Location is off for OnSite. Allow it in your browser settings, or type the address.");
    expect(locationError(2)).toBe("Couldn't find your location. Type the address instead.");
    expect(locationError(3)).toBe("Couldn't find your location. Type the address instead.");
  });
});
