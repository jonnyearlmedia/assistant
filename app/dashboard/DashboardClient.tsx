"use client";
import { useState } from "react";

// plain-english abilities for helpers (map to real tools server-side)
const ABILITIES: [string, string, string][] = [
  ["email", "📧", "Email"],
  ["calendar", "📅", "Calendar"],
  ["notion", "📝", "Notion"],
  ["todos", "✅", "To-dos"],
  ["web", "🔎", "Web search"],
  ["memory", "🧠", "Memory"],
  ["files", "📁", "Files"],
];
const CAP_TOOLS: Record<string, string[]> = {
  email: ["gmail_search", "gmail_send", "gmail_draft"],
  calendar: ["gcal_upcoming", "gcal_create", "gcal_update", "gcal_delete", "drive_time"],
  notion: ["notion_search", "notion_read", "notion_query_db", "notion_create_page", "notion_append", "notion_log", "list_master_planner"],
  todos: ["ticktick_list", "ticktick_create_task", "ticktick_projects", "ticktick_complete", "ticktick_update", "ticktick_delete"],
  web: ["web_search"],
  memory: ["recall", "list_facts", "remember_fact"],
  files: ["drive_search", "drive_read"],
};
function abilitiesFor(tools: string[]): string {
  const out: string[] = [];
  for (const [cap, ts] of Object.entries(CAP_TOOLS)) if (ts.some((t) => tools.includes(t))) out.push(ABILITIES.find((a) => a[0] === cap)![1] + " " + ABILITIES.find((a) => a[0] === cap)![2]);
  return out.join("   ") || "nothing yet";
}

// her baked-in behavior — shown read-only so you know what's already governing her
const CORE_RULES = [
  "reads every change back and confirms it before she says \"done\"",
  "keeps texts short and human — like a real person, not a bot",
  "has a backbone: no fake apologies, won't cave when she's right",
  "everything she knows lives in this dashboard — all of it editable",
];

// one-tap starting areas (his own list) — shown only until he's added them
const SUGGESTED_AREAS = ["School", "VPH", "Shoots", "Work", "Therapy", "Appointments", "Workouts"];

const EXAMPLES = [
  "call me jonny, not jonathan",
  "gym at 6am mon / wed / fri",
  "remind me to call mom sunday at 5pm",
  "when I send a food pic, log the macros in notion",
  "keep replies short unless I ask for detail",
];

const NAV: [string, string][] = [
  ["knows", "🧠 knows"],
  ["rules", "🗣️ rules"],
  ["goals", "🎯 goals"],
  ["helpers", "🤖 helpers"],
  ["howtos", "📋 how-tos"],
  ["mood", "🧠 mood"],
  ["reminders", "⏰ reminders"],
  ["todos", "✅ to-dos"],
  ["settings", "⚙️ settings"],
];

export default function DashboardClient({ initial }: { initial: any }) {
  const [d, setD] = useState<any>(initial);
  const [toast, setToast] = useState("");
  const [dump, setDump] = useState("");
  const [sorting, setSorting] = useState("");
  const [area, setArea] = useState<string>(""); // "" = All
  const [manageAreas, setManageAreas] = useState(false);

  async function refresh() {
    try {
      const r = await fetch("/api/dashboard");
      if (r.ok) {
        const j = await r.json();
        if (j && j.facts) setD(j);
      }
    } catch {}
  }
  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 2600);
  }
  async function api(action: string, body: any, msg = "✓ saved") {
    try {
      const r = await fetch("/api/dashboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { flash("⚠️ " + (j.error || "couldn't save")); return false; }
      flash(msg);
      await refresh();
      return true;
    } catch {
      flash("⚠️ network error");
      return false;
    }
  }
  async function del(kind: string, id: string) {
    if (!confirm("Remove this?")) return;
    await api("delete", { kind, id }, "removed");
  }
  async function sortDump() {
    if (!dump.trim()) return;
    setSorting("sorting…");
    try {
      const r = await fetch("/api/dashboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "organize", text: dump, area: area || undefined }) });
      const j = await r.json().catch(() => ({}));
      setSorting((j.ok ? "✓ " : "") + (j.summary || j.error || "done"));
      if (j.ok) { setDump(""); await refresh(); }
    } catch {
      setSorting("⚠️ something went wrong");
    }
  }

  const s = d.settings || {};
  const areas: any[] = d.areas || [];
  const areaName = (id: string) => areas.find((a) => a.id === id)?.name || id;
  const activeArea = areas.find((a) => a.id === area);
  const inArea = (it: any) => !area || it.area === area; // "" = All shows everything
  // area-filtered collections (used everywhere so counts + lists agree)
  const fFacts = d.facts.filter(inArea);
  const fGoals = d.goals.filter(inArea);
  const fPlaybooks = d.playbooks.filter(inArea);
  const fReminders = d.reminders.filter(inArea);
  const fSubagents = d.subagents.filter(inArea);
  const scoped = !!area; // a specific area is selected → hide global-only cards
  const factsByCat: Record<string, any[]> = {};
  for (const f of fFacts) (factsByCat[f.category] ||= []).push(f);
  // pass the active area into any create/tag call
  const withArea = (body: any) => (area ? { ...body, area } : body);
  // compact per-row "which area" picker (only shown once he has areas)
  const AreaSel = ({ kind, it }: any) =>
    areas.length ? (
      <select className="areasel" value={it.area || ""} onChange={(e) => api("set_area", { kind, id: it.id, area: e.target.value }, "✓ filed")}>
        <option value="">· area ·</option>
        {areas.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    ) : null;

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="topbar">
        <div className="wrap tbrow">
          <div className="brand">lexa</div>
          <div className="tbstat">{d.spendWeek != null ? `~$${d.spendWeek.toFixed(2)}/wk` : ""}{d.deadJobs ? "  ·  ⚠️" : ""}</div>
        </div>
        <div className="wrap">
          <div className="nav">{NAV.map(([id, label]) => <a key={id} href={`#${id}`} className="navpill">{label}</a>)}</div>
        </div>
        <div className="wrap">
          <div className="areabar">
            <button className={`areapill ${area === "" ? "on" : ""}`} onClick={() => setArea("")}>All</button>
            {areas.map((a: any) => (
              <button key={a.id} className={`areapill ${area === a.id ? "on" : ""}`} onClick={() => setArea(a.id)}>
                <span className="aemoji">{a.emoji || "🗂️"}</span>{a.name}
              </button>
            ))}
            <button className="areapill add" onClick={() => setManageAreas((v) => !v)}>＋ areas</button>
          </div>
        </div>
      </div>

      <div className="wrap body">
        {manageAreas ? (
          <AreaManager areas={areas} onAdd={(b: any) => api("add_area", b, "✓ area added")} onEdit={(b: any) => api("edit_area", b, "✓ renamed")} onDelete={(id: string) => { if (confirm("Delete this area? Its items stay, they just lose the tag.")) api("delete_area", { id }, "area removed"); }} onClose={() => setManageAreas(false)} />
        ) : null}

        <p className="lead">
          {scoped
            ? <>Showing just <b>{activeArea?.emoji} {activeArea?.name}</b>. Anything you add here is filed into it automatically.</>
            : <>Your assistant, your way. Pick an area up top to focus, or just tell her anything below — she'll sort it.</>}
        </p>

        {/* HERO */}
        <div className="hero">
          <div className="herohead">✍️ Tell me anything{scoped ? ` · ${activeArea?.name}` : ""}</div>
          <div className="herohelp">Write it however you want. She figures out if it's a rule, a fact, a goal, a reminder, or a how-to — and files it{scoped ? <> under <b>{activeArea?.name}</b></> : ""}.</div>
          <textarea className="ta big" rows={4} value={dump} onChange={(e) => setDump(e.target.value)} placeholder={"e.g. call me jonny. gym at 6am mon/wed/fri. remind me to renew my license next friday."} />
          <div className="chipsrow">{EXAMPLES.map((ex) => <button key={ex} className="exchip" onClick={() => setDump((v) => (v ? v + "\n" : "") + ex)}>+ {ex}</button>)}</div>
          <button className="btn primary" onClick={sortDump}>Sort it for me{scoped ? ` into ${activeArea?.name}` : ""} →</button>
          {sorting ? <div className="sortres">{sorting}</div> : null}
        </div>

        {/* RULES (global — only under All) */}
        {!scoped ? (
          <Card id="rules" icon="🗣️" title="How she talks to you" open help="Standing rules for how she acts & sounds. Your rules beat her defaults, every message.">
            <div className="corebox">
              <div className="corelbl">always on (built in)</div>
              {CORE_RULES.map((r) => <div key={r} className="corerule">✓ {r}</div>)}
            </div>
            <div className="yourlbl">your rules — edit or remove any, add as many as you want</div>
            <RulesList
              items={parseRules(s.custom_instructions)}
              onSave={(items: string[]) => api("set_instruction_list", { items }, "✓ rules updated")}
            />
          </Card>
        ) : null}

        {/* KNOWS */}
        <Card id="knows" icon="🧠" title="What she knows about you" count={fFacts.length} help="Things to remember about you. Type anything — no format needed.">
          {Object.keys(factsByCat).sort().map((cat) => (
            <div key={cat} className="catgrp">
              <div className="catname">{cat}</div>
              {factsByCat[cat].map((f: any) => (
                <InlineRow key={f.id} value={f.value} onSave={(v: any) => api("edit_fact", { id: f.id, value: v }, "✓ updated")} onDelete={() => del("fact", f.id)} extra={<AreaSel kind="fact" it={f} />} />
              ))}
            </div>
          ))}
          {fFacts.length === 0 ? <Empty text={scoped ? "Nothing filed here yet — add something below." : "Nothing yet — add something she should remember."} /> : null}
          <AddRow fields={[{ name: "category", ph: "topic (optional)", w: 120 }, { name: "value", ph: "something she should remember…", grow: true }]} onAdd={(vals: any) => api("add_fact", withArea(vals), "✓ added")} />
        </Card>

        {/* GOALS */}
        <Card id="goals" icon="🎯" title="Your goals" count={fGoals.length} help="What you're working toward. She keeps you honest.">
          {fGoals.map((g: any) => <SimpleRow key={g.id} text={`${g.title}${g.detail ? " — " + g.detail : ""}`} onDelete={() => del("goal", g.id)} delLabel="drop" extra={<AreaSel kind="goal" it={g} />} />)}
          {fGoals.length === 0 ? <Empty text="No goals set. What are you working toward?" /> : null}
          <AddRow fields={[{ name: "title", ph: "a goal…", grow: true }, { name: "detail", ph: "detail (optional)", grow: true }]} onAdd={(vals: any) => api("add_goal", withArea(vals), "✓ added")} />
        </Card>

        {/* HELPERS */}
        <Card id="helpers" icon="🤖" title="Your helpers" count={fSubagents.length} help="Little specialists she hands specific jobs to. She has built-in ones already; build your own and just flip on what it can touch.">
          {fSubagents.map((sa: any) => (
            <div key={sa.id} className="hrow">
              <div><div className="hname">{sa.name}</div>{sa.brief ? <div className="dim2">{sa.brief}</div> : null}<div className="dim3">can use: {abilitiesFor(sa.tools || [])}</div></div>
              <span className="actions"><AreaSel kind="subagent" it={sa} /><button className="btn danger sm" onClick={() => del("subagent", sa.id)}>delete</button></span>
            </div>
          ))}
          {scoped && fSubagents.length === 0 ? <div className="suggesthelp">No {activeArea?.name} helper yet — build one below and it'll handle {activeArea?.name} jobs for you.</div> : null}
          <HelperBuilder seedName={scoped ? activeArea?.name : ""} onBuild={(body: any) => api("save_subagent", withArea(body), "✓ helper built")} />
        </Card>

        {/* HOW-TOS */}
        <Card id="howtos" icon="📋" title="How-tos" count={fPlaybooks.length} help="Things you've taught her to do a certain way. Edit any of them right here.">
          {fPlaybooks.map((p: any) => (
            <PlaybookRow key={p.id} p={p} onSave={(body: any) => api("save_playbook", withArea(body), "✓ updated")} onToggle={() => api("toggle_playbook", { id: p.id, active: !p.active }, p.active ? "paused" : "resumed")} onDelete={() => del("playbook", p.id)} extra={<AreaSel kind="playbook" it={p} />} />
          ))}
          {fPlaybooks.length === 0 ? <Empty text="None yet. Teach her a routine (or just use the box at the top)." /> : null}
          <NewPlaybook onSave={(body: any) => api("save_playbook", withArea(body), "✓ created")} />
        </Card>

        {/* MOOD (global — only under All) */}
        {!scoped ? (
          <Card id="mood" icon="🧠" title="Mood check-ins" open={(d.moods || []).length === 0} help="She texts you once per 4-hour block (at a random time inside it), reads a 1–10 + a word + a quick why, and logs it to your health_mood tracker — the heatmap you show in therapy.">
            <MoodSection d={d} onSave={(body: any) => api("set_mood", body, "✓ mood check-ins saved")} />
          </Card>
        ) : null}

        {/* REMINDERS */}
        <Card id="reminders" icon="⏰" title="Reminders" count={fReminders.length} help="Nudges at a specific time. Tap edit to fix the wording or the time — changing a fact above won't move these, they're their own thing.">
          {fReminders.map((r: any) => (
            <ReminderRow key={r.id} r={r} onSave={(body: any) => api("edit_reminder", { id: r.id, ...body }, "✓ reminder updated")} onDelete={() => del("reminder", r.id)} extra={<AreaSel kind="reminder" it={r} />} />
          ))}
          {fReminders.length === 0 ? <Empty text="No reminders set." /> : null}
          <ReminderAdd onAdd={(body: any) => api("add_reminder", withArea(body), "✓ reminder set")} />
        </Card>

        {/* the rest are global — only shown under All */}
        {!scoped ? <>
        {/* PROMISES */}
        <Card id="promises" icon="🤝" title="Promises you made" count={d.commitments.length} help="Things you said you'd do — she follows up.">
          {d.commitments.map((c: any) => (
            <div key={c.id} className="row">
              <span>{c.what} <span className={`tag ${c.status === "kept" ? "green" : c.status === "missed" ? "red" : "muted"}`}>{c.status}</span></span>
              <span className="actions">
                {(c.status === "open" || c.status === "nudged") ? <>
                  <button className="btn ok sm" onClick={() => api("resolve_commitment", { id: c.id, status: "kept" }, "✓ nice")}>did it</button>
                  <button className="btn danger sm" onClick={() => api("resolve_commitment", { id: c.id, status: "missed" }, "logged")}>nope</button>
                </> : null}
                <button className="btn ghost sm" onClick={() => del("commitment", c.id)}>✕</button>
              </span>
            </div>
          ))}
          {d.commitments.length === 0 ? <Empty text="Nothing tracked yet." /> : null}
        </Card>

        {/* TO-DOS */}
        <Card id="todos" icon="✅" title="Your to-dos" help="Live from TickTick.">
          {!d.todos ? <Empty text="Couldn't load TickTick right now." /> : <>
            {d.todos.overdue.slice(0, 8).map((t: any) => <div key={t.id} className="row"><span>⚠️ {t.title} <span className="dim">· {t.project}</span></span><button className="btn ok sm" onClick={() => api("ticktick_complete", { task_id: t.id, project_id: t.projectId }, "✓ done")}>done</button></div>)}
            {d.todos.dated.slice(0, 10).map((t: any) => <div key={t.id} className="row"><span>{t.title} <span className="dim">· {t.project}</span></span><button className="btn ok sm" onClick={() => api("ticktick_complete", { task_id: t.id, project_id: t.projectId }, "✓ done")}>done</button></div>)}
          </>}
          <AddRow fields={[{ name: "title", ph: "new task", grow: true }]} onAdd={(vals: any) => api("ticktick_add", vals, "✓ added")} addLabel="+ add task" />
        </Card>

        {/* PLACES */}
        <Card id="places" icon="📍" title="Places" count={d.places.length} help="Named addresses for drive-time reminders.">
          {d.places.map((p: any) => <SimpleRow key={p.id} text={`${p.name} — ${p.address}`} onDelete={() => del("place", p.id)} delLabel="✕" />)}
          <AddRow fields={[{ name: "name", ph: "home / gym / work", w: 130 }, { name: "address", ph: "address", grow: true }]} onAdd={(vals: any) => api("add_place", vals, "✓ saved")} />
        </Card>

        {/* SETTINGS */}
        <Card id="settings" icon="⚙️" title="Settings & connections" help="When she checks in, and which apps are linked.">
          <SettingsForm d={d} onSave={(body: any) => api("set_settings", body, "✓ settings saved")} />
          <div className="chips">
            {["ticktick", "notion", "google", "google2"].map((p) => {
              const r: any = d.integrations.find((i: any) => i.provider === p);
              const on = r?.status === "connected";
              const label = p === "google2" ? "gmail #2" : p;
              const path: Record<string, string> = { ticktick: "/api/connect/ticktick", google: "/api/connect/google", google2: "/api/connect/google2" };
              return <span key={p} className={`chip ${on ? "on" : "off"}`}>{on ? "✓" : "○"} {label}{r?.meta?.email ? ` (${r.meta.email})` : ""}{!on && path[p] ? <a href={path[p]} className="connect">connect</a> : null}</span>;
            })}
          </div>
        </Card>

        <Card id="advanced" icon="🩺" title="Advanced (you can ignore this)" help="Behind-the-scenes health & recent activity.">
          <div className="dim">this week: {d.spendWeek != null ? `~$${d.spendWeek.toFixed(2)}` : "—"} · {d.deadJobs ? `⚠️ ${d.deadJobs} failed jobs` : "✓ running clean"}</div>
          <div className="msgs">{d.messages.map((m: any, i: number) => <div key={i} className="msg"><b className={m.direction === "inbound" ? "you" : "her"}>{m.direction === "inbound" ? "you" : "lexa"}:</b> {(m.body || "").slice(0, 130)}</div>)}</div>
        </Card>
        </> : null}
      </div>

      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </main>
  );
}

/* ---------- small components ---------- */
function Card({ id, icon, title, count, help, open, children }: any) {
  return (
    <details id={id} className="card" open={open}>
      <summary><span className="cicon">{icon}</span><span className="ctitle">{title}</span>{count != null ? <span className="count">{count}</span> : null}<span className="chev">▾</span></summary>
      <div className="help">{help}</div>
      <div className="secbody">{children}</div>
    </details>
  );
}
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function SimpleRow({ text, onDelete, delLabel, extra }: any) {
  return <div className="row"><span>{text}</span><span className="actions">{extra}<button className="btn ghost sm" onClick={onDelete}>{delLabel || "✕"}</button></span></div>;
}
function InlineRow({ value, onSave, onDelete, extra }: any) {
  const [v, setV] = useState(value);
  const dirty = v !== value;
  return (
    <div className="row">
      <input className="in grow" value={v} onChange={(e) => setV(e.target.value)} />
      <span className="actions">
        {dirty ? <button className="btn ok sm" onClick={() => onSave(v)}>save</button> : null}
        {extra}
        <button className="btn ghost sm" onClick={onDelete}>✕</button>
      </span>
    </div>
  );
}
// custom_instructions is stored as "- line\n- line"; show it as a real list
function parseRules(blob: string): string[] {
  return String(blob || "").split("\n").map((l) => l.replace(/^[-•\s]+/, "").trim()).filter(Boolean);
}
function RulesList({ items, onSave }: { items: string[]; onSave: (items: string[]) => Promise<boolean> | void }) {
  const [list, setList] = useState<string[]>(items);
  const [add, setAdd] = useState("");
  // keep in sync when the server data refreshes under us
  const [seed, setSeed] = useState(items.join(""));
  if (items.join("") !== seed) { setSeed(items.join("")); setList(items); }
  const commit = (next: string[]) => { setList(next); onSave(next); };
  return (
    <div>
      {list.length === 0 ? <div className="empty">No rules of your own yet — add one below.</div> : null}
      {list.map((r, i) => (
        <RuleRow key={i} value={r}
          onSave={(v: string) => commit(list.map((x, j) => (j === i ? v : x)))}
          onDelete={() => commit(list.filter((_, j) => j !== i))} />
      ))}
      <div className="frm mt">
        <input className="in grow" placeholder="add a rule… e.g. no emojis before noon" value={add}
          onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { commit([...list, add.trim()]); setAdd(""); } }} />
        <button className="btn ok" onClick={() => { if (add.trim()) { commit([...list, add.trim()]); setAdd(""); } }}>+ add rule</button>
      </div>
    </div>
  );
}
function RuleRow({ value, onSave, onDelete }: any) {
  const [v, setV] = useState(value);
  const dirty = v.trim() !== value;
  return (
    <div className="row">
      <input className="in grow" value={v} onChange={(e) => setV(e.target.value)} />
      {dirty ? <button className="btn ok sm" onClick={() => onSave(v.trim())}>save</button> : null}
      <button className="btn ghost sm" onClick={onDelete}>✕</button>
    </div>
  );
}

// ISO → the value a <input type="datetime-local"> expects, in the viewer's local time
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function ReminderRow({ r, onSave, onDelete, extra }: any) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(r.title);
  const [due, setDue] = useState(toLocalInput(r.due_at));
  const overdue = new Date(r.due_at).getTime() < Date.now();
  if (editing) {
    return (
      <div className="reditbox">
        <input className="in" placeholder="remind me to…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="in mt6" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        <div className="pbactions">
          <button className="btn ok sm" onClick={async () => { if (await onSave({ title, due_at: due })) setEditing(false); }}>save</button>
          <button className="btn ghost sm" onClick={() => { setTitle(r.title); setDue(toLocalInput(r.due_at)); setEditing(false); }}>cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="row">
      <span>{r.title} <span className={overdue ? "od" : "dim"}>· {new Date(r.due_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{overdue ? " (overdue)" : ""}</span>{r.recurrence ? <span className="dim"> ({r.recurrence})</span> : null}</span>
      <span className="actions">
        {extra}
        <button className="btn ghost sm" onClick={() => setEditing(true)}>edit</button>
        <button className="btn danger sm" onClick={onDelete}>cancel</button>
      </span>
    </div>
  );
}
function AddRow({ fields, onAdd, addLabel }: any) {
  const [vals, setVals] = useState<any>({});
  return (
    <div className="frm mt">
      {fields.map((f: any) => <input key={f.name} className={`in ${f.grow ? "grow" : ""}`} style={f.w ? { maxWidth: f.w } : undefined} placeholder={f.ph} value={vals[f.name] || ""} onChange={(e) => setVals((x: any) => ({ ...x, [f.name]: e.target.value }))} />)}
      <button className="btn ok" onClick={async () => { if (await onAdd(vals)) setVals({}); }}>{addLabel || "+ add"}</button>
    </div>
  );
}
function ReminderAdd({ onAdd }: any) {
  const [title, setTitle] = useState(""); const [due, setDue] = useState("");
  return (
    <div className="frm mt">
      <input className="in grow" placeholder="remind me to…" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="in" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      <button className="btn ok" onClick={async () => { if (title && due && await onAdd({ title, due_at: due })) { setTitle(""); setDue(""); } }}>+ set</button>
    </div>
  );
}
function HelperBuilder({ onBuild, seedName }: any) {
  const [name, setName] = useState(seedName || ""); const [brief, setBrief] = useState(""); const [caps, setCaps] = useState<string[]>([]);
  const toggle = (c: string) => setCaps((x) => x.includes(c) ? x.filter((y) => y !== c) : [...x, c]);
  return (
    <div className="builder">
      <div className="bhead">+ build a helper</div>
      <input className="in" placeholder="name it (e.g. bills, gym buddy)" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="in mt6" placeholder="what should it do? (one line)" value={brief} onChange={(e) => setBrief(e.target.value)} />
      <div className="ablabel">what can it touch?</div>
      <div className="abgrid">
        {ABILITIES.map(([cap, icon, label]) => (
          <button key={cap} type="button" className={`abtile ${caps.includes(cap) ? "on" : ""}`} onClick={() => toggle(cap)}>
            <span className="abicon">{icon}</span>{label}{caps.includes(cap) ? <span className="abcheck">✓</span> : null}
          </button>
        ))}
      </div>
      <button className="btn ok mt6" onClick={async () => { if (name && caps.length && await onBuild({ name, brief, caps })) { setName(""); setBrief(""); setCaps([]); } }}>Build helper</button>
    </div>
  );
}
function PlaybookRow({ p, onSave, onToggle, onDelete, extra }: any) {
  const [trigger, setTrigger] = useState(p.trigger || ""); const [instr, setInstr] = useState(p.instructions);
  const auto = (p.format || {}).automation;
  return (
    <div className="pbcard">
      <div className="pbhead"><b>{p.name}</b>{auto ? <span className="tag amber">⏱ auto</span> : null}{!p.active ? <span className="tag muted">paused</span> : null}</div>
      <input className="in" placeholder="when should she do this? (optional)" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
      <textarea className="ta mt6" rows={2} value={instr} onChange={(e) => setInstr(e.target.value)} />
      <div className="pbactions">
        <button className="btn ok sm" onClick={() => onSave({ name: p.name, trigger, instructions: instr })}>save</button>
        <button className="btn ghost sm" onClick={onToggle}>{p.active ? "pause" : "resume"}</button>
        <button className="btn danger sm" onClick={onDelete}>delete</button>
        {extra}
      </div>
    </div>
  );
}
function NewPlaybook({ onSave }: any) {
  const [name, setName] = useState(""); const [trigger, setTrigger] = useState(""); const [instr, setInstr] = useState("");
  return (
    <div className="newpb">
      <div className="newlbl">+ new how-to</div>
      <input className="in" placeholder="name it" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="in mt6" placeholder="when? (optional)" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
      <textarea className="ta mt6" rows={2} placeholder="what should she do, step by step?" value={instr} onChange={(e) => setInstr(e.target.value)} />
      <button className="btn ok mt6" onClick={async () => { if (name && instr && await onSave({ name, trigger, instructions: instr })) { setName(""); setTrigger(""); setInstr(""); } }}>Save</button>
    </div>
  );
}
function SettingsForm({ d, onSave }: any) {
  const s = d.settings || {};
  const [f, setF] = useState<any>({ brief_hour: s.brief_hour ?? 8, checkin_hour: s.checkin_hour ?? 19, timezone: d.timezone, home_address: d.home_address });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  return (
    <div>
      <div className="grid2">
        <label className="lbl">morning brief (hour)<input className="in" value={f.brief_hour} onChange={(e) => set("brief_hour", e.target.value)} /></label>
        <label className="lbl">evening check-in (hour)<input className="in" value={f.checkin_hour} onChange={(e) => set("checkin_hour", e.target.value)} /></label>
        <label className="lbl">timezone<input className="in" value={f.timezone} onChange={(e) => set("timezone", e.target.value)} /></label>
        <label className="lbl">home address<input className="in" value={f.home_address} onChange={(e) => set("home_address", e.target.value)} /></label>
      </div>
      <button className="btn ok wide mt6" onClick={() => onSave(f)}>Save settings</button>
    </div>
  );
}

function AreaManager({ areas, onAdd, onEdit, onDelete, onClose }: any) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const have = new Set(areas.map((a: any) => String(a.name).toLowerCase()));
  const add = () => { if (name.trim()) { onAdd({ name: name.trim(), emoji }); setName(""); setEmoji(""); } };
  return (
    <div className="amgr">
      <div className="amgrhead"><b>Your areas</b><button className="btn ghost sm" onClick={onClose}>done</button></div>
      <div className="amgrhelp">Tabs for the parts of your life. Add as many as you want — then click one up top to see only its stuff and file straight into it.</div>
      {areas.map((a: any) => <AreaEditRow key={a.id} a={a} onEdit={onEdit} onDelete={onDelete} />)}
      <div className="frm mt">
        <input className="in" style={{ maxWidth: 64, textAlign: "center" }} placeholder="🗂️" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
        <input className="in grow" placeholder="new area name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button className="btn ok" onClick={add}>+ add</button>
      </div>
      {SUGGESTED_AREAS.filter((sug) => !have.has(sug.toLowerCase())).length ? (
        <div className="chipsrow">
          {SUGGESTED_AREAS.filter((sug) => !have.has(sug.toLowerCase())).map((sug) => (
            <button key={sug} className="exchip" onClick={() => onAdd({ name: sug })}>+ {sug}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
function AreaEditRow({ a, onEdit, onDelete }: any) {
  const [name, setName] = useState(a.name);
  const [emoji, setEmoji] = useState(a.emoji || "🗂️");
  const dirty = name !== a.name || emoji !== (a.emoji || "🗂️");
  return (
    <div className="row">
      <input className="in" style={{ maxWidth: 56, textAlign: "center" }} value={emoji} onChange={(e) => setEmoji(e.target.value)} />
      <input className="in grow" value={name} onChange={(e) => setName(e.target.value)} />
      <span className="actions">
        {dirty ? <button className="btn ok sm" onClick={() => onEdit({ id: a.id, name, emoji })}>save</button> : null}
        <button className="btn ghost sm" onClick={() => onDelete(a.id)}>✕</button>
      </span>
    </div>
  );
}

// the six 4-hour blocks (match health_mood's Time Block options). she picks a random time inside
// each window so the entry represents the whole block.
const MOOD_WINDOWS_UI: [string, string][] = [
  ["Pre-Dawn", "2–6am"],
  ["Morning", "6–10am"],
  ["Midday", "10am–2pm"],
  ["Afternoon", "2–6pm"],
  ["Evening", "6–10pm"],
  ["Late Night", "10pm–2am"],
];
const heatColor = (r: number | null): string => {
  if (r == null) return "#2a2f3a";
  const t = Math.max(1, Math.min(10, r));
  // 1 (red) → 5 (amber) → 10 (green)
  const hue = ((t - 1) / 9) * 120; // 0=red..120=green
  return `hsl(${hue} 55% 42%)`;
};
function whenLabel(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function MoodSection({ d, onSave }: any) {
  const mood = (d.settings || {}).mood || {};
  const [enabled, setEnabled] = useState<boolean>(!!mood.enabled);
  // a block is on unless it's explicitly disabled in saved settings
  const savedOff = new Set<string>((Array.isArray(mood.blocks) ? mood.blocks : []).filter((b: any) => b && b.enabled === false).map((b: any) => String(b.name)));
  const [off, setOff] = useState<Set<string>>(savedOff);
  const toggle = (name: string) => setOff((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const moods = d.moods || [];
  return (
    <div>
      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Text me a mood check-in every block</span>
      </label>
      <div className="minihelp">She sends once per block, at a random time inside the window — so the entry covers the whole block. Turn off any block you don't want.</div>
      <div className={`blocklist ${enabled ? "" : "off"}`}>
        {MOOD_WINDOWS_UI.map(([name, label]) => (
          <label key={name} className="blockrow">
            <span className="bchk">
              <input type="checkbox" checked={!off.has(name)} onChange={() => toggle(name)} />
              <span className="bname">{name}</span>
            </span>
            <span className="dim">{label}</span>
          </label>
        ))}
      </div>
      <button className="btn ok wide mt6" onClick={() => onSave({ enabled, blocks: MOOD_WINDOWS_UI.map(([name]) => ({ name, enabled: !off.has(name) })) })}>Save mood check-ins</button>

      <div className="moodlog">
        <div className="mloglbl">recent logs {moods.length ? "(from health_mood)" : ""}</div>
        {moods.length === 0 ? (
          <div className="empty">No mood entries loaded yet — once she logs one it shows here. (If it stays empty, the health_mood database may need to be shared with her Notion integration via ••• → Connections.)</div>
        ) : (
          moods.map((m: any) => (
            <div key={m.id} className="moodentry">
              <span className="mheat" style={{ background: heatColor(m.rating) }}>{m.rating != null ? m.rating : "–"}</span>
              <div className="mbody">
                <div className="mtop">
                  <span className="mblock">{m.block || "—"}</span>
                  {m.category ? <span className="mcat">{m.category}</span> : null}
                  <span className="mwhen">{whenLabel(m.when)}</span>
                </div>
                {m.notes ? <div className="mnotes">{m.notes}</div> : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const CSS = `
:root{--bg:#0e1014;--card:#191c23;--bd:#2a2f3a;--in:#0c0e12;--txt:#f2f3f6;--dim:#98a0af;--dim2:#c6ccd6;--dim3:#7c8494;--green:#68d693;--red:#ee7c9b;--blue:#8fb4ff;--amber:#e8b96e;--accent:#8fb4ff}
*{box-sizing:border-box}
main{font-family:-apple-system,system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;-webkit-text-size-adjust:100%}
.wrap{max-width:700px;margin:0 auto;padding:0 16px}
.topbar{position:sticky;top:0;z-index:20;background:rgba(14,16,20,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--bd);padding-top:10px}
.tbrow{display:flex;justify-content:space-between;align-items:center;padding-bottom:8px}
.brand{font-size:22px;font-weight:800;letter-spacing:-.5px}
.tbstat{font-size:12px;color:var(--dim)}
.nav{display:flex;gap:7px;flex-wrap:wrap;padding-bottom:10px}
.navpill{flex:0 0 auto;font-size:13px;color:var(--dim2);background:#20242e;border:1px solid var(--bd);border-radius:20px;padding:6px 12px;text-decoration:none;white-space:nowrap}
.areabar{display:flex;gap:7px;flex-wrap:wrap;padding-bottom:10px}
.areapill{flex:0 0 auto;font-size:13.5px;font-weight:600;color:var(--dim2);background:#161a22;border:1px solid var(--bd);border-radius:10px;padding:7px 13px;cursor:pointer;white-space:nowrap;font-family:inherit;display:inline-flex;align-items:center;gap:6px}
.areapill.on{background:var(--accent);color:#0c1424;border-color:var(--accent)}
.areapill.add{color:var(--accent);border-style:dashed}
.aemoji{font-size:14px}
.areasel{background:var(--in);border:1px solid var(--bd);color:var(--dim2);border-radius:9px;padding:7px 8px;font-size:12.5px;font-family:inherit;max-width:120px}
.amgr{background:var(--card);border:1px solid #35425f;border-radius:16px;padding:16px;margin-bottom:16px}
.amgrhead{display:flex;justify-content:space-between;align-items:center;font-size:17px}
.amgrhelp{font-size:13.5px;color:var(--dim);line-height:1.5;margin:6px 0 12px}
.suggesthelp{font-size:13.5px;color:var(--dim2);background:#12161d;border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin:10px 0}
.body{padding:18px 16px 90px}
.lead{color:var(--dim);font-size:15px;line-height:1.5;margin:0 0 16px}
.hero{background:linear-gradient(155deg,#232c42,#191c23);border:1px solid #35425f;border-radius:18px;padding:18px;margin-bottom:16px}
.herohead{font-size:20px;font-weight:800}
.herohelp{color:var(--dim2);font-size:14px;line-height:1.5;margin:6px 0 12px}
.chipsrow{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
.exchip{font-size:12.5px;color:var(--dim2);background:#0f131b;border:1px solid var(--bd);border-radius:16px;padding:6px 11px;cursor:pointer;text-align:left}
.sortres{font-size:14px;color:var(--green);margin-top:10px;line-height:1.5}
.card{background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:2px 16px;margin-bottom:12px;scroll-margin-top:110px}
summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;padding:16px 0;font-size:17px;font-weight:700}
summary::-webkit-details-marker{display:none}
.cicon{font-size:18px}
.ctitle{flex:1}
.count{font-size:12px;color:var(--dim);background:var(--in);border:1px solid var(--bd);border-radius:20px;padding:2px 10px}
.chev{color:var(--dim);font-size:13px;transition:transform .18s}
details[open] .chev{transform:rotate(180deg)}
.help{font-size:13.5px;color:var(--dim);margin:-4px 0 14px;line-height:1.5}
.secbody{padding-bottom:18px}
.row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid #22262f;font-size:15px}
.actions{display:flex;gap:6px;flex-shrink:0}
.grow{flex:1;min-width:0}
.frm{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mt{margin-top:14px}.mt6{margin-top:8px}
.in,.ta{background:var(--in);border:1px solid var(--bd);color:var(--txt);border-radius:11px;padding:12px 13px;font-size:16px;width:100%;font-family:inherit}
.in{min-width:110px}.ta{resize:vertical;line-height:1.55}.ta.big{min-height:104px}
.btn{border-radius:11px;padding:11px 15px;cursor:pointer;font-size:15px;border:1px solid var(--bd);background:#242832;color:var(--txt);font-family:inherit;font-weight:600;transition:transform .05s}
.btn:active{transform:scale(.97)}
.btn.sm{padding:8px 12px;font-size:13px}
.btn.primary{background:var(--accent);color:#0c1424;border-color:var(--accent);width:100%;font-size:16px;padding:14px;font-weight:700}
.btn.ok{background:#183626;border-color:#2b533c;color:var(--green)}
.btn.danger{background:#39212f;border-color:#573345;color:var(--red)}
.btn.ghost{background:transparent;border-color:var(--bd);color:var(--dim)}
.btn.wide{width:100%}
.empty{color:var(--dim);font-size:14px;padding:12px 0;font-style:italic}
.catgrp{margin-top:12px}
.catname{font-size:12px;color:var(--accent);font-weight:700;text-transform:capitalize;margin-bottom:4px}
.dim{color:var(--dim);font-size:13px;line-height:1.5}.dim2{color:var(--dim2);font-size:13.5px;margin-top:3px}.dim3{color:var(--dim3);font-size:12.5px;margin-top:5px}
.tag{font-size:11px;border-radius:6px;padding:2px 7px;margin-left:8px}
.tag.amber{color:var(--amber)}.tag.muted{color:var(--dim)}.tag.green{color:var(--green)}.tag.red{color:var(--red)}
.hrow{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:11px 0;border-bottom:1px solid #22262f}
.hname{font-weight:700;color:var(--accent)}
.builder{margin-top:14px;border:1px dashed #37405a;border-radius:14px;padding:14px}
.bhead{font-size:15px;font-weight:700;color:var(--accent);margin-bottom:10px}
.ablabel{font-size:13px;color:var(--dim);font-weight:600;margin:14px 0 8px}
.abgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.abtile{display:flex;align-items:center;gap:8px;background:var(--in);border:1px solid var(--bd);border-radius:12px;padding:12px;font-size:14.5px;color:var(--dim2);cursor:pointer;position:relative;font-family:inherit}
.abtile.on{background:#173021;border-color:#2b533c;color:var(--green)}
.abicon{font-size:17px}
.abcheck{position:absolute;right:10px;font-weight:800}
.toggle{display:flex;align-items:center;gap:10px;font-size:15px;color:var(--txt);cursor:pointer;padding:4px 0}
.toggle input{width:20px;height:20px;accent-color:var(--green)}
.minihelp{font-size:13px;color:var(--dim);line-height:1.5;margin:8px 0 2px}
.blocklist{margin-top:12px;border:1px solid var(--bd);border-radius:12px;overflow:hidden;transition:opacity .2s}
.blocklist.off{opacity:.45}
.blockrow{display:flex;justify-content:space-between;align-items:center;padding:12px 13px;border-bottom:1px solid #22262f;cursor:pointer}
.blockrow:last-child{border-bottom:none}
.bchk{display:flex;align-items:center;gap:9px}
.bchk input{width:18px;height:18px;accent-color:var(--green)}
.bname{font-size:15px;font-weight:600}
.moodlog{margin-top:20px}
.mloglbl{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--dim3);font-weight:700;margin-bottom:10px}
.moodentry{display:flex;gap:11px;align-items:flex-start;border:1px solid #22262f;border-radius:12px;padding:10px 12px;margin-bottom:8px}
.mheat{flex:0 0 auto;width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#0c1220}
.mbody{flex:1;min-width:0}
.mtop{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.mblock{font-weight:700;color:var(--accent);font-size:14px}
.mcat{font-size:14px;color:var(--txt);font-weight:600}
.mwhen{font-size:12px;color:var(--dim3);margin-left:auto}
.mnotes{font-size:13.5px;color:var(--dim2);margin-top:5px;line-height:1.5}
.corebox{background:#12161d;border:1px solid var(--bd);border-radius:12px;padding:12px 14px;margin-bottom:14px}
.corelbl{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--dim3);font-weight:700;margin-bottom:8px}
.corerule{font-size:13.5px;color:var(--dim2);line-height:1.6;padding:1px 0}
.yourlbl{font-size:13px;color:var(--accent);font-weight:700;margin:2px 0 8px}
.reditbox{border:1px solid #35425f;border-radius:12px;padding:12px;margin-bottom:8px;background:#12161d}
.od{color:var(--red);font-size:13px}
.pbcard{border:1px solid #22262f;border-radius:12px;padding:13px;margin-bottom:10px}
.pbhead{font-size:15px;margin-bottom:9px}
.pbactions{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}
.newpb{border:1px dashed #37405a;border-radius:12px;padding:13px;margin-top:6px}
.newlbl{font-size:14px;color:var(--accent);font-weight:700;margin-bottom:9px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.lbl{font-size:13px;color:var(--dim);display:flex;flex-direction:column;gap:4px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.chip{font-size:14px;padding:8px 13px;border-radius:20px;display:inline-flex;gap:6px;align-items:center}
.chip.on{background:#163120;color:var(--green)}.chip.off{background:#2f1c22;color:#d99}
.connect{color:var(--accent);text-decoration:underline;margin-left:3px}
.msgs{margin-top:10px}.msg{font-size:13px;padding:3px 0;color:var(--dim2)}.msg .you{color:var(--dim)}.msg .her{color:var(--accent)}
.toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,20px);background:#eef1f7;color:#0c1220;font-weight:700;font-size:14px;padding:11px 18px;border-radius:24px;opacity:0;transition:all .25s;pointer-events:none;z-index:50;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.toast.show{opacity:1;transform:translate(-50%,0)}
@media(max-width:520px){.grid2,.abgrid{grid-template-columns:1fr}}
`;
