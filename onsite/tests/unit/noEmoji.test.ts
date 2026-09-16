/**
 * One icon set, drawn, never typed.
 *
 * An emoji is a different picture on every phone, it can't take the app's stroke weight or colour, and on a
 * site in the sun half of them read as a smudge. Every glyph in the UI is a Lucide icon instead, so no
 * pictographic character belongs in the source at all — not in a tab bar, not in a button, not in a status
 * word. This fails the moment one comes back.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));

const FILES = ["app", "components"].flatMap(walk);

describe("no emoji anywhere in the app's own source", () => {
  it("the walk really found the screens", () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it("app/ and components/ hold no pictographic characters", () => {
    const pictographic = /\p{Extended_Pictographic}/u;
    const offenders = FILES.flatMap((f) =>
      fs.readFileSync(f, "utf8").split("\n").flatMap((line, i) => {
        const m = pictographic.exec(line);
        return m ? [`${f}:${i + 1} ${m[0]} (U+${m[0].codePointAt(0)!.toString(16).toUpperCase()})`] : [];
      }));
    expect(offenders).toEqual([]);
  });

  it("nothing asks with the browser's confirm() — the app has its own sheet", () => {
    const call = /(?<![\w$.])(?:window\.)?confirm\s*\(/;
    const comment = /^\s*(\/\/|\/\*|\*)/;                       // the two components explain themselves in prose
    const offenders = FILES.flatMap((f) =>
      fs.readFileSync(f, "utf8").split("\n")
        .flatMap((line, i) => (call.test(line) && !comment.test(line) ? [`${f}:${i + 1}`] : [])));
    expect(offenders).toEqual([]);
  });
});
