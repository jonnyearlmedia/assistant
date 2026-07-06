// lexa's control panel — view & edit EVERYTHING adjustable: memories (by category), rules,
// workflows, reminders, commitments, places, settings, and a visual subagent builder — plus live
// to-dos, spend, and reliability. Owner-only via Vercel Auth. The dashboard is meant to be the
// efficient management surface so you don't have to run everything through a chat thread.
import { db } from "@/lib/db";
import { ownerUserId } from "@/lib/integrations/tokens";
import { computeSpend, periodSince } from "@/lib/spend";
import * as ticktick from "@/lib/integrations/ticktick";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// tool catalog for the subagent builder (grouped for a sane checkbox UI)
const TOOL_CATALOG: [string, string[]][] = [
  ["email", ["gmail_search", "gmail_send", "gmail_draft"]],
  ["calendar", ["gcal_upcoming", "gcal_create", "gcal_update", "gcal_delete", "drive_time"]],
  ["drive", ["drive_search", "drive_read"]],
  ["notion", ["notion_search", "notion_read", "notion_query_db", "notion_create_page", "notion_append", "notion_log", "list_master_planner"]],
  ["tasks", ["ticktick_list", "ticktick_create_task", "ticktick_projects", "ticktick_complete", "ticktick_update", "ticktick_delete"]],
  ["memory", ["recall", "list_facts", "remember_fact", "forget_fact"]],
  ["commitments", ["list_commitments", "track_commitment", "resolve_commitment"]],
  ["places", ["save_place", "list_places", "set_current_location"]],
  ["reminders", ["schedule_reminder", "list_reminders"]],
  ["research", ["web_search"]],
];

async function getData() {
  const uid = await ownerUserId();
  if (!uid) return null;
  const [facts, goals, playbooks, reminders, integrations, user, commitments, subagents, places, messages, jobs, audits] =
    await Promise.all([
      db.from("facts").select("id,category,key,value,pinned").eq("user_id", uid).order("category"),
      db.from("goals").select("id,title,detail,status").eq("user_id", uid).neq("status", "dropped"),
      db.from("playbooks").select("id,name,trigger,instructions,active,format").eq("user_id", uid).order("name"),
      db.from("reminders").select("id,title,due_at,status,location,recurrence").eq("user_id", uid).eq("status", "scheduled").order("due_at"),
      db.from("integrations").select("provider,status,meta").eq("user_id", uid),
      db.from("users").select("*").eq("id", uid).single(),
      db.from("commitments").select("id,what,context,follow_up_at,status,outcome").eq("user_id", uid).order("created_at", { ascending: false }).limit(25),
      db.from("subagents").select("id,name,brief,tools,active").eq("user_id", uid).order("name"),
      db.from("places").select("id,name,address").eq("user_id", uid).order("name"),
      db.from("messages").select("direction,body,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(14),
      db.from("jobs").select("status,kind,last_error").order("created_at", { ascending: false }).limit(60),
      db.from("write_audits").select("provider,action,verified,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(8),
    ]);
  const spendWeek = await computeSpend(periodSince("week")).catch(() => null);
  const spendAll = await computeSpend().catch(() => null);
  let todos: any = null;
  try {
    todos = await ticktick.listTasks("today");
  } catch {}
  return {
    facts: facts.data || [],
    goals: goals.data || [],
    playbooks: playbooks.data || [],
    reminders: reminders.data || [],
    integrations: integrations.data || [],
    user: user.data,
    commitments: commitments.data || [],
    subagents: subagents.data || [],
    places: places.data || [],
    messages: (messages.data || []).reverse(),
    jobs: jobs.data || [],
    audits: audits.data || [],
    spendWeek,
    spendAll,
    todos,
  };
}

// ---- styles ----
const box: React.CSSProperties = { background: "#15151b", border: "1px solid #26262f", borderRadius: 12, padding: 16, marginBottom: 14 };
const chip: React.CSSProperties = { fontSize: 11, color: "#8b8b99", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 };
const del: React.CSSProperties = { background: "transparent", border: "1px solid #3a2530", color: "#e0708f", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 12 };
const add: React.CSSProperties = { ...del, borderColor: "#254a3a", color: "#5fd08a" };
const inp: React.CSSProperties = { background: "#0d0d12", border: "1px solid #26262f", color: "#eee", borderRadius: 6, padding: "6px 8px", marginTop: 3, width: "100%" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #1c1c24", fontSize: 14 };
const btnDo: React.CSSProperties = { background: "transparent", border: "1px solid #2f3550", color: "#8fb0ff", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 12 };

export default async function Dashboard() {
  const d = await getData();
  if (!d) {
    return <main style={{ fontFamily: "system-ui", background: "#0b0b0f", color: "#eee", minHeight: "100vh", padding: 24 }}>no user yet — text lexa first, then refresh.</main>;
  }
  const s = (d.user?.settings as any) || {};

  // group facts by category
  const factsByCat: Record<string, any[]> = {};
  for (const f of d.facts as any[]) (factsByCat[f.category] ||= []).push(f);

  const jobsPending = d.jobs.filter((j: any) => j.status === "pending").length;
  const jobsDead = d.jobs.filter((j: any) => j.status === "dead");
  const wd = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  return (
    <main style={{ fontFamily: "system-ui", background: "#0b0b0f", color: "#eee", minHeight: "100vh", padding: "24px 16px", maxWidth: 820, margin: "0 auto" }}>
      <h1 style={{ fontSize: 30, margin: "0 0 2px" }}>lexa · control</h1>
      <p style={{ color: "#8b8b99", marginTop: 0 }}>everything she knows and does — view, edit, or wipe anything.</p>

      {/* quick stats */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat label="spend · week" value={d.spendWeek ? `~$${d.spendWeek.total_usd.toFixed(2)}` : "—"} />
        <Stat label="spend · all" value={d.spendAll ? `~$${d.spendAll.total_usd.toFixed(2)}` : "—"} />
        <Stat label="jobs pending" value={String(jobsPending)} />
        <Stat label="jobs dead" value={String(jobsDead.length)} tone={jobsDead.length ? "bad" : "ok"} />
        <Stat label="specialists" value={String(d.subagents.length + 6)} />
      </div>

      {/* integrations */}
      <div style={box}>
        <div style={chip}>integrations</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {["ticktick", "notion", "google", "google2"].map((p) => {
            const r: any = d.integrations.find((i: any) => i.provider === p);
            const on = r?.status === "connected";
            const label = p === "google2" ? "gmail #2" : p;
            const connectPath: Record<string, string> = { ticktick: "/api/connect/ticktick", google: "/api/connect/google", google2: "/api/connect/google2" };
            return (
              <span key={p} style={{ fontSize: 13, padding: "4px 10px", borderRadius: 20, background: on ? "#16301f" : "#2a1a1a", color: on ? "#5fd08a" : "#d08a5f", display: "inline-flex", gap: 6, alignItems: "center" }}>
                {on ? "●" : "○"} {label}{r?.meta?.email ? ` (${r.meta.email})` : ""}
                {!on && connectPath[p] ? <a href={connectPath[p]} style={{ color: "#8fb0ff", textDecoration: "underline" }}>connect →</a> : null}
              </span>
            );
          })}
        </div>
      </div>

      {/* settings */}
      <div style={box}>
        <div style={chip}>settings</div>
        <form data-act="set_settings" style={{ display: "grid", gap: 8, marginTop: 8, gridTemplateColumns: "1fr 1fr 1fr" }}>
          <L t="morning brief hr"><input name="brief_hour" defaultValue={s.brief_hour ?? 8} style={inp} /></L>
          <L t="check-in hr"><input name="checkin_hour" defaultValue={s.checkin_hour ?? 19} style={inp} /></L>
          <L t="planning hr"><input name="planning_hour" defaultValue={s.planning_hour ?? 18} style={inp} /></L>
          <L t="planning day (0=sun)"><input name="planning_weekday" defaultValue={s.planning_weekday ?? 0} style={inp} /></L>
          <L t="timezone"><input name="timezone" defaultValue={d.user?.timezone || "America/New_York"} style={inp} /></L>
          <L t="home address"><input name="home_address" defaultValue={d.user?.home_address || ""} style={inp} /></L>
          <label style={{ fontSize: 13, gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="triage_disabled" defaultChecked={!!s.triage_disabled} /> disable cheap triage (force full brain on every text)
          </label>
          <button style={{ ...add, gridColumn: "1 / -1", padding: 8 }}>save settings</button>
        </form>
      </div>

      {/* SUBAGENTS — build your fleet */}
      <div style={box}>
        <div style={chip}>subagents · your fleet ({d.subagents.length} custom + 6 built-in)</div>
        <div style={{ fontSize: 12, color: "#8b8b99", margin: "6px 0" }}>
          built-in: email · calendar · notion · tasks · research · memory
        </div>
        {(d.subagents as any[]).map((sa) => (
          <div key={sa.id} style={{ ...row, alignItems: "flex-start" }}>
            <span>
              <b style={{ color: "#8fb0ff" }}>{sa.name}</b>{sa.brief ? ` — ${sa.brief}` : ""}
              <div style={{ fontSize: 11, color: "#6b6b77", marginTop: 2 }}>tools: {(sa.tools || []).join(", ")}</div>
            </span>
            <button style={del} data-del="subagent" data-id={sa.id}>delete</button>
          </div>
        ))}
        <form data-act="save_subagent" style={{ marginTop: 12, borderTop: "1px solid #26262f", paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input name="name" placeholder="name (e.g. invoice_parser)" style={{ ...inp, flex: 1 }} />
            <input name="brief" placeholder="one-line brief: who it is + how it works" style={{ ...inp, flex: 2 }} />
          </div>
          <div style={{ marginTop: 8 }}>
            {TOOL_CATALOG.map(([group, tools]) => (
              <div key={group} style={{ marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "#6b6b77", display: "inline-block", width: 96 }}>{group}</span>
                {tools.map((t) => (
                  <label key={t} style={{ fontSize: 12, marginRight: 10, color: "#c7c7d1" }}>
                    <input type="checkbox" name="tools" value={t} /> {t}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <button style={{ ...add, marginTop: 6 }}>+ build specialist</button>
        </form>
      </div>

      {/* FACTS grouped by category */}
      <div style={box}>
        <div style={chip}>memories · facts ({d.facts.length})</div>
        {Object.keys(factsByCat).sort().map((cat) => (
          <div key={cat} style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: "#8fb0ff", fontWeight: 600, marginBottom: 2 }}>{cat}</div>
            {factsByCat[cat].map((f: any) => (
              <div key={f.id} style={row}>
                <span style={{ flex: 1 }}>
                  <b style={{ color: "#8b8b99" }}>{f.key}:</b>{" "}
                  <form data-act="edit_fact" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="hidden" name="id" value={f.id} />
                    <input name="value" defaultValue={f.value} style={{ ...inp, width: 340, marginTop: 0 }} />
                    <button style={add}>save</button>
                  </form>
                </span>
                <button style={del} data-del="fact" data-id={f.id}>forget</button>
              </div>
            ))}
          </div>
        ))}
        <form data-act="add_fact" style={{ display: "flex", gap: 6, marginTop: 12 }}>
          <input name="category" placeholder="category" style={{ ...inp, width: 100 }} />
          <input name="key" placeholder="key" style={{ ...inp, width: 120 }} />
          <input name="value" placeholder="value" style={{ ...inp, flex: 1 }} />
          <button style={add}>+ add</button>
        </form>
      </div>

      {/* GOALS */}
      <div style={box}>
        <div style={chip}>goals ({d.goals.length})</div>
        {(d.goals as any[]).map((g) => (
          <div key={g.id} style={row}>
            <span>{g.title}{g.detail ? ` — ${g.detail}` : ""}</span>
            <button style={del} data-del="goal" data-id={g.id}>drop</button>
          </div>
        ))}
        <form data-act="add_goal" style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input name="title" placeholder="goal" style={{ ...inp, flex: 1 }} />
          <input name="detail" placeholder="detail (optional)" style={{ ...inp, flex: 1 }} />
          <button style={add}>+ add</button>
        </form>
      </div>

      {/* PLAYBOOKS — rules & workflows */}
      <div style={box}>
        <div style={chip}>rules & workflows · playbooks ({d.playbooks.length})</div>
        {(d.playbooks as any[]).map((p) => {
          const auto = (p.format as any)?.automation;
          return (
            <div key={p.id} style={{ ...row, alignItems: "flex-start" }}>
              <span>
                <b>{p.name}</b>
                {auto ? <span style={{ fontSize: 10, color: "#e0b070", marginLeft: 6 }}>⏱ automation</span> : null}
                {!p.active ? <span style={{ fontSize: 10, color: "#8b8b99", marginLeft: 6 }}>(off)</span> : null}
                {p.trigger ? <span style={{ fontSize: 11, color: "#6b6b77" }}> [{p.trigger}]</span> : null}
                <div style={{ fontSize: 12, color: "#c7c7d1", marginTop: 2 }}>{p.instructions}</div>
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button style={btnDo} data-do={JSON.stringify({ action: "toggle_playbook", id: p.id, active: !p.active })}>{p.active ? "pause" : "on"}</button>
                <button style={del} data-del="playbook" data-id={p.id}>del</button>
              </span>
            </div>
          );
        })}
        <form data-act="save_playbook" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input name="name" placeholder="name" style={{ ...inp, width: 140 }} />
            <input name="trigger" placeholder="when (optional)" style={{ ...inp, width: 160 }} />
          </div>
          <textarea name="instructions" placeholder="exactly what to do, in her words" style={{ ...inp, height: 54, marginTop: 6 }} />
          <button style={{ ...add, marginTop: 6 }}>+ save rule/workflow</button>
        </form>
      </div>

      {/* TO-DOS — ticktick */}
      <div style={box}>
        <div style={chip}>to-dos · ticktick</div>
        {!d.todos?.ok ? (
          <div style={{ fontSize: 13, color: "#d08a5f", marginTop: 8 }}>couldn't load ticktick (not connected or api error)</div>
        ) : (
          <>
            {(d.todos.overdue || []).length ? <div style={{ fontSize: 12, color: "#e0708f", marginTop: 8 }}>overdue ({d.todos.counts.overdue})</div> : null}
            {(d.todos.overdue || []).slice(0, 8).map((t: any) => (
              <div key={t.id} style={row}>
                <span>{t.title} <span style={{ color: "#6b6b77", fontSize: 12 }}>· {t.project}</span></span>
                <button style={btnDo} data-do={JSON.stringify({ action: "ticktick_complete", task_id: t.id, project_id: t.projectId })}>done</button>
              </div>
            ))}
            {(d.todos.dated || []).length ? <div style={{ fontSize: 12, color: "#8fb0ff", marginTop: 8 }}>today/soon</div> : null}
            {(d.todos.dated || []).slice(0, 10).map((t: any) => (
              <div key={t.id} style={row}>
                <span>{t.title} <span style={{ color: "#6b6b77", fontSize: 12 }}>· {t.project}</span></span>
                <button style={btnDo} data-do={JSON.stringify({ action: "ticktick_complete", task_id: t.id, project_id: t.projectId })}>done</button>
              </div>
            ))}
            <div style={{ fontSize: 11, color: "#6b6b77", marginTop: 6 }}>
              undated backlog: {d.todos.counts?.undated ?? 0} across {Object.keys(d.todos.undated_by_project || {}).join(", ") || "—"}
            </div>
          </>
        )}
        <form data-act="ticktick_add" style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input name="title" placeholder="new task" style={{ ...inp, flex: 1 }} />
          <input name="project" placeholder="list (optional)" style={{ ...inp, width: 130 }} />
          <button style={add}>+ add</button>
        </form>
      </div>

      {/* REMINDERS */}
      <div style={box}>
        <div style={chip}>reminders ({d.reminders.length})</div>
        {(d.reminders as any[]).map((r) => (
          <div key={r.id} style={row}>
            <span>{r.title} · {new Date(r.due_at).toLocaleString()}{r.recurrence ? ` (${r.recurrence})` : ""}{r.location ? ` @ ${r.location}` : ""}</span>
            <button style={del} data-del="reminder" data-id={r.id}>cancel</button>
          </div>
        ))}
        <form data-act="add_reminder" style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input name="title" placeholder="remind me to…" style={{ ...inp, flex: 1, minWidth: 140 }} />
          <input name="due_at" type="datetime-local" style={{ ...inp, width: 190 }} />
          <input name="location" placeholder="location (optional)" style={{ ...inp, width: 150 }} />
          <button style={add}>+ add</button>
        </form>
      </div>

      {/* COMMITMENTS */}
      <div style={box}>
        <div style={chip}>commitments — what you said you'd do ({d.commitments.length})</div>
        {(d.commitments as any[]).map((c) => (
          <div key={c.id} style={row}>
            <span>
              {c.what}
              <span style={{ fontSize: 11, color: c.status === "kept" ? "#5fd08a" : c.status === "missed" ? "#e0708f" : "#8b8b99", marginLeft: 6 }}>· {c.status}</span>
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              {c.status === "open" || c.status === "nudged" ? (
                <>
                  <button style={add} data-do={JSON.stringify({ action: "resolve_commitment", id: c.id, status: "kept" })}>kept</button>
                  <button style={del} data-do={JSON.stringify({ action: "resolve_commitment", id: c.id, status: "missed" })}>missed</button>
                </>
              ) : null}
              <button style={del} data-del="commitment" data-id={c.id}>del</button>
            </span>
          </div>
        ))}
      </div>

      {/* PLACES */}
      <div style={box}>
        <div style={chip}>places ({d.places.length})</div>
        {(d.places as any[]).map((p) => (
          <div key={p.id} style={row}>
            <span><b>{p.name}</b> — {p.address}</span>
            <button style={del} data-del="place" data-id={p.id}>del</button>
          </div>
        ))}
        <form data-act="add_place" style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input name="name" placeholder="name (home/gym/work)" style={{ ...inp, width: 150 }} />
          <input name="address" placeholder="address" style={{ ...inp, flex: 1 }} />
          <button style={add}>+ add</button>
        </form>
      </div>

      {/* reliability + recent activity */}
      <div style={box}>
        <div style={chip}>reliability</div>
        {jobsDead.length ? (
          jobsDead.slice(0, 6).map((j: any, i: number) => (
            <div key={i} style={{ ...row, color: "#e0708f", fontSize: 13 }}>
              <span>dead: {j.kind}</span>
              <span style={{ color: "#8b8b99", fontSize: 11, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.last_error}</span>
            </div>
          ))
        ) : (
          <div style={{ fontSize: 13, color: "#5fd08a", marginTop: 6 }}>✓ no dead jobs</div>
        )}
        <div style={{ fontSize: 11, color: "#6b6b77", marginTop: 8 }}>recent writes: {(d.audits as any[]).map((a) => `${a.action}${a.verified ? "✓" : "✗"}`).join("  ·  ") || "none yet"}</div>
      </div>

      {/* recent messages */}
      <div style={box}>
        <div style={chip}>recent messages</div>
        {(d.messages as any[]).map((m, i) => (
          <div key={i} style={{ fontSize: 13, padding: "3px 0", color: m.direction === "inbound" ? "#c7c7d1" : "#8fb0ff" }}>
            <b style={{ color: "#6b6b77" }}>{m.direction === "inbound" ? "you" : "lexa"}:</b> {(m.body || "").slice(0, 160)}
          </div>
        ))}
      </div>

      <script dangerouslySetInnerHTML={{ __html: DASH_JS }} />
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div style={{ background: "#15151b", border: "1px solid #26262f", borderRadius: 10, padding: "8px 12px", minWidth: 96 }}>
      <div style={{ fontSize: 10, color: "#8b8b99", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: tone === "bad" ? "#e0708f" : tone === "ok" ? "#5fd08a" : "#eee" }}>{value}</div>
    </div>
  );
}

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return <label style={{ fontSize: 12, color: "#8b8b99" }}>{t}<br />{children}</label>;
}

const DASH_JS = `
async function post(body){const r=await fetch('/api/dashboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok){const e=await r.json().catch(()=>({}));alert('error: '+(e.error||r.status));}return r.ok;}
document.addEventListener('click', async (e)=>{
  const del = e.target.closest('[data-del]');
  if(del){ e.preventDefault(); if(!confirm('remove this?'))return; if(await post({action:'delete',kind:del.dataset.del,id:del.dataset.id}))location.reload(); return; }
  const doo = e.target.closest('[data-do]');
  if(doo){ e.preventDefault(); const p=JSON.parse(doo.dataset.do); if(await post(p))location.reload(); return; }
});
document.addEventListener('submit', async (e)=>{
  const f = e.target.closest('form[data-act]'); if(!f) return; e.preventDefault();
  const fd = new FormData(f); const data = {action:f.dataset.act};
  for(const [k,v] of fd.entries()){ if(data[k]===undefined) data[k]=v; else { if(!Array.isArray(data[k])) data[k]=[data[k]]; data[k].push(v); } }
  if(await post(data)) location.reload();
});
`;
