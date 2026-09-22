import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// An .mts file: Vite loads its config natively as ESM, so no "ESM syntax in a CommonJS file" warning on every run.
export default defineConfig({
  resolve: { alias: { "@": path.dirname(fileURLToPath(import.meta.url)) } },
  // hookTimeout matches testTimeout on purpose: the integration beforeAll hooks build their fixtures over a
  // round trip each to a Postgres that may be a continent away, so they need at least as long as the tests
  // they set up. At the 10 s default, billing.test.ts and profile.test.ts time out in setup and vitest then
  // reports their tests as *skipped* — a green-looking run that checked nothing.
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000 },
});
