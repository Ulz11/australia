/**
 * The invoice book, from a terminal. Invoices are paid through QPay and mark themselves paid when QPay
 * confirms it; this is how a person marks one paid when the money arrived some other way.
 *
 *   npm run billing:list                                          every invoice, newest first
 *   npm run billing:paid -- OS-2026-000123 [--note "…"]           mark one paid
 *
 * Reads DATABASE_URL from the shell (never .env, so it can't quietly write to the wrong database) and
 * prints which host and database it is talking to.
 */
import { isInvoiceNumber } from "../lib/subscription";

type Parsed =
  | { cmd: "list" }
  | { cmd: "paid"; number: string; note: string | null }
  | { cmd: "help"; error?: string };

const USAGE = `Usage:
  npm run billing:list
  npm run billing:paid -- OS-2026-000123 [--note "Paid by transfer"]`;

export function parseArgs(argv: string[]): Parsed {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) return { cmd: "help" };
  const [mode, ...rest] = argv;
  if (mode === "list") return rest.length ? { cmd: "help", error: "billing:list takes nothing else." } : { cmd: "list" };
  if (mode !== "paid") return { cmd: "help", error: `Unknown command ${mode}.` };

  let number: string | null = null, note: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--note") note = rest[++i] ?? "";
    else if (a.startsWith("--")) return { cmd: "help", error: `Unknown option ${a}.` };
    else if (number === null) number = a;
    else return { cmd: "help", error: "One invoice at a time." };
  }
  if (!number) return { cmd: "help", error: "Which invoice? e.g. OS-2026-000123" };
  if (!isInvoiceNumber(number)) return { cmd: "help", error: `${number} is not an invoice number (they look like OS-2026-000123).` };
  return { cmd: "paid", number, note: note?.trim() || null };
}

const when = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }) : "—";
const dollars = (cents: number) => "$" + (cents / 100).toFixed(2);

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.cmd === "help") {
    if (parsed.error) console.error(parsed.error);
    console.log(USAGE);
    process.exit(parsed.error ? 1 : 0);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL isn't set. Run it as: DATABASE_URL=… npm run billing:list");
    process.exit(1);
  }
  const target = (() => { try { const u = new URL(process.env.DATABASE_URL!); return `${u.hostname}${u.pathname}`; } catch { return "(unreadable DATABASE_URL)"; } })();
  console.log(`database: ${target}`);                          // host and database name only — never the credentials

  // Imported only now: lib/db opens its pool from DATABASE_URL when it loads.
  const { allInvoices, markInvoicePaid } = await import("../lib/invoicing");
  const { sql } = await import("../lib/db");
  try {
    if (parsed.cmd === "list") {
      const rows = await allInvoices();
      if (!rows.length) console.log("No invoices yet.");
      for (const r of rows)
        console.log([r.number, dollars(r.total_cents).padStart(10), r.status.padEnd(4),
          `issued ${when(r.issued_at)}`, `due ${when(r.due_at)}`, r.company,
          r.status === "paid" ? `— paid ${when(r.paid_at)}${r.paid_note ? ` (${r.paid_note})` : ""}` : ""].join("  "));
      const open = rows.filter((r) => r.status === "open");
      console.log(`${rows.length} invoice${rows.length === 1 ? "" : "s"}, ${open.length} open (${dollars(open.reduce((a, r) => a + r.total_cents, 0))}).`);
    } else {
      const r = await markInvoicePaid(parsed.number, parsed.note);
      if (r.ok) {
        console.log(`${r.invoice.number} marked paid — ${dollars(r.invoice.total_cents)}${parsed.note ? ` (${parsed.note})` : ""}.`);
        if (r.qpayStillOpen) console.log(`QPay invoice ${r.qpayStillOpen} for it is still open. Cancel it in QPay so it can't be paid a second time.`);
      }
      else if (r.reason === "unknown") throw new Error(`No invoice ${parsed.number}. Run npm run billing:list to see them.`);
      else if (r.reason === "already_paid") console.log(`${parsed.number} was already marked paid — nothing changed.`);
      else throw new Error(`${parsed.number} is cancelled, so it can't be paid.`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && /billing\.ts$/.test(process.argv[1])) void main();
