import { describe, it, expect } from "vitest";
import { readPostLines, hasLines, groupByPost, linesInWords, fillWords, MAX_LINES, MAX_SPOTS, ROLES } from "@/lib/posts";
import { AWARD_CASUAL_FLOOR } from "@/lib/award";

const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => f.append(k, x)); return f; };
const line = (role = "Carpenter", spots = "1", rate = "40") => ({ role, spots, rate });
const lines = (...ls: ReturnType<typeof line>[]) => ({ line_role: ls.map((l) => l.role), line_spots: ls.map((l) => l.spots), line_rate: ls.map((l) => l.rate) });

describe("reading the lines of a job post", () => {
  it("reads each line on its own terms: White Card always, known licences once, pay floored to the Award", () => {
    const r = readPostLines(fd({ ...lines(line("Carpenter", "2", "42.5"), line("Forklift driver", "1", "30"), line("General labourer", "20", "")), line_tickets_1: ["LF", "WC", "LF"] }));
    expect(r).toEqual({ ok: true, lines: [
      { role: "Carpenter", spots: 2, rate: 42.5, tickets: ["WC"] },
      { role: "Forklift driver", spots: 1, rate: AWARD_CASUAL_FLOOR, tickets: ["WC", "LF"] },
      { role: "General labourer", spots: 20, rate: AWARD_CASUAL_FLOOR, tickets: ["WC"] },
    ] });
  });

  it("refuses anything that doesn't add up, rather than guessing", () => {
    const refused = (o: Record<string, string | string[]>) => readPostLines(fd(o)).ok === false;
    expect(refused({})).toBe(true);
    expect(refused({ line_role: ["Carpenter", "Concreter"], line_spots: ["1"], line_rate: ["40", "40"] })).toBe(true);
    expect(refused({ line_role: ["Carpenter"], line_spots: ["1"] })).toBe(true);
    expect(refused(lines(line("Astronaut")))).toBe(true);
    expect(refused(lines(line(" carpenter ")))).toBe(true);
    for (const s of ["0", String(MAX_SPOTS + 1), "-1", "1.5", "two", ""]) expect(refused(lines(line("Carpenter", s))), s).toBe(true);
    expect(refused(lines(...Array(MAX_LINES + 1).fill(line())))).toBe(true);
    expect(refused({ ...lines(line()), line_tickets_0: ["XX"] })).toBe(true);
    expect(refused({ ...lines(line()), line_tickets_1: ["LF"] })).toBe(true);
    expect(refused({ ...lines(line()), line_tickets_x: ["LF"] })).toBe(true);
    expect(refused(lines(line("Carpenter", "1", "301")))).toBe(true);
    expect(readPostLines(fd(lines(...Array(MAX_LINES).fill(line())))).ok).toBe(true);
    expect(readPostLines(fd(lines(line(" Carpenter ", " 3 ")))).ok).toBe(true);
    expect(ROLES).toContain("Forklift driver");
  });

  it("knows a line post from a crew booking or an older form", () => {
    expect(hasLines(fd({ role: "Carpenter", spots: "2", rate: "40" }))).toBe(false);
    expect(hasLines(fd(lines(line())))).toBe(true);
    expect(hasLines(fd({ line_spots: "1" }))).toBe(true);
    expect(hasLines(fd({ line_tickets_0: "LF" }))).toBe(true);
  });
});

describe("showing jobs", () => {
  it("groups lines of one post, keeping order; a shift with no post is its own job", () => {
    const rows = [{ id: "a", post_id: null }, { id: "b", post_id: "p" }, { id: "c", post_id: "p" }, { id: "d", post_id: "q" }];
    expect(groupByPost(rows).map((j) => [j.key, j.lines.map((l) => l.id)])).toEqual([["a", ["a"]], ["p", ["b", "c"]], ["q", ["d"]]]);
  });

  it("says a job the way the boss wrote it", () => {
    expect(linesInWords([{ spots: 2, role: "Carpenter" }, { spots: 1, role: "Forklift driver" }])).toBe("2 × Carpenter, 1 × Forklift driver");
    expect(fillWords(1, 2)).toBe("1 of 2 booked");
  });
});
