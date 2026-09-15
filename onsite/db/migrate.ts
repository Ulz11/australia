import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });
  const root = process.cwd();
  await sql.unsafe(fs.readFileSync(path.join(root, "db/schema.sql"), "utf8"));
  console.log("schema applied");
  const dir = path.join(root, "db/migrations");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      await sql.unsafe(fs.readFileSync(path.join(dir, f), "utf8"));
      console.log("applied", f);
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
