import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { demoConsoleOn, devShowOtpOn } from "@/lib/flags";

afterEach(() => { vi.unstubAllEnvs(); });

describe("demo switches", () => {
  it("follow DEMO_CONSOLE / DEV_SHOW_OTP locally and on previews", () => {
    for (const env of ["", "development", "preview"]) {
      vi.stubEnv("VERCEL_ENV", env);
      vi.stubEnv("DEMO_CONSOLE", "1"); vi.stubEnv("DEV_SHOW_OTP", "1");
      expect([demoConsoleOn(), devShowOtpOn()], `VERCEL_ENV=${env}`).toEqual([true, true]);
      vi.stubEnv("DEMO_CONSOLE", "0"); vi.stubEnv("DEV_SHOW_OTP", "");
      expect([demoConsoleOn(), devShowOtpOn()], `VERCEL_ENV=${env}`).toEqual([false, false]);
    }
  });

  it("can't be switched on in Vercel production, whatever the variables say", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DEMO_CONSOLE", "1");
    vi.stubEnv("DEV_SHOW_OTP", "1");
    expect(demoConsoleOn()).toBe(false);
    expect(devShowOtpOn()).toBe(false);
  });

  it("are read at call time, not frozen at import", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("DEMO_CONSOLE", "");
    expect(demoConsoleOn()).toBe(false);
    vi.stubEnv("DEMO_CONSOLE", "1");
    expect(demoConsoleOn()).toBe(true);
  });
});

describe("demo switches — source guard", () => {
  const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [path.join(d, e.name)] : [])) : [];

  it("nothing but lib/flags.ts reads DEMO_CONSOLE or DEV_SHOW_OTP from the environment", () => {
    const files = [...walk("app"), ...walk("lib"), ...walk("actions"), ...walk("components"), ...walk("scripts"), ...walk("db"),
      ...fs.readdirSync(".").filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))];
    const offenders = files
      .filter((f) => path.normalize(f) !== path.normalize("lib/flags.ts"))
      .filter((f) => /process\.env(\.|\[\s*["'`])(DEMO_CONSOLE|DEV_SHOW_OTP)\b|\{[^}]*\b(DEMO_CONSOLE|DEV_SHOW_OTP)\b[^}]*\}\s*=\s*process\.env/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
