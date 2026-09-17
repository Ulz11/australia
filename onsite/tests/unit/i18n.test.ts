/**
 * The worker side in six languages (lib/i18n). No database, no browser.
 *
 * The one rule that keeps a translated screen from being half English: every dictionary has exactly the keys
 * English has — no missing ones, and none left behind after a key is renamed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LANGS, LANG_CODES, fromAcceptLanguage, isLang, plural, translate, type Lang } from "@/lib/i18n";
import en from "@/lib/i18n/en";
import mn from "@/lib/i18n/mn";
import ne from "@/lib/i18n/ne";
import pt from "@/lib/i18n/pt";
import es from "@/lib/i18n/es";
import zh from "@/lib/i18n/zh";

const DICTS: Record<Lang, Record<string, string>> = { en, mn, ne, pt, es, zh };

describe("the dictionaries", () => {
  it("cover exactly the same keys, in every language", () => {
    const keys = Object.keys(en).sort();
    expect(keys.length).toBeGreaterThan(200);
    for (const lang of LANG_CODES) {
      const theirs = Object.keys(DICTS[lang]).sort();
      expect(theirs.filter((k) => !keys.includes(k)), `${lang} has keys English doesn't`).toEqual([]);
      expect(keys.filter((k) => !theirs.includes(k)), `${lang} is missing keys`).toEqual([]);
    }
  });

  it("English is its own key, and nothing is left blank", () => {
    for (const [k, v] of Object.entries(en)) expect(v, k).toBe(k);
    for (const lang of LANG_CODES)
      for (const [k, v] of Object.entries(DICTS[lang])) expect(v.trim(), `${lang}: ${k}`).not.toBe("");
  });

  it("keeps every {gap} a sentence needs, so a name or a number can't go missing", () => {
    const gaps = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const lang of LANG_CODES)
      for (const [k, v] of Object.entries(DICTS[lang]))
        expect(gaps(v), `${lang}: ${k}`).toEqual(gaps(k));
  });

  it("leaves the words that are names alone", () => {
    // These are what is printed on the card, the phone or the invoice. Translating them helps nobody.
    for (const lang of LANG_CODES)
      for (const [k, v] of Object.entries(DICTS[lang]))
        for (const name of ["OnSite", "Face ID", "White Card", "QPay", "ABN", "Building Award"])
          if (k.includes(name)) expect(v, `${lang}: ${k}`).toContain(name);
  });

  it("every language is listed in its own name", () => {
    expect(LANGS).toEqual({ en: "English", mn: "Монгол", ne: "नेपाली", pt: "Português", es: "Español", zh: "中文" });
    expect(isLang("mn")).toBe(true);
    expect(isLang("ar")).toBe(false);                      // not this round: it needs right-to-left
    expect(isLang(undefined)).toBe(false);
  });
});

describe("filling the gaps in a sentence", () => {
  it("puts the value wherever the translation put the gap, and leaves an unknown key readable", () => {
    expect(translate(mn, "G'day, {name}", { name: "Батбаяр" })).toBe("Сайн байна уу, Батбаяр");
    expect(translate({}, "G'day, {name}", { name: "Dave" })).toBe("G'day, Dave");
    expect(translate(mn, "a key nobody has translated")).toBe("a key nobody has translated");
    expect(translate(mn, "{n} hours", { n: 8 })).toBe("8 цаг");
  });

  it("one or many are separate sentences, so a language can do what its own grammar needs", () => {
    const t = (k: string, v?: Record<string, string | number>) => translate(en, k, v);
    expect(plural(t, 1, "{n} shift you could take", "{n} shifts you could take")).toBe("1 shift you could take");
    expect(plural(t, 4, "{n} shift you could take", "{n} shifts you could take")).toBe("4 shifts you could take");
  });
});

describe("what language a new visitor gets", () => {
  it("the first one the browser asks for that OnSite has, matched on the base code", () => {
    expect(fromAcceptLanguage("mn-MN,mn;q=0.9,en;q=0.8")).toBe("mn");
    expect(fromAcceptLanguage("pt-BR,pt;q=0.9")).toBe("pt");
    expect(fromAcceptLanguage("zh-Hans-CN,zh;q=0.9")).toBe("zh");
    expect(fromAcceptLanguage("ar-AE,ar;q=0.9,ne;q=0.8")).toBe("ne");     // Arabic isn't here yet; Nepali is
    expect(fromAcceptLanguage("fr-FR,fr;q=0.9")).toBe("en");
    expect(fromAcceptLanguage("")).toBe("en");
    expect(fromAcceptLanguage(null)).toBe("en");
  });
});

/**
 * tests/unit/noEmoji.test.ts walks the source for pictographic characters. Cyrillic, Devanagari and Chinese
 * are letters, not pictures — this is the check that the guard can tell the difference, because if it can't,
 * the honest fix would look like dropping the languages.
 */
describe("the no-emoji guard and other people's alphabets", () => {
  it("does not mistake Mongolian, Nepali or Chinese writing for an emoji", () => {
    const pictographic = /\p{Extended_Pictographic}/u;
    for (const lang of LANG_CODES)
      for (const [k, v] of Object.entries(DICTS[lang])) {
        const m = pictographic.exec(v);
        expect(m?.[0], `${lang}: ${k}`).toBeUndefined();
      }
    expect(pictographic.test("Сайн байна уу")).toBe(false);
    expect(pictographic.test("नमस्ते")).toBe(false);
    expect(pictographic.test("你好，工地")).toBe(false);
    expect(pictographic.test("₮ · — …")).toBe(false);
  });

  it("the language files themselves pass the same walk the screens do", () => {
    const pictographic = /\p{Extended_Pictographic}/u;
    const dir = "lib/i18n";
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBe(8);                          // six languages, plus index.ts and server.ts
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(pictographic.exec(src)?.[0], f).toBeUndefined();
    }
  });
});
