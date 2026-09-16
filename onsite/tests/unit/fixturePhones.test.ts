import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Integration test files run in parallel against one database and clean up after themselves by phone number.
 * Two files using the same fixture number delete each other's users mid-run — which is exactly what happened when
 * posts.test.ts and session.test.ts were written separately and both picked +614000092xx. Each file owns its numbers.
 */
describe("integration fixture phones", () => {
  it("no fixture number is used by more than one test file", () => {
    const dir = "tests/integration";
    const owners = new Map<string, Set<string>>();
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      // 90xx–99xx were full, so billing took 88xx: both blocks are checked, not just the old one.
      for (const m of src.matchAll(/\+6140000[89]\d{3}\b/g)) {
        if (!owners.has(m[0])) owners.set(m[0], new Set());
        owners.get(m[0])!.add(f);
      }
    }
    const shared = [...owners].filter(([, files]) => files.size > 1).map(([phone, files]) => `${phone}: ${[...files].sort().join(", ")}`);
    expect(shared).toEqual([]);
  });
});
