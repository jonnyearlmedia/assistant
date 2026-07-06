// Notion client (standalone integration token). VERIFIED WRITES: every write is read back
// and confirmed before we report success — lexa never claims a phantom log.

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
  if (!res.ok) return { ok: false, verified: false, detail: `notion create failed: ${data?.message || res.status}` };

  // VERIFIED read-back
  const id = data.id;
  const check = await fetch(`${NOTION}/pages/${id}`, { headers: headers() });
  const cd = await check.json();
  const title = cd?.properties?.Task?.title?.map((t: any) => t.plain_text).join("") || "";
  const verified = check.ok && cd?.id === id && title === f.task;
  return {
    ok: true,
    id,
    verified,
    detail: verified
      ? `created & verified in Master Planner: "${title}"${f.due ? ` (due ${f.due})` : ""}`
      : "created but read-back could not confirm — flag this, don't claim done",
  };
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
