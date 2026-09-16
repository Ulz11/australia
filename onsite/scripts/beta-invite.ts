/**
 * npm run beta:invite — the closed beta's guest list (lib/beta.ts, table beta_invites from migration 008).
 *
 *   npm run beta:invite -- 0412345678 [--role worker|boss] [--note "Dave's crew"]   add or update a number
 *   npm run beta:invite -- --list                                                    everyone on the list
 *   npm run beta:invite -- --remove 0412345678                                       take a number off
 *
 * Only matters while BETA_INVITE_ONLY=1. Someone who already has an account can always sign in, so removing
 * a number stops new sign-ups, not an existing account. Reads DATABASE_URL from the shell (never .env, so it
 * can't quietly write to the wrong database) and prints which host and database it is talking to.
 */
type Parsed =
  | { cmd: "list" }
  | { cmd: "remove"; phone: string }
  | { cmd: "invite"; phone: string; role: "worker" | "boss" | null; note: string | null }
  | { cmd: "help"; error?: string };

const USAGE = `Usage:
  npm run beta:invite -- 0412345678 [--role worker|boss] [--note "…"]
  npm run beta:invite -- --list
  npm run beta:invite -- --remove 0412345678`;

export function parseArgs(argv: string[]): Parsed {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) return { cmd: "help" };
  if (argv[0] === "--list") return argv.length === 1 ? { cmd: "list" } : { cmd: "help", error: "--list takes nothing else." };
  if (argv[0] === "--remove")
    return argv.length >= 2 && argv.slice(1).every((a) => /^[\d\s()+-]+$/.test(a))
      ? { cmd: "remove", phone: argv.slice(1).join(" ") }
      : { cmd: "help", error: "--remove takes one number." };
  let phone: string | null = null, role: string | null = null, note: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") role = argv[++i] ?? "";
    else if (a === "--note") note = argv[++i] ?? "";
    else if (a.startsWith("--")) return { cmd: "help", error: `Unknown option ${a}.` };
    else if (phone === null) phone = a;
    else if (/^[\d\s()+-]+$/.test(a) && /^[\d\s()+-]+$/.test(phone)) phone = `${phone} ${a}`;   // 0412 345 678, unquoted
    else return { cmd: "help", error: "One number at a time." };
  }
  if (!phone) return { cmd: "help", error: "Which number?" };
  if (role !== null && role !== "worker" && role !== "boss") return { cmd: "help", error: "--role must be worker or boss." };
  return { cmd: "invite", phone, role: role as "worker" | "boss" | null, note };
}

const when = (d: Date | null) => (d ? new Date(d).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }) : "—");

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.cmd === "help") {
    if (parsed.error) console.error(parsed.error);
    console.log(USAGE);
    process.exit(parsed.error ? 1 : 0);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL isn't set. Run it as: DATABASE_URL=… npm run beta:invite -- …");
    process.exit(1);
  }
  const target = (() => { try { const u = new URL(process.env.DATABASE_URL!); return `${u.hostname}${u.pathname}`; } catch { return "(unreadable DATABASE_URL)"; } })();
  console.log(`database: ${target}`);                          // host and database name only — never the credentials

  // Imported only now: lib/db opens its pool from DATABASE_URL when it loads.
  const { invite, listInvites, uninvite, inviteePhone } = await import("../lib/beta");
  const { sql } = await import("../lib/db");
  try {
    if (parsed.cmd === "list") {
      const rows = await listInvites();
      if (!rows.length) console.log("Nobody is on the list yet.");
      for (const r of rows)
        console.log([r.phone, (r.role ?? "any").padEnd(6), `invited ${when(r.invited_at)}`,
          r.first_signed_in_at ? `first signed in ${when(r.first_signed_in_at)}` : r.has_account ? "has an account" : "not signed in yet",
          r.note ? `— ${r.note}` : ""].join("  "));
      console.log(`${rows.length} on the list.`);
    } else if (parsed.cmd === "remove") {
      if (!inviteePhone(parsed.phone)) throw new Error("Not an Australian mobile number (e.g. 0412 345 678).");
      const gone = await uninvite(parsed.phone);
      console.log(gone ? `Removed ${inviteePhone(parsed.phone)}.` : `${inviteePhone(parsed.phone)} wasn't on the list.`);
      const [acct] = await sql`SELECT 1 FROM users WHERE phone = ${inviteePhone(parsed.phone)}`;
      if (acct) console.log("That number already has an account, so it can still sign in.");
    } else {
      const r = await invite(parsed.phone, { role: parsed.role, note: parsed.note });
      console.log(`Invited ${r.phone}${r.role ? ` as ${r.role}` : ""}${r.note ? ` — ${r.note}` : ""}.`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && /beta-invite\.ts$/.test(process.argv[1])) void main();
