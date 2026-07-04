// lexa's memory dashboard — see & edit everything she knows. protected by Vercel Auth (owner-only).
import { db } from "@/lib/db";
import { ownerUserId } from "@/lib/integrations/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getData() {
  const uid = await ownerUserId();
  if (!uid) return null;
  const [facts, goals, playbooks, reminders, integrations, user] = await Promise.all([
    db.from("facts").select("id,category,key,value,pinned").eq("user_id", uid).order("category"),
    db.from("goals").select("id,title,detail,status").eq("user_id", uid).neq("status", "dropped"),
    db.from("playbooks").select("id,name,trigger,instructions,active").eq("user_id", uid),
    db.from("reminders").select("id,title,due_at,status,location,recurrence").eq("user_id", uid).eq("status", "scheduled").order("due_at"),
    db.from("integrations").select("provider,status,meta").eq("user_id", uid),
    db.from("users").select("*").eq("id", uid).single(),
  ]);
  return {
    facts: facts.data || [],
    goals: goals.data || [],
    playbooks: playbooks.data || [],
    reminders: reminders.data || [],
    integrations: integrations.data || [],
    user: user.data,
  };
}

const box: React.CSSProperties = { background: "#15151b", border: "1px solid #26262f", borderRadius: 12, padding: 16, marginBottom: 14 };
const chip: React.CSSProperties = { fontSize: 11, color: "#8b8b99", textTransform: "uppercase", letterSpacing: 0.5 };
const del: React.CSSProperties = { background: "transparent", border: "1px solid #3a2530", color: "#e0708f", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 12 };

export default async function Dashboard() {
  const d = await getData();
  if (!d) {
    return <main style={{ fontFamily: "system-ui", background: "#0b0b0f", color: "#eee", minHeight: "100vh", padding: 24 }}>no user yet — text lexa first, then refresh.</main>;
  }
  const s = (d.user?.settings as any) || {};

  return (
    <main style={{ fontFamily: "system-ui", background: "#0b0b0f", color: "#eee", minHeight: "100vh", padding: "24px 16px", maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontSize: 30, margin: "0 0 2px" }}>lexa · memory</h1>
      <p style={{ color: "#8b8b99", marginTop: 0 }}>everything she knows about you. edit or wipe anything.</p>

      <div style={box}>
        <div style={chip}>integrations</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {["ticktick", "notion", "google", "google2"].map((p) => {
            const row: any = d.integrations.find((i: any) => i.provider === p);
            const on = row?.status === "connected";
            const label = p === "google2" ? "gmail #2" : p;
            return (
              <span key={p} style={{ fontSize: 13, padding: "4px 10px", borderRadius: 20, background: on ? "#16301f" : "#2a1a1a", color: on ? "#5fd08a" : "#d08a5f" }}>
                {on ? "●" : "○"} {label}{row?.meta?.email ? ` (${row.meta.email})` : ""}
              </span>
            );
          })}
        </div>
      </div>

      <div style={box}>
        <div style={chip}>settings</div>
        <form data-act="set_settings" style={{ display: "grid", gap: 8, marginTop: 8, gridTemplateColumns: "1fr 1fr" }}>
          <label style={{ fontSize: 13 }}>morning brief hour<br /><input name="brief_hour" defaultValue={s.brief_hour ?? 8} style={inp} /></label>
          <label style={{ fontSize: 13 }}>check-in hour<br /><input name="checkin_hour" defaultValue={s.checkin_hour ?? 19} style={inp} /></label>
          <label style={{ fontSize: 13 }}>timezone<br /><input name="timezone" defaultValue={d.user?.timezone || "America/New_York"} style={inp} /></label>
          <label style={{ fontSize: 13 }}>home address (for drive times)<br /><input name="home_address" defaultValue={d.user?.home_address || ""} style={inp} /></label>
          <button style={{ ...del, borderColor: "#254a3a", color: "#5fd08a", gridColumn: "1 / -1", padding: 8 }}>save settings</button>
        </form>
      </div>

      <div style={box}>
        <div style={chip}>facts ({d.facts.length})</div>
        {d.facts.map((f: any) => (
          <div key={f.id} style={row}>
            <span><b style={{ color: "#8b8b99" }}>[{f.category}]</b> {f.key}: {f.value}</span>
            <button style={del} data-del="fact" data-id={f.id}>forget</button>
          </div>
        ))}
        <form data-act="add_fact" style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input name="category" placeholder="category" style={{ ...inp, width: 90 }} />
          <input name="key" placeholder="key" style={{ ...inp, width: 110 }} />
          <input name="value" placeholder="value" style={{ ...inp, flex: 1 }} />
          <button style={{ ...del, borderColor: "#254a3a", color: "#5fd08a" }}>+ add</button>
        </form>
      </div>

      <div style={box}>
        <div style={chip}>goals ({d.goals.length})</div>
        {d.goals.map((g: any) => (
          <div key={g.id} style={row}><span>{g.title}{g.detail ? ` — ${g.detail}` : ""}</span><button style={del} data-del="goal" data-id={g.id}>drop</button></div>
        ))}
      </div>

      <div style={box}>
        <div style={chip}>playbooks ({d.playbooks.length})</div>
        {d.playbooks.map((p: any) => (
          <div key={p.id} style={row}><span><b>{p.name}</b>{p.trigger ? ` [${p.trigger}]` : ""}: {p.instructions}</span><button style={del} data-del="playbook" data-id={p.id}>delete</button></div>
        ))}
      </div>

      <div style={box}>
        <div style={chip}>reminders ({d.reminders.length})</div>
        {d.reminders.map((r: any) => (
          <div key={r.id} style={row}><span>{r.title} · {new Date(r.due_at).toLocaleString()}{r.recurrence ? ` (${r.recurrence})` : ""}{r.location ? ` @ ${r.location}` : ""}</span><button style={del} data-del="reminder" data-id={r.id}>cancel</button></div>
        ))}
      </div>

      <script dangerouslySetInnerHTML={{ __html: DASH_JS }} />
    </main>
  );
}

const inp: React.CSSProperties = { background: "#0d0d12", border: "1px solid #26262f", color: "#eee", borderRadius: 6, padding: "6px 8px", marginTop: 3, width: "100%" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #1c1c24", fontSize: 14 };

const DASH_JS = `
async function post(body){ const r = await fetch('/api/dashboard', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return r.ok; }
document.addEventListener('click', async (e)=>{
  const b = e.target.closest('[data-del]'); if(!b) return;
  if(!confirm('remove this?')) return;
  if(await post({action:'delete', kind:b.dataset.del, id:b.dataset.id})) location.reload();
});
document.addEventListener('submit', async (e)=>{
  const f = e.target.closest('form[data-act]'); if(!f) return; e.preventDefault();
  const data = Object.fromEntries(new FormData(f).entries());
  if(await post({action:f.dataset.act, ...data})) location.reload();
});
`;
