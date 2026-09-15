"use client";
import { useState } from "react";
import { setCrewTarget } from "@/actions/boss";
import type { CrewStatus } from "@/lib/rules";

/** How many people this site needs in total — his own blokes plus anyone he hires. */
export function CrewTarget({ projectId, status, ownCrew }: { projectId: string; status: CrewStatus; ownCrew: number }) {
  const [edit, setEdit] = useState(false);
  const tone = status.over ? "red" : status.target == null ? "grey" : status.spare === 0 ? "green" : "grey";
  return (
    <div className={`say-${tone}`}>
      <div className="say-sub">People on this site</div>
      <div className="say-title">{status.words}</div>
      <div className="say-sub">{ownCrew} of your own{status.on - ownCrew > 0 ? `, ${status.on - ownCrew} hired` : ""}.</div>
      {!edit ? (
        <button className={`btn btn-sm w-full mt-3 ${tone === "grey" ? "bg-ink text-white" : "bg-white text-ink"}`} onClick={() => setEdit(true)}>
          {status.target == null ? "Set how many this site needs" : "Change the number"}
        </button>
      ) : (
        <form action={setCrewTarget} className="mt-3 space-y-2" onSubmit={() => setTimeout(() => setEdit(false), 50)}>
          <input type="hidden" name="project_id" value={projectId} />
          <div className="flex items-center gap-2">
            <input name="crew_target" type="number" min={0} max={500} defaultValue={status.target ?? ""} placeholder="e.g. 12"
              className="input num text-2xl font-extrabold text-center w-32 text-ink" autoFocus />
            <span className="say-sub">people all up</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn bg-white text-ink btn-sm w-full" onClick={() => setEdit(false)}>Cancel</button>
            <button className="btn bg-ink text-white btn-sm w-full">Save</button>
          </div>
          <div className="say-sub">Leave it empty for no limit. We only warn you — we never block a hire.</div>
        </form>
      )}
    </div>
  );
}
