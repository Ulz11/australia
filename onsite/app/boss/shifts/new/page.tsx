import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { ShiftForm } from "./ShiftForm";
import { addDays, todayIso } from "@/lib/util";
export const dynamic = "force-dynamic";

export default async function NewShift({ searchParams }: { searchParams: Promise<{ project?: string; worker?: string; err?: string }> }) {
  const u = await requireRole("boss");
  const { project, worker, err } = await searchParams;
  const [projects, crew, directRows] = await Promise.all([
    sql`SELECT id, name FROM projects WHERE boss_id = ${u.id} AND NOT archived ORDER BY created_at DESC`,
    sql`SELECT us.id, us.name, c.type, c.rate FROM crew c JOIN users us ON us.id = c.worker_id WHERE c.boss_id = ${u.id} ORDER BY us.name`,
    worker ? sql`SELECT us.id, us.name, c.rate FROM users us LEFT JOIN crew c ON c.worker_id = us.id AND c.boss_id = ${u.id} WHERE us.id = ${worker}` : Promise.resolve([]),
  ]);
  if (projects.length === 0) redirect("/boss/projects/new");
  const direct = directRows[0];
  const t = todayIso();
  return (
    <>
      <Header title={direct ? `Book ${direct.name.split(" ")[0]}` : "Need workers"} back="/boss" />
      <Page>
        {err && <div className="say-red"><div className="say-title">{err}</div></div>}
        <ShiftForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} projectId={project ?? projects[0].id}
          days={[{ v: t, l: "Today" }, { v: addDays(t, 1), l: "Tomorrow" }, { v: addDays(t, 2), l: "Day after" }]}
          direct={direct ? { id: direct.id, name: direct.name, rate: direct.rate ? Number(direct.rate) : null } : null}
          crew={crew.map((c) => ({ id: c.id, name: c.name, type: c.type, rate: c.rate ? Number(c.rate) : null }))} />
      </Page>
    </>
  );
}
