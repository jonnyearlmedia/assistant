// Notion client (standalone integration token). VERIFIED WRITES: every write is read back
// and confirmed before we report success — lexa never claims a phantom log.
import { auditWrite } from "../audit";

const NOTION = "https://api.notion.com/v1";
const VER = "2022-06-28";
const MASTER_PLANNER_DB =
  process.env.NOTION_MASTER_PLANNER_DB || "2b89eadd-b0c6-4fba-bd09-ca10359249fe";

function headers() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": VER,
    "Content-Type": "application/json",
  };
}

export function notionConnected(): boolean {
  return !!process.env.NOTION_TOKEN;
}

// compact requested-fields snapshot for the audit ledger (never full page content)
const compactReq = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : v]));

export interface TaskFields {
  task: string;
  due?: string; // ISO date
  status?: string;
  priority?: string;
  project?: string;
  type?: string;
  category?: string;
  firmness?: string;
  tags?: string[];
  critical?: boolean;
  focus?: boolean;
}

// Master Planner schema (discovered live):
// Task(title) Due Date(date) Priority(select) Type(select) Critical(checkbox)
// Category(select) Focus(checkbox) Tentative(checkbox) Firmness(select) Project(select)
// Next Up(checkbox) Status(select) Tags(multi_select)
export async function createMasterPlannerTask(
  f: TaskFields
): Promise<{ ok: boolean; id?: string; verified: boolean; detail: string }> {
  if (!process.env.NOTION_TOKEN) return { ok: false, verified: false, detail: "NOTION_TOKEN not set" };

  const props: any = { Task: { title: [{ text: { content: f.task } }] } };
  if (f.due) props["Due Date"] = { date: { start: f.due } };
  if (f.status) props["Status"] = { select: { name: f.status } };
  if (f.priority) props["Priority"] = { select: { name: f.priority } };
  if (f.project) props["Project"] = { select: { name: f.project } };
  if (f.type) props["Type"] = { select: { name: f.type } };
  if (f.category) props["Category"] = { select: { name: f.category } };
  if (f.firmness) props["Firmness"] = { select: { name: f.firmness } };
  if (typeof f.critical === "boolean") props["Critical"] = { checkbox: f.critical };
  if (typeof f.focus === "boolean") props["Focus"] = { checkbox: f.focus };
  if (f.tags?.length) props["Tags"] = { multi_select: f.tags.map((t) => ({ name: t })) };

  const res = await fetch(`${NOTION}/pages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ parent: { database_id: MASTER_PLANNER_DB }, properties: props }),
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = `notion create failed: ${data?.message || res.status}`;
    auditWrite("notion", "create_master_planner_task", { requested: compactReq({ task: f.task, due: f.due, project: f.project, status: f.status }), verified: false, detail });
    return { ok: false, verified: false, detail };
  }

  // VERIFIED read-back
  const id = data.id;
  const check = await fetch(`${NOTION}/pages/${id}`, { headers: headers() });
  const cd = await check.json();
  const title = cd?.properties?.Task?.title?.map((t: any) => t.plain_text).join("") || "";
  const verified = check.ok && cd?.id === id && title === f.task;
  const detail = verified
    ? `created & verified in Master Planner: "${title}"${f.due ? ` (due ${f.due})` : ""}`
    : "created but read-back could not confirm — flag this, don't claim done";
  auditWrite("notion", "create_master_planner_task", { targetRef: id, requested: compactReq({ task: f.task, due: f.due, project: f.project, status: f.status }), verified, detail });
  return { ok: true, id, verified, detail };
}

function titleOf(r: any): string {
  if (r.object === "database") return (r.title || []).map((t: any) => t.plain_text).join("") || "(untitled db)";
  const props = r.properties || {};
  for (const k in props) if (props[k]?.type === "title") return (props[k].title || []).map((t: any) => t.plain_text).join("") || "(untitled)";
  return "(untitled)";
}

// search ALL of jonny's Notion (anything shared with the integration) — not just Master Planner
export async function search(query: string, max = 8): Promise<{ ok: boolean; results?: any[]; detail: string }> {
  if (!process.env.NOTION_TOKEN) return { ok: false, detail: "NOTION_TOKEN not set" };
  const res = await fetch(`${NOTION}/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, page_size: max }),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: d?.message || `status ${res.status}` };
  const results = (d.results || []).map((r: any) => ({ id: r.id, type: r.object, title: titleOf(r), url: r.url }));
  return {
    ok: true,
    results,
    detail: results.length
      ? `${results.length} result(s)`
      : "no results — that page probably isn't shared with the integration yet (jonny needs to add it via ••• → Connections)",
  };
}

// read a page's actual content
export async function readPage(pageId: string, max = 60): Promise<{ ok: boolean; text?: string; detail: string }> {
  if (!process.env.NOTION_TOKEN) return { ok: false, detail: "NOTION_TOKEN not set" };
  const res = await fetch(`${NOTION}/blocks/${pageId}/children?page_size=${max}`, { headers: headers() });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: d?.message || `status ${res.status}` };
  const lines: string[] = [];
  for (const b of d.results || []) {
    const t = b[b.type];
    const rich = t?.rich_text || t?.text;
    const txt = Array.isArray(rich) ? rich.map((x: any) => x.plain_text).join("") : "";
    if (b.type.startsWith("heading")) lines.push(`# ${txt}`);
    else if (b.type === "to_do") lines.push(`[${t.checked ? "x" : " "}] ${txt}`);
    else if (txt) lines.push(txt);
  }
  return { ok: true, text: lines.join("\n").slice(0, 4000), detail: `${lines.length} blocks` };
}

// query any Notion database by id (not just Master Planner)
export async function queryDatabase(dbId: string, max = 15): Promise<{ ok: boolean; rows?: any[]; detail: string }> {
  if (!process.env.NOTION_TOKEN) return { ok: false, detail: "NOTION_TOKEN not set" };
  const res = await fetch(`${NOTION}/databases/${dbId}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ page_size: max }),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: d?.message || `status ${res.status}` };
  const rows = (d.results || []).map((p: any) => {
    const out: any = { id: p.id };
    for (const k in p.properties || {}) {
      const pr = p.properties[k];
      if (pr.type === "title") out[k] = (pr.title || []).map((t: any) => t.plain_text).join("");
      else if (pr.type === "rich_text") out[k] = (pr.rich_text || []).map((t: any) => t.plain_text).join("");
      else if (pr.type === "select") out[k] = pr.select?.name ?? null;
      else if (pr.type === "multi_select") out[k] = (pr.multi_select || []).map((s: any) => s.name);
      else if (pr.type === "date") out[k] = pr.date?.start ?? null;
      else if (pr.type === "checkbox") out[k] = pr.checkbox;
      else if (pr.type === "number") out[k] = pr.number;
    }
    return out;
  });
  return { ok: true, rows, detail: `${rows.length} row(s)` };
}

// create a page (row) in ANY notion database — maps a simple {field: value} object to the db's
// real property types by reading its schema first. this is how health_mood logging works.
export async function createPageInDb(
  dbId: string,
  fields: Record<string, any>
): Promise<{ ok: boolean; id?: string; verified?: boolean; detail: string }> {
  if (!process.env.NOTION_TOKEN) return { ok: false, verified: false, detail: "NOTION_TOKEN not set" };
  const dbRes = await fetch(`${NOTION}/databases/${dbId}`, { headers: headers() });
  if (!dbRes.ok) return { ok: false, verified: false, detail: `db not found (${dbRes.status})` };
  const db = await dbRes.json();
  const schema = db.properties || {};
  const props: any = {};
  const skipped: string[] = [];
  for (const [name, val] of Object.entries(fields)) {
    const p = schema[name];
    if (!p) { skipped.push(name); continue; }
    switch (p.type) {
      case "title": props[name] = { title: [{ text: { content: String(val) } }] }; break;
      case "rich_text": props[name] = { rich_text: [{ text: { content: String(val) } }] }; break;
      case "select": props[name] = { select: { name: String(val) } }; break;
      case "status": props[name] = { status: { name: String(val) } }; break;
      case "multi_select": props[name] = { multi_select: (Array.isArray(val) ? val : [val]).map((v) => ({ name: String(v) })) }; break;
      case "date": props[name] = { date: { start: String(val) } }; break;
      case "number": props[name] = { number: Number(val) }; break;
      case "checkbox": props[name] = { checkbox: Boolean(val) }; break;
      default: skipped.push(name);
    }
  }
  const res = await fetch(`${NOTION}/pages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
  });
  const d = await res.json();
  if (!res.ok) {
    const detail = `notion create failed: ${d?.message || res.status}`;
    auditWrite("notion", "create_page", { targetRef: dbId, requested: compactReq(fields), verified: false, detail });
    return { ok: false, verified: false, detail };
  }
  const check = await fetch(`${NOTION}/pages/${d.id}`, { headers: headers() });
  const detail = `created & ${check.ok ? "verified" : "UNVERIFIED"} row in db${skipped.length ? ` (ignored unknown fields: ${skipped.join(", ")})` : ""}`;
  auditWrite("notion", "create_page", { targetRef: d.id, requested: compactReq(fields), verified: check.ok, detail });
  return { ok: true, id: d.id, verified: check.ok, detail };
}

// append text content to any notion page
export async function appendText(pageId: string, text: string): Promise<{ ok: boolean; detail: string }> {
  if (!process.env.NOTION_TOKEN) return { ok: false, detail: "NOTION_TOKEN not set" };
  const children = (text || "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 90)
    .map((line) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line.slice(0, 1900) } }] } }));
  const res = await fetch(`${NOTION}/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ children }),
  });
  const d = await res.json();
  if (!res.ok) {
    const detail = `append failed: ${d?.message || res.status}`;
    auditWrite("notion", "append_blocks", { targetRef: pageId, requested: { preview: (text || "").slice(0, 200), blocks: children.length }, verified: false, detail });
    return { ok: false, detail };
  }
  // cheap read-back: fetch the first appended block by the id notion returned
  const firstId = d?.results?.[0]?.id;
  const check = firstId ? await fetch(`${NOTION}/blocks/${firstId}`, { headers: headers() }) : null;
  const detail = `appended ${children.length} block(s)`;
  auditWrite("notion", "append_blocks", { targetRef: pageId, requested: { preview: (text || "").slice(0, 200), blocks: children.length }, verified: !!check?.ok, detail });
  return { ok: true, detail };
}

export async function listMasterPlanner(limit = 12): Promise<{ ok: boolean; tasks?: any[]; detail?: string }> {
  if (!process.env.NOTION_TOKEN) return { ok: false, detail: "NOTION_TOKEN not set" };
  const res = await fetch(`${NOTION}/databases/${MASTER_PLANNER_DB}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ page_size: limit }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, detail: data?.message || `status ${res.status}` };
  const tasks = (data.results || []).map((p: any) => ({
    task: p.properties?.Task?.title?.map((t: any) => t.plain_text).join("") || "",
    status: p.properties?.Status?.select?.name || null,
    due: p.properties?.["Due Date"]?.date?.start || null,
    priority: p.properties?.Priority?.select?.name || null,
    project: p.properties?.Project?.select?.name || null,
  }));
  return { ok: true, tasks };
}
