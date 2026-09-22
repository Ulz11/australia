/**
 * Every key a screen asks for is a key the dictionaries have.
 *
 * tests/unit/i18n.test.ts checks the six dictionaries against EACH OTHER — no missing keys, no leftovers,
 * every `{gap}` preserved. That is necessary and it is not sufficient: it compares the dictionaries to one
 * another and never to the screens. `translate()` falls back to the key itself, by design, so `t("Free
 * days")` for a key that is in none of the six renders the English string and throws nothing. The suite
 * stays green and a Mongolian worker reads a screen that is half in English.
 *
 * That is not hypothetical. /worker shipped calling t() on "Owed to me", "Free days", "Bosses can see you"
 * and "Find work near me" — none of which were ever added — and it took loading the app in Mongolian to
 * see it, because every automated check passed.
 *
 * So this test reads the screens rather than the dictionaries: every literal key handed to t() / tr() must
 * exist in lib/i18n/en.ts, which is the source of truth the other five are typed against.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import en from "@/lib/i18n/en";

const SKIP = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory()
    ? (SKIP.has(e.name) ? [] : walk(path.join(d, e.name)))
    : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));

/**
 * Worker screens and the shared components they use. Boss screens are deliberately English
 * (lib/i18n/index.ts: getLang() answers "en" for a boss whatever the cookie says), so a boss-only file
 * that never calls t() is not a failure — it simply contributes no keys.
 */
const FILES = ["app", "components"].filter(fs.existsSync).flatMap(walk);

/** A double-quoted JS string literal, with escapes, as written in source. */
const LITERAL = String.raw`"((?:[^"\\]|\\.)*)"`;

/**
 * `t("…")` and the `tr("…")` alias ShiftLive uses. Deliberately only literals: a key built at runtime
 * cannot be checked here, and the codebase does not build any.
 */
const CALL = new RegExp(String.raw`\b(?:t|tr)\(\s*${LITERAL}`, "g");
/** `plural(t, n, "one", "many")` — both branches are their own key. */
const PLURAL = new RegExp(String.raw`\bplural\(\s*\w+\s*,[^,]+,\s*${LITERAL}\s*,\s*${LITERAL}`, "g");

const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

function keysIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CALL)) out.push(unescape(m[1]));
  for (const m of src.matchAll(PLURAL)) { out.push(unescape(m[1])); out.push(unescape(m[2])); }
  return out;
}

describe("every t() key is a key the dictionaries have", () => {
  it("the walk found the screens, and they really do ask for keys", () => {
    expect(FILES.length).toBeGreaterThan(40);
    const all = FILES.flatMap((f) => keysIn(fs.readFileSync(f, "utf8")));
    expect(all.length, "no t() calls found — the matcher has stopped matching").toBeGreaterThan(50);
  });

  it("knows a key when it sees one", () => {
    expect(keysIn(`t("Take it")`)).toEqual(["Take it"]);
    expect(keysIn(`tr("Clock in")`)).toEqual(["Clock in"]);
    expect(keysIn(`t("{n} hours", { n: 8 })`)).toEqual(["{n} hours"]);
    expect(keysIn(`plural(t, n, "{n} day", "{n} days")`)).toEqual(["{n} day", "{n} days"]);
    expect(keysIn(`format("not a key")`)).toEqual([]);
  });

  it("no screen asks for a key lib/i18n/en.ts does not have", () => {
    const have = new Set(Object.keys(en));
    const missing = FILES.flatMap((f) =>
      [...new Set(keysIn(fs.readFileSync(f, "utf8")))]
        .filter((k) => !have.has(k))
        .map((k) => `${f} asks for ${JSON.stringify(k)} — add it to all six files in lib/i18n`));
    expect([...new Set(missing)]).toEqual([]);
  });
});
