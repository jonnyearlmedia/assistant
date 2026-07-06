// lexa's control panel — organized into clear TIERS so it's obvious what goes where.
// her brain (instructions) → what she knows (memory) → how she works (workflows + specialists) →
// when she acts (proactive) → your live stuff → under the hood. Owner-only via Vercel Auth.
import { db } from "@/lib/db";
import { ownerUserId } from "@/lib/integrations/tokens";
import { computeSpend, periodSince } from "@/lib/spend";
import * as ticktick from "@/lib/integrations/ticktick";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
      db.from("commitments").select("id,what,follow_up_at,status,outcome").eq("user_id", uid).order("created_at", { ascending: false }).limit(25),
      db.from("subagents").select("id,name,brief,tools,active").eq("user_id", uid).order("name"),
      db.from("places").select("id,name,address").eq("user_id", uid).order("name"),
      db.from("messages").select("direction,body,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(14),
      db.from("jobs").select("status,kind,last_error").order("created_at", { ascending: false }).limit(60),
      db.from("write_audits").select("action,verified").eq("user_id", uid).order("created_at", { ascending: false }).limit(8),
    ]);
  const spendWeek = await computeSpend(periodSince("week")).catch(() => null);
  const spendAll = await computeSpend().catch(() => null);
  let todos: any = null;
  try {
    todos = await ticktick.listTasks("today");
  } catch {}
  return {
    facts: facts.data || [], goals: goals.data || [], playbooks: playbooks.data || [], reminders: reminders.data || [],
    integrations: integrations.data || [], user: user.data, commitments: commitments.data || [], subagents: subagents.data || [],
    places: places.data || [], messages: (messages.data || []).reverse(), jobs: jobs.data || [], audits: audits.data || [],
    spendWeek, spendAll, todos,
  };
}

export default async function Dashboard() {
  const d = await getData();
  if (!d) return <main style={{ fontFamily: "system-ui", background: "#0b0b0f", color: "#eee", minHeight: "100vh", padding: 24 }}>no user yet — text lexa first, then refresh.</main>;
  const s = (d.user?.settings as any) || {};
  const factsByCat: Record<string, any[]> = {};
  for (const f of d.facts as any[]) (factsByCat[f.category] ||= []).push(f);
  const jobsPending = d.jobs.filter((j: any) => j.status === "pending").length;
  const jobsDead = d.jobs.filter((j: any) => j.status === "dead");

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <h1>lexa · control</h1>
        <p className="sub">everything she knows and does. each section says what belongs in it — edit or wipe anything.</p>

        <div className="stats">
          <Stat label="spend·wk" value={d.spendWeek ? `~$${d.spendWeek.total_usd.toFixed(2)}` : "—"} />
          <Stat label="spend·all" value={d.spendAll ? `~$${d.spendAll.total_usd.toFixed(2)}` : "—"} />
          <Stat label="jobs pending" value={String(jobsPending)} />
          <Stat label="jobs dead" value={String(jobsDead.length)} tone={jobsDead.length ? "bad" : "ok"} />
          <Stat label="specialists" value={`${d.subagents.length}+6`} />
        </div>

        {/* ───── TIER 1: her brain ───── */}
        <Tier label="1 · her brain" sub="how she thinks, behaves, and talks — the top-level rules" />
        <Section title="🧠 custom instructions" open help="YOUR standing rules, in your words — 'always X / never Y', your voice, hard preferences. sits above her defaults and applies to every message. this is the highest-level dial.">
          <form data-act="set_instructions">
            <textarea name="instructions" defaultValue={s.custom_instructions || ""} rows={5} className="ta"
              placeholder="e.g. always call me by my first name. no emojis before noon. if i go quiet on a goal for 2 days, push me harder. keep replies to 2 bubbles max unless i ask for detail." />
            <button className="btn add">save instructions</button>
          </form>
        </Section>

        {/* ───── TIER 2: what she knows ───── */}
        <Tier label="2 · what she knows" sub="durable memory about you — the more here, the more she gets you" />
        <Section title="🗂 facts" count={d.facts.length} help="discrete things to remember about you, grouped by category (routine, preference, work, health…). one fact = one key + value. use for stable truths, not tasks.">
          {Object.keys(factsByCat).sort().map((cat) => (
            <div key={cat} className="catgrp">
              <div className="catname">{cat}</div>
              {factsByCat[cat].map((f: any) => (
                <div key={f.id} className="row">
                  <form data-act="edit_fact" className="frm grow">
                    <input type="hidden" name="id" value={f.id} />
                    <span className="fkey">{f.key}</span>
                    <input name="value" defaultValue={f.value} className="in grow" />
                    <button className="btn add sm">save</button>
                  </form>
                  <button className="btn del sm" data-del="fact" data-id={f.id}>forget</button>
                </div>
              ))}
            </div>
          ))}
          <form data-act="add_fact" className="frm mt">
            <input name="category" placeholder="category" className="in" style={{ maxWidth: 120 }} />
            <input name="key" placeholder="key" className="in" style={{ maxWidth: 130 }} />
            <input name="value" placeholder="value" className="in grow" />
            <button className="btn add">+ add</button>
          </form>
        </Section>
        <Section title="🎯 goals" count={d.goals.length} help="what you're working toward. she holds you accountable to these over time — bigger than a single task.">
          {(d.goals as any[]).map((g) => (
            <div key={g.id} className="row"><span>{g.title}{g.detail ? ` — ${g.detail}` : ""}</span><button className="btn del sm" data-del="goal" data-id={g.id}>drop</button></div>
          ))}
          <form data-act="add_goal" className="frm mt"><input name="title" placeholder="goal" className="in grow" /><input name="detail" placeholder="detail (optional)" className="in grow" /><button className="btn add">+ add</button></form>
        </Section>
        <Section title="📍 places" count={d.places.length} help="named addresses (home, gym, work) so 'leave now' reminders and drive-times work.">
          {(d.places as any[]).map((p) => (<div key={p.id} className="row"><span><b>{p.name}</b> — {p.address}</span><button className="btn del sm" data-del="place" data-id={p.id}>del</button></div>))}
          <form data-act="add_place" className="frm mt"><input name="name" placeholder="home/gym/work" className="in" style={{ maxWidth: 150 }} /><input name="address" placeholder="address" className="in grow" /><button className="btn add">+ add</button></form>
        </Section>

        {/* ───── TIER 3: how she works ───── */}
        <Tier label="3 · how she works" sub="repeatable procedures + the specialist workers that run them" />
        <Section title="📋 rules & workflows" count={d.playbooks.length} help="taught step-by-step procedures & formats — 'when i log a workout, put it in notion like THIS'. use for anything she should do a consistent way every time. (⏱ = runs on a schedule.)">
          {(d.playbooks as any[]).map((p) => {
            const auto = (p.format as any)?.automation;
            return (
              <div key={p.id} className="row col">
                <span><b>{p.name}</b>{auto ? <span className="tag amber">⏱ auto</span> : null}{!p.active ? <span className="tag muted">off</span> : null}{p.trigger ? <span className="dim"> [{p.trigger}]</span> : null}<div className="dim2">{p.instructions}</div></span>
                <span className="actions">
                  <button className="btn do sm" data-do={JSON.stringify({ action: "toggle_playbook", id: p.id, active: !p.active })}>{p.active ? "pause" : "on"}</button>
                  <button className="btn del sm" data-del="playbook" data-id={p.id}>del</button>
                </span>
              </div>
            );
          })}
          <form data-act="save_playbook" className="mt">
            <div className="frm"><input name="name" placeholder="name" className="in" style={{ maxWidth: 160 }} /><input name="trigger" placeholder="when (optional)" className="in grow" /></div>
            <textarea name="instructions" rows={2} className="ta mt6" placeholder="exactly what to do, in her words" />
            <button className="btn add mt6">+ save rule/workflow</button>
          </form>
        </Section>
        <Section title="🤖 subagents" count={`${d.subagents.length} custom`} help="specialist workers she delegates to — one per job area. built-in: email · calendar · notion · tasks · research · memory. build your own below: name it, brief it, tick the tools it may use.">
          {(d.subagents as any[]).map((sa) => (
            <div key={sa.id} className="row col">
              <span><b className="blue">{sa.name}</b>{sa.brief ? ` — ${sa.brief}` : ""}<div className="dim2">tools: {(sa.tools || []).join(", ")}</div></span>
              <button className="btn del sm" data-del="subagent" data-id={sa.id}>delete</button>
            </div>
          ))}
          <form data-act="save_subagent" className="mt builder">
            <div className="frm"><input name="name" placeholder="name (e.g. invoice_parser)" className="in grow" /><input name="brief" placeholder="one-line brief: who it is + how it works" className="in grow" /></div>
            <div className="tools">
              {TOOL_CATALOG.map(([group, tools]) => (
                <div key={group} className="toolgrp">
                  <span className="toolgroupname">{group}</span>
                  {tools.map((t) => (<label key={t} className="tk"><input type="checkbox" name="tools" value={t} /> {t}</label>))}
                </div>
              ))}
            </div>
            <button className="btn add mt6">+ build specialist</button>
          </form>
        </Section>

        {/* ───── TIER 4: when she acts on her own ───── */}
        <Tier label="4 · when she acts on her own" sub="proactive nudges & follow-through" />
        <Section title="⏰ reminders" count={d.reminders.length} help="one-off or recurring nudges at a specific time. for a specific moment — unlike a goal (ongoing) or a rule (a procedure).">
          {(d.reminders as any[]).map((r) => (<div key={r.id} className="row"><span>{r.title} · {new Date(r.due_at).toLocaleString()}{r.recurrence ? ` (${r.recurrence})` : ""}{r.location ? ` @ ${r.location}` : ""}</span><button className="btn del sm" data-del="reminder" data-id={r.id}>cancel</button></div>))}
          <form data-act="add_reminder" className="frm mt"><input name="title" placeholder="remind me to…" className="in grow" /><input name="due_at" type="datetime-local" className="in" /><input name="location" placeholder="location (optional)" className="in" style={{ maxWidth: 150 }} /><button className="btn add">+ add</button></form>
        </Section>
        <Section title="🤝 commitments" count={d.commitments.length} help="things you said you'd do ('i'll hit the gym later') — she catches these from your texts and follows up. mark kept/missed to build your accountability record.">
          {(d.commitments as any[]).map((c) => (
            <div key={c.id} className="row">
              <span>{c.what}<span className={`tag ${c.status === "kept" ? "green" : c.status === "missed" ? "red" : "muted"}`}>{c.status}</span></span>
              <span className="actions">
                {c.status === "open" || c.status === "nudged" ? (<>
                  <button className="btn add sm" data-do={JSON.stringify({ action: "resolve_commitment", id: c.id, status: "kept" })}>kept</button>
                  <button className="btn del sm" data-do={JSON.stringify({ action: "resolve_commitment", id: c.id, status: "missed" })}>missed</button>
                </>) : null}
                <button className="btn del sm" data-del="commitment" data-id={c.id}>del</button>
              </span>
            </div>
          ))}
        </Section>

        {/* ───── TIER 5: your live stuff ───── */}
        <Tier label="5 · your live stuff" sub="pulled live from your connected apps" />
        <Section title="✅ to-dos · ticktick" help="live from ticktick (your source of truth). complete a task or quick-add one here.">
          {!d.todos?.ok ? <div className="warn">couldn't load ticktick (not connected or api error)</div> : (<>
            {(d.todos.overdue || []).length ? <div className="grouplbl red">overdue ({d.todos.counts.overdue})</div> : null}
            {(d.todos.overdue || []).slice(0, 8).map((t: any) => (<div key={t.id} className="row"><span>{t.title} <span className="dim">· {t.project}</span></span><button className="btn do sm" data-do={JSON.stringify({ action: "ticktick_complete", task_id: t.id, project_id: t.projectId })}>done</button></div>))}
            {(d.todos.dated || []).length ? <div className="grouplbl blue">today / soon</div> : null}
            {(d.todos.dated || []).slice(0, 10).map((t: any) => (<div key={t.id} className="row"><span>{t.title} <span className="dim">· {t.project}</span></span><button className="btn do sm" data-do={JSON.stringify({ action: "ticktick_complete", task_id: t.id, project_id: t.projectId })}>done</button></div>))}
            <div className="dim mt6">undated backlog: {d.todos.counts?.undated ?? 0} across {Object.keys(d.todos.undated_by_project || {}).join(", ") || "—"}</div>
          </>)}
          <form data-act="ticktick_add" className="frm mt"><input name="title" placeholder="new task" className="in grow" /><input name="project" placeholder="list (optional)" className="in" style={{ maxWidth: 130 }} /><button className="btn add">+ add</button></form>
        </Section>

        {/* ───── TIER 6: under the hood ───── */}
        <Tier label="6 · under the hood" sub="config, connections, health" />
        <Section title="⚙️ settings" help="when her proactive stuff fires + how she runs.">
          <form data-act="set_settings" className="grid3">
            <L t="brief hr"><input name="brief_hour" defaultValue={s.brief_hour ?? 8} className="in" /></L>
            <L t="check-in hr"><input name="checkin_hour" defaultValue={s.checkin_hour ?? 19} className="in" /></L>
            <L t="planning hr"><input name="planning_hour" defaultValue={s.planning_hour ?? 18} className="in" /></L>
            <L t="planning day (0=sun)"><input name="planning_weekday" defaultValue={s.planning_weekday ?? 0} className="in" /></L>
            <L t="timezone"><input name="timezone" defaultValue={d.user?.timezone || "America/New_York"} className="in" /></L>
            <L t="home address"><input name="home_address" defaultValue={d.user?.home_address || ""} className="in" /></L>
            <label className="ckrow"><input type="checkbox" name="triage_disabled" defaultChecked={!!s.triage_disabled} /> disable cheap triage (full brain on every text)</label>
            <button className="btn add wide">save settings</button>
          </form>
        </Section>
        <Section title="🔌 integrations" help="connect services yourself with the links — no dev needed.">
          <div className="chips">
            {["ticktick", "notion", "google", "google2"].map((p) => {
              const r: any = d.integrations.find((i: any) => i.provider === p);
              const on = r?.status === "connected";
              const label = p === "google2" ? "gmail #2" : p;
              const path: Record<string, string> = { ticktick: "/api/connect/ticktick", google: "/api/connect/google", google2: "/api/connect/google2" };
              return <span key={p} className={`chip ${on ? "on" : "off"}`}>{on ? "●" : "○"} {label}{r?.meta?.email ? ` (${r.meta.email})` : ""}{!on && path[p] ? <a href={path[p]} className="connect">connect →</a> : null}</span>;
            })}
          </div>
        </Section>
        <Section title="🩺 reliability & activity" help="is her proactive engine healthy, what she wrote, what she's been saying.">
          {jobsDead.length ? jobsDead.slice(0, 6).map((j: any, i: number) => (<div key={i} className="row red sm"><span>dead: {j.kind}</span><span className="dim ell">{j.last_error}</span></div>)) : <div className="ok">✓ no dead jobs</div>}
          <div className="dim mt6">recent writes: {(d.audits as any[]).map((a) => `${a.action}${a.verified ? "✓" : "✗"}`).join("  ·  ") || "none yet"}</div>
          <div className="msgs mt6">{(d.messages as any[]).map((m, i) => (<div key={i} className="msg"><b className={m.direction === "inbound" ? "you" : "her"}>{m.direction === "inbound" ? "you" : "lexa"}:</b> {(m.body || "").slice(0, 160)}</div>))}</div>
        </Section>
      </div>
      <script dangerouslySetInnerHTML={{ __html: DASH_JS }} />
    </main>
  );
}

function Tier({ label, sub }: { label: string; sub: string }) {
  return <div className="tier"><span className="tierlbl">{label}</span><span className="tiersub">{sub}</span></div>;
}
function Section({ title, help, count, open, children }: { title: string; help: string; count?: any; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="card" open={open}>
      <summary><span className="stitle">{title}</span>{count != null ? <span className="count">{count}</span> : null}<span className="chev">▾</span></summary>
      <div className="help">{help}</div>
      <div className="secbody">{children}</div>
    </details>
  );
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return <div className="stat"><div className="statlbl">{label}</div><div className={`statval ${tone || ""}`}>{value}</div></div>;
}
function L({ t, children }: { t: string; children: React.ReactNode }) {
  return <label className="lbl">{t}<br />{children}</label>;
}

const CSS = `
:root{--bg:#0b0b0f;--card:#15151b;--bd:#26262f;--in:#0d0d12;--txt:#eee;--dim:#8b8b99;--dim2:#c7c7d1;--green:#5fd08a;--red:#e0708f;--blue:#8fb0ff;--amber:#e0b070}
*{box-sizing:border-box}
main{font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--txt);min-height:100vh}
.wrap{max-width:680px;margin:0 auto;padding:22px 14px 60px}
h1{font-size:28px;margin:0 0 2px}
.sub{color:var(--dim);margin:0 0 16px;font-size:14px}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:8px 12px;flex:1;min-width:90px}
.statlbl{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
.statval{font-size:18px;font-weight:700}
.statval.bad{color:var(--red)}.statval.ok{color:var(--green)}
.tier{margin:22px 0 8px;padding-left:2px}
.tierlbl{font-size:12px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.6px}
.tiersub{display:block;font-size:12px;color:var(--dim);margin-top:1px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:2px 14px;margin-bottom:10px}
summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:12px 0;font-size:16px;font-weight:600}
summary::-webkit-details-marker{display:none}
.stitle{flex:1}
.count{font-size:12px;color:var(--dim);background:#0d0d12;border:1px solid var(--bd);border-radius:20px;padding:1px 9px}
.chev{color:var(--dim);font-size:12px;transition:transform .15s}
details[open] .chev{transform:rotate(180deg)}
.help{font-size:12.5px;color:var(--dim);margin:-2px 0 10px;line-height:1.45}
.secbody{padding-bottom:14px}
.row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #1c1c24;font-size:14px}
.row.col{align-items:flex-start}
.row.sm{font-size:13px}
.actions{display:flex;gap:6px;flex-shrink:0}
.grow{flex:1;min-width:0}
.frm{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.mt{margin-top:12px}.mt6{margin-top:6px}
.in,.ta{background:var(--in);border:1px solid var(--bd);color:var(--txt);border-radius:8px;padding:10px;font-size:16px;width:100%;font-family:inherit}
.in{min-width:110px}
.ta{resize:vertical;line-height:1.5}
.btn{border-radius:8px;padding:8px 12px;cursor:pointer;font-size:14px;border:1px solid;background:transparent;font-family:inherit}
.btn.sm{padding:5px 9px;font-size:12px}
.btn.add{border-color:#254a3a;color:var(--green)}
.btn.del{border-color:#3a2530;color:var(--red)}
.btn.do{border-color:#2f3550;color:var(--blue)}
.btn.wide{width:100%;padding:11px}
.fkey{color:var(--dim);font-size:13px;white-space:nowrap}
.catgrp{margin-top:10px}
.catname{font-size:12px;color:var(--blue);font-weight:600;margin-bottom:2px}
.dim{color:var(--dim);font-size:12px}
.dim2{color:var(--dim2);font-size:12.5px;margin-top:3px;line-height:1.4}
.ell{max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:10px;border-radius:5px;padding:1px 6px;margin-left:6px}
.tag.amber{color:var(--amber)}.tag.muted{color:var(--dim)}.tag.green{color:var(--green)}.tag.red{color:var(--red)}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.lbl{font-size:12px;color:var(--dim)}
.ckrow{grid-column:1/-1;font-size:13px;display:flex;align-items:center;gap:8px;color:var(--dim2)}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{font-size:13px;padding:5px 11px;border-radius:20px;display:inline-flex;gap:6px;align-items:center}
.chip.on{background:#16301f;color:var(--green)}.chip.off{background:#2a1a1a;color:#d08a5f}
.connect{color:var(--blue);text-decoration:underline}
.builder .tools{margin-top:10px}
.toolgrp{margin-bottom:7px;line-height:1.9}
.toolgroupname{font-size:11px;color:#6b6b77;display:inline-block;width:92px;vertical-align:top}
.tk{font-size:12.5px;margin-right:10px;color:var(--dim2);white-space:nowrap}
.grouplbl{font-size:12px;margin-top:10px}.grouplbl.red{color:var(--red)}.grouplbl.blue{color:var(--blue)}
.warn{font-size:13px;color:#d08a5f;margin-top:8px}
.ok{font-size:13px;color:var(--green);margin-top:6px}
.blue{color:var(--blue)}
.msgs .msg{font-size:13px;padding:3px 0}.msg .you{color:#6b6b77}.msg .her{color:var(--blue)}
@media(max-width:520px){.grid3{grid-template-columns:1fr 1fr}.stat{min-width:calc(50% - 4px)}.in{font-size:16px}}
`;

const DASH_JS = `
async function post(body){const r=await fetch('/api/dashboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok){const e=await r.json().catch(()=>({}));alert('error: '+(e.error||r.status));}return r.ok;}
document.addEventListener('click', async (e)=>{
  const del=e.target.closest('[data-del]'); if(del){ e.preventDefault(); if(!confirm('remove this?'))return; if(await post({action:'delete',kind:del.dataset.del,id:del.dataset.id}))location.reload(); return; }
  const doo=e.target.closest('[data-do]'); if(doo){ e.preventDefault(); if(await post(JSON.parse(doo.dataset.do)))location.reload(); return; }
});
document.addEventListener('submit', async (e)=>{
  const f=e.target.closest('form[data-act]'); if(!f)return; e.preventDefault();
  const fd=new FormData(f); const data={action:f.dataset.act};
  for(const [k,v] of fd.entries()){ if(data[k]===undefined)data[k]=v; else{ if(!Array.isArray(data[k]))data[k]=[data[k]]; data[k].push(v);} }
  if(await post(data))location.reload();
});
`;
