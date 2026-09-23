/**
 * The order the whole screen rests on, and the one state it must never invent.
 *
 * Two things are being protected here. First, that the hole at 6:30 tomorrow always beats the invoice,
 * the deal request and the licence renewal — the flattening in app/boss/page.tsx:41-48 is exactly what
 * these tests fail on. Second, and harder: that the green "No." is only ever printed when all six inputs
 * actually answered. A boss who reads "nothing needs you" over a query that timed out puts the phone
 * down, and the hole is still there at 6am. So every input gets its own fail-white test, and every
 * fail-white test asserts the green cell was *not* produced, not merely that a flag was set.
 */
import { describe, it, expect } from "vitest";
import { rankUrgency, type RankInput, type ShortShift, type Dispute, type Deal, type Invoice } from "@/lib/rank";

const TZ = "Australia/Sydney";
/** Wednesday 23 September 2026, 11:30am on site. Thursday's 6:30 start is exactly 19 hours away. */
const NOW = new Date("2026-09-23T11:30:00+10:00");
const TODAY = "2026-09-23", THU = "2026-09-24", FRI = "2026-09-25", SAT = "2026-09-26", MON = "2026-09-28";

/** Every input present and answering "nothing". This is the only shape that may ever go green. */
const quiet: RankInput = {
  now: NOW, tz: TZ,
  shifts: [],
  approvals: { workers: 0, hours: 0, dollars: 0, names: [], since: null },
  disputes: [],
  deals: [],
  invoices: [],
  onSite: { workers: 0, sites: 0 },
};
const at = (patch: Partial<RankInput>): RankInput => ({ ...quiet, ...patch });

const shift = (p: Partial<ShortShift> = {}): ShortShift =>
  ({ id: "s1", day: THU, start_time: "06:30", spots: 2, taken: 0, site: "Erko Rd", project_id: "p1", role: "Concreter", ...p });
const dispute = (p: Partial<Dispute> = {}): Dispute =>
  ({ worker: "Sam Lee", worker_id: "w9", their_hours: 9, your_hours: 8, day: THU, site: "Rosehill", ...p });
const deal = (p: Partial<Deal> = {}): Deal =>
  ({ id: "o1", worker: "Sam Lee", rate: 42, shift_rate: 38, hours: 8, day: THU, site: "Rosehill", ...p });
const invoice = (p: Partial<Invoice> = {}): Invoice => ({ cents: 3400, due_day: FRI, matches: 17, ...p });
const waiting = { workers: 3, hours: 38, dollars: 1412.4, names: ["Jay Poe", "Sam Lee", "Tui Ale"], since: `${TODAY}T08:40:00+10:00` };

// ────────────────────────────────────────────────────────── each tenant, winning alone

describe("tenant 1 — the hole inside 24 hours", () => {
  const u = rankUrgency(at({ shifts: [shift()] }));

  it("is the top of the list and says how long there is to fix it", () => {
    expect(u.state).toBe("live");
    expect(u.items[0]).toMatchObject({
      key: "hole", rank: 1, tone: "needs",
      label: "Short for tomorrow",
      figure: "2 spots",
      sub: "Erko Rd, 6:30am start — 19 hours away",
      action: "Ask more workers",
      href: "/boss/shifts/s1",
    });
  });

  it("counts every spot inside the window but sends you to the soonest job", () => {
    const soonest = shift({ id: "s2", day: TODAY, start_time: "12:00", spots: 3, taken: 1, site: "Rosehill" });
    const items = rankUrgency(at({ shifts: [shift(), soonest] })).items;
    expect(items[0].figure).toBe("4 spots");                       // 2 tomorrow + 2 still open today
    expect(items[0].label).toBe("Short for today");
    expect(items[0].href).toBe("/boss/shifts/s2");
    expect(items[0].sub).toBe("Rosehill, 12:00pm start — it starts within the hour, and 1 more job");
  });

  it("still counts a shift that started this morning — a worker can walk on at ten", () => {
    const items = rankUrgency(at({ shifts: [shift({ day: TODAY, start_time: "06:30" })] })).items;
    expect(items[0].sub).toBe("Erko Rd, 6:30am start — it started already, still short");
  });

  it("drops yesterday's hole: there is nothing a boss can do about it, and pretending otherwise burns the cell", () => {
    const u2 = rankUrgency(at({ shifts: [shift({ day: "2026-09-22" })] }));
    expect(u2.state).toBe("clear");
  });

  it("says whose clock the start time is on when the site keeps its own", () => {
    const items = rankUrgency(at({ shifts: [shift({ tz_words: "Perth time" })] })).items;
    expect(items[0].sub).toContain("6:30am start (Perth time)");
  });

  it("gets the singular right — one spot is not '1 spots'", () => {
    expect(rankUrgency(at({ shifts: [shift({ spots: 1 })] })).items[0].figure).toBe("1 spot");
  });
});

describe("tenant 2 — hours waiting on you", () => {
  const u = rankUrgency(at({ approvals: waiting }));

  it("leads with the hours and carries the money and the names in the sub", () => {
    expect(u.items[0]).toMatchObject({
      key: "approve", rank: 2, tone: "needs",
      label: "Hours waiting on you",
      figure: "38.0 h",
      sub: "$1,412.40 · Jay, Sam and Tui — since 8:40am",
      action: "Approve",
      href: "/boss/approve",
    });
  });

  it("says the day, not the minute, once the wait has crossed midnight", () => {
    const items = rankUrgency(at({ approvals: { ...waiting, since: "2026-09-21T15:40:00+10:00" } })).items;
    expect(items[0].sub).toContain("since Mon, 21 Sept");   // fmtDay's words, so the whole app says it the same way
  });

  it("stops naming people past three and starts counting them", () => {
    const names = ["Jay Poe", "Sam Lee", "Tui Ale", "Ana Rei", "Bo Ng"];
    const items = rankUrgency(at({ approvals: { ...waiting, workers: 5, names } })).items;
    expect(items[0].sub).toContain("Jay, Sam and 3 more");
  });

  it("falls back to a count when the names didn't come through, rather than a dangling dash", () => {
    const items = rankUrgency(at({ approvals: { ...waiting, names: [] } })).items;
    expect(items[0].sub).toBe("$1,412.40 · 3 workers — since 8:40am");
  });
});

describe("tenant 3 — a worker disagrees about hours", () => {
  it("names the worker, shows both numbers, and offers the phone call", () => {
    expect(rankUrgency(at({ disputes: [dispute()] })).items[0]).toMatchObject({
      key: "disputed", rank: 3, tone: "needs",
      label: "Sam disagrees about hours",
      figure: "9 h vs 8 h",
      sub: "Thursday, Rosehill. Both numbers stay on record.",
      action: "Call Sam",
      href: "/boss/crew/w9",
    });
  });

  it("stays a sentence when the name didn't come through, and stops promising a phone call", () => {
    const items = rankUrgency(at({ disputes: [dispute({ worker: "  " })] })).items;
    expect(items[0].label).toBe("A worker disagrees about hours");
    expect(items[0].action).toBe("Open it");
  });

  it("counts them when there is more than one, and points at the oldest argument first", () => {
    const rows = [dispute({ worker: "Tui Ale", worker_id: "w3", day: FRI }), dispute({ day: "2026-09-21" })];
    expect(rankUrgency(at({ disputes: rows })).items[0]).toMatchObject({
      label: "2 workers disagree about hours",
      figure: "2 to settle",
      sub: "Monday, Rosehill, and 1 more. Both numbers stay on record.",
      href: "/boss/crew/w9",
    });
  });
});

describe("tenant 4 — a deal request", () => {
  it("states the ask, the difference an hour, and what the day costs", () => {
    expect(rankUrgency(at({ deals: [deal()] })).items[0]).toMatchObject({
      key: "deal", rank: 4, tone: "needs",
      label: "Sam wants $42.00 an hour",
      figure: "+$4.00/h",
      sub: "$32.00 more for the day. Thursday.",
      action: "Accept",
      href: "/boss/deals",
    });
  });

  it("handles a request that isn't about the rate without inventing a number", () => {
    expect(rankUrgency(at({ deals: [deal({ rate: null })] })).items[0]).toMatchObject({
      label: "Sam wants to talk terms",
      figure: "1 request",
      sub: "Thursday, Rosehill.",
    });
  });

  it("reads an ask under the posted rate as less, not as a negative more", () => {
    const items = rankUrgency(at({ deals: [deal({ rate: 36 })] })).items;
    expect(items[0].figure).toBe("−$2.00/h");
    expect(items[0].sub).toBe("$16.00 less for the day. Thursday.");
  });
});

describe("tenant 5 — the gaps on days 2 to 7", () => {
  const rows = [
    shift({ id: "a", day: FRI, spots: 3, taken: 0, project_id: "p2", role: "General labourer" }),
    shift({ id: "b", day: FRI, spots: 2, taken: 1, project_id: "p2", role: "Carpenter" }),
    shift({ id: "c", day: SAT, spots: 1, taken: 0 }),
  ];

  it("totals the week and names the day worth ringing about", () => {
    expect(rankUrgency(at({ shifts: rows })).items[0]).toMatchObject({
      key: "week", rank: 5, tone: "needs",
      label: "Short this week",
      figure: "5 spots",
      sub: "4 of them Friday",
      action: "Fill Friday",
      href: "/boss/post?day=2026-09-25&project=p2&role=General%20labourer",
    });
  });

  it("says 'all of them' when the week's whole shortfall is one day", () => {
    expect(rankUrgency(at({ shifts: rows.slice(0, 2) })).items[0].sub).toBe("all of them Friday");
  });

  it("puts the site in the sub when there is only one spot left in the week", () => {
    expect(rankUrgency(at({ shifts: [rows[2]] })).items[0].sub).toBe("Saturday at Erko Rd");
  });

  it("ignores a gap past the seventh day — it is not this week's problem yet", () => {
    expect(rankUrgency(at({ shifts: [shift({ day: "2026-09-30" })] })).state).toBe("clear");
  });

  it("never outranks the hole, and lands as the demoted item beneath it", () => {
    const items = rankUrgency(at({ shifts: [...rows, shift()] })).items;
    expect(items.map((i) => i.key)).toEqual(["hole", "week"]);
  });
});

describe("tenant 6 — the invoice", () => {
  it("is live inside three days and says what it is for", () => {
    expect(rankUrgency(at({ invoices: [invoice()] })).items[0]).toMatchObject({
      key: "invoice", rank: 6, tone: "needs",
      label: "Invoice due Friday",
      figure: "$34.00",
      sub: "17 introductions this fortnight",
      action: "Open the invoice",
      href: "/boss/money",
    });
  });

  it("reads cents as cents — a $34 invoice is never $3,400 (commit 8f912ee)", () => {
    expect(rankUrgency(at({ invoices: [invoice({ cents: 3400 })] })).items[0].figure).toBe("$34.00");
  });

  it("stacks the rest behind the soonest one", () => {
    const rows = [invoice({ due_day: "2026-09-28", cents: 1200 }), invoice()];
    expect(rankUrgency(at({ invoices: rows })).items[0].figure).toBe("$34.00 + 1 more");
  });

  it("counts the days once it is overdue", () => {
    const items = rankUrgency(at({ invoices: [invoice({ due_day: "2026-09-21" })] })).items;
    expect(items[0].label).toBe("Invoice overdue");
    expect(items[0].sub).toBe("2 days ago · 17 introductions this fortnight");
  });

  it("says today and tomorrow in words a boss reads without counting", () => {
    expect(rankUrgency(at({ invoices: [invoice({ due_day: TODAY })] })).items[0].label).toBe("Invoice due today");
    expect(rankUrgency(at({ invoices: [invoice({ due_day: THU })] })).items[0].label).toBe("Invoice due tomorrow");
  });

  it("is not the screen's business four days out — that is a date, not a job", () => {
    expect(rankUrgency(at({ invoices: [invoice({ due_day: "2026-09-27" })] })).state).toBe("clear");
  });
});

describe("tenant 7 — the green No.", () => {
  const u = rankUrgency(at({
    shifts: [shift({ taken: 2 }), shift({ id: "s2", day: FRI, taken: 2 })],
    onSite: { workers: 11, sites: 3 },
    invoices: [invoice({ due_day: MON })],
  }));

  it("answers the question the boss actually opened the app to ask", () => {
    expect(u.state).toBe("clear");
    expect(u.items).toHaveLength(1);
    expect(u.items[0]).toMatchObject({
      key: "clear", rank: 7, tone: "go",
      label: "Anything waiting on you?",
      figure: "No",
      sub: "11 on site across 3 sites · both jobs full · invoice not due until Monday",
      action: null,
      href: null,
    });
  });

  it("is green, and it is the only item that ever is", () => {
    expect(u.items[0].tone).toBe("go");
    const live = rankUrgency(at({ shifts: [shift()], approvals: waiting, disputes: [dispute()], deals: [deal()], invoices: [invoice()] }));
    expect(live.items.every((i) => i.tone === "needs")).toBe(true);
  });

  it("says the quiet things plainly rather than showing a zero", () => {
    expect(rankUrgency(quiet).items[0].sub).toBe("Nobody on site today · nothing booked in the next week · no invoice this fortnight");
  });

  it("gives the date rather than a weekday when the invoice is more than a week out", () => {
    const far = rankUrgency(at({ invoices: [invoice({ due_day: "2026-10-09" })] }));
    expect(far.items[0].sub).toContain("invoice not due until Fri, 9 Oct");
  });
});

// ────────────────────────────────────────────────────────── the order itself

describe("the order — four live at once", () => {
  const u = rankUrgency(at({
    shifts: [shift(), shift({ id: "s3", day: FRI, spots: 4, taken: 0 })],
    approvals: waiting,
    disputes: [dispute()],
    deals: [deal()],
    invoices: [invoice()],
    onSite: { workers: 11, sites: 3 },
  }));

  it("puts the hole first and the invoice last, every time", () => {
    expect(u.state).toBe("live");
    expect(u.items.map((i) => i.key)).toEqual(["hole", "approve", "disputed", "deal", "week", "invoice"]);
    expect(u.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("never shows the green cell while anything is live", () => {
    expect(u.items.some((i) => i.key === "clear")).toBe(false);
  });

  it("hands the screen its hero and its one demoted cell in the right order", () => {
    expect(u.items[0].key).toBe("hole");      // the only bg-hv on the screen
    expect(u.items[1].key).toBe("approve");   // cell 2, .cell-soft
  });
});

describe("the order — each tenant beats everything below it", () => {
  const all = {
    shifts: [shift(), shift({ id: "s3", day: FRI, spots: 4 })],
    approvals: waiting,
    disputes: [dispute()],
    deals: [deal()],
    invoices: [invoice()],
  };
  const week = [shift({ id: "s3", day: FRI, spots: 4 })];
  const cases: [string, Partial<RankInput>, string][] = [
    ["the hole", {}, "hole"],
    ["hours waiting", { shifts: [] }, "approve"],
    ["a disagreement", { shifts: [], approvals: quiet.approvals }, "disputed"],
    ["a deal request", { shifts: [], approvals: quiet.approvals, disputes: [] }, "deal"],
    ["the week's gaps", { shifts: week, approvals: quiet.approvals, disputes: [], deals: [] }, "week"],
    ["the invoice", { shifts: [], approvals: quiet.approvals, disputes: [], deals: [] }, "invoice"],
  ];
  for (const [name, patch, winner] of cases)
    it(`${name} wins when nothing above it is live`, () => {
      expect(rankUrgency(at({ ...all, ...patch })).items[0].key).toBe(winner);
    });
});

describe("purity", () => {
  it("takes 'now' as a parameter, so the order can be tested at 5:59am on a Thursday", () => {
    const dawn = new Date("2026-09-24T05:59:00+10:00");
    const items = rankUrgency({ ...quiet, now: dawn, shifts: [shift()] }).items;
    expect(items[0].label).toBe("Short for today");
    expect(items[0].sub).toContain("it starts within the hour");
  });

  it("leaves the caller's rows exactly as they were — the page may render the same array after", () => {
    const rows = [dispute({ worker: "Tui Ale", day: FRI }), dispute({ day: "2026-09-21" })];
    rankUrgency(at({ disputes: rows }));
    expect(rows.map((r) => r.day)).toEqual([FRI, "2026-09-21"]);
  });
});

// ────────────────────────────────────────────────────────── fail white, never fail green

describe("fail white — one input missing", () => {
  const six: (keyof RankInput)[] = ["shifts", "approvals", "disputes", "deals", "invoices", "onSite"];

  for (const name of six)
    it(`goes white, not green, when ${name} didn't answer`, () => {
      const u = rankUrgency(at({ [name]: null }));
      expect(u.state).toBe("unknown");
      expect(u.items).toEqual([]);                          // no green cell was built at all
      expect(u.unchecked).toContain(name);
    });

  it("names every input that failed, so the screen can say what it couldn't check", () => {
    const u = rankUrgency({ ...quiet, shifts: null, approvals: null, disputes: null, deals: null, invoices: null, onSite: null });
    expect(u.state).toBe("unknown");
    expect(u.unchecked).toEqual(["shifts", "approvals", "disputes", "deals", "invoices", "onSite"]);
  });

  it("still shows what it does know — a real hole is not hidden by a failed money query", () => {
    const u = rankUrgency(at({ shifts: [shift()], invoices: null, onSite: null }));
    expect(u.state).toBe("live");
    expect(u.items[0].key).toBe("hole");
    expect(u.unchecked).toEqual(["invoices", "onSite"]);    // the screen must not claim "and nothing else"
  });
});

describe("fail white — an input that answered with garbage", () => {
  /**
   * A NaN count or a day the shape of nonsense is a row we cannot place in the order. Dropping it quietly
   * would be the same lie one level down: the hole is still there, we just stopped counting it.
   */
  const garbage: [string, Partial<RankInput>][] = [
    ["a shift with no count", { shifts: [shift({ spots: NaN })] }],
    ["a shift with a broken day", { shifts: [shift({ day: "next Thursday" })] }],
    ["a shift with a broken start time", { shifts: [shift({ start_time: "half six" })] }],
    ["hours that came back NaN", { approvals: { ...waiting, hours: NaN } }],
    ["a dollar total that came back NaN", { approvals: { ...waiting, dollars: NaN } }],
    ["a disagreement with no numbers", { disputes: [dispute({ their_hours: NaN })] }],
    ["a deal with no shift rate", { deals: [deal({ shift_rate: NaN })] }],
    ["an invoice with no amount", { invoices: [invoice({ cents: NaN })] }],
    ["an invoice with a broken due date", { invoices: [invoice({ due_day: "Friday" })] }],
    ["a head count that came back NaN", { onSite: { workers: NaN, sites: 1 } }],
  ];

  for (const [what, patch] of garbage)
    it(`treats ${what} as unchecked rather than as zero`, () => {
      const u = rankUrgency(at(patch));
      expect(u.state).toBe("unknown");
      expect(u.items).toEqual([]);
    });

  it("treats a missing array as unchecked too — undefined is not an empty week", () => {
    const u = rankUrgency({ ...quiet, shifts: undefined as unknown as ShortShift[] });
    expect(u.state).toBe("unknown");
    expect(u.unchecked).toContain("shifts");
  });

  it("goes white when the clock itself is unreadable: every judgement here is 'how far from now'", () => {
    const u = rankUrgency({ ...quiet, now: new Date("not a date") });
    expect(u.state).toBe("unknown");
    expect(u.unchecked).toHaveLength(6);
  });
});

describe("fail white — the assertion of absence, checked from the other side", () => {
  const six: (keyof RankInput)[] = ["shifts", "approvals", "disputes", "deals", "invoices", "onSite"];

  it("cannot reach the green cell while any one of the six is unreadable", () => {
    for (const name of six) {
      const u = rankUrgency(at({ [name]: null }));
      expect(u.state).not.toBe("clear");
      expect(u.items.some((i) => i.key === "clear")).toBe(false);
    }
  });

  it("reaches it only when all six answered", () => {
    const u = rankUrgency(quiet);
    expect(u.state).toBe("clear");
    expect(u.unchecked).toEqual([]);
    expect(u.items[0].key).toBe("clear");
  });
});
