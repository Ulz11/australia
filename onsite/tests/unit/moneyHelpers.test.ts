/**
 * Two money helpers, and only one of them is allowed to be called `money`.
 *
 * lib/award.ts `money()` takes DOLLARS — a rate, the award floor, a day's pay. lib/subscription.ts
 * `moneyCents()` takes CENTS — a price, an invoice line, the match fee. Both were called `money`, and were
 * being imported side by side under aliases, which is how the rules page came to tell bosses the
 * subscription was $3,300.00 a month for a $33 subscription (commit 8f912ee). A hundred-fold error in a
 * price still reads as a plausible number, so nothing catches it except a person who happens to look.
 *
 * The rename fixed that one screen. This test fixes the class: bring the bare name `money` back out of
 * lib/subscription anywhere in the repo and the suite goes red before a boss reads the wrong figure.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory()
    ? (SKIP.has(e.name) ? [] : walk(path.join(d, e.name)))
    : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));

// Walked from the project root, which is where vitest runs — the same walk noEmoji.test.ts uses.
const FILES = ["app", "actions", "components", "lib", "scripts", "tests"].filter(fs.existsSync).flatMap(walk);

// Both ways a file can pull names out of lib/subscription. The dynamic one is not pedantry: the launch test
// destructured `{ money: moneyCents }` out of an `await import`, which a static-only scan reads straight past.
// `[^}]` and not `[\s\S]`: an import list cannot contain a closing brace, and a lazy `[\s\S]*?` happily
// runs from an earlier import's `{` all the way down to this one's `} from ".../subscription"`, swallowing
// every name in between. That read `import { money, round2 } from "./award"` — correct, award counts
// dollars — as a subscription import of `money`, and failed the file it was written to protect.
const STATIC = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*\/subscription["']/g;
const DYNAMIC = /\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*["'][^"']*\/subscription["']/g;

/** The brace contents of every import of lib/subscription in a file. */
const subscriptionImports = (src: string): string[] =>
  [STATIC, DYNAMIC].flatMap((re) => [...src.matchAll(re)].map((m) => m[1]));

/** One imported name exactly as written: `money`, `money as cents`, `money: cents`, `type RateUsed`. */
const names = (braces: string): string[] => braces.split(",").map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);

/** `money` under any name it might be smuggled in under. `moneyCents` is not a match — the anchors see to that. */
const isBareMoney = (n: string) => /^money(?: (?:as) \w+| ?: ?\w+)?$/.test(n);

describe("nothing imports a bare `money` from lib/subscription", () => {
  it("the walk really found the repo, and the importers it is there to police", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.filter((f) => subscriptionImports(fs.readFileSync(f, "utf8")).length > 0).length).toBeGreaterThan(5);
  });

  it("knows a smuggled `money` when it sees one, and leaves `moneyCents` alone", () => {
    expect(["money", "money as cents", "money: moneyDollars"].map(isBareMoney)).toEqual([true, true, true]);
    expect(["moneyCents", "audMoney", "priceWords", "type RateUsed"].map(isBareMoney)).toEqual([false, false, false, false]);
  });

  it("no file imports `money` from lib/subscription, under that name or behind an alias", () => {
    const offenders = FILES.flatMap((f) =>
      subscriptionImports(fs.readFileSync(f, "utf8")).flatMap((braces) =>
        names(braces).filter(isBareMoney)
          .map((n) => `${f} imports "${n}" — lib/subscription counts cents, so the name is moneyCents`)));
    expect(offenders).toEqual([]);
  });

  it("and lib/subscription no longer offers the name to import in the first place", async () => {
    const subscription = await import("@/lib/subscription");
    expect(Object.keys(subscription)).not.toContain("money");
    expect(typeof subscription.moneyCents).toBe("function");
  });
});

describe("the two helpers still do their own jobs", () => {
  it("33 dollars from award, 3300 cents from subscription, the same $33.00 out", async () => {
    const { money } = await import("@/lib/award");
    const { moneyCents } = await import("@/lib/subscription");
    expect(money(33)).toBe("$33.00");
    expect(moneyCents(3300)).toBe("$33.00");
  });
});
