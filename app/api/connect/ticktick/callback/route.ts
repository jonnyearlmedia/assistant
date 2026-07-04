import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "../../../../../lib/integrations/ticktick";

export const dynamic = "force-dynamic";

function page(ok: boolean, detail = "") {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0b0b0f;color:#eee;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h1 style="font-size:56px;margin:0">${ok ? "✅" : "⚠️"}</h1><h2>TickTick ${ok ? "connected to lexa" : "connection failed"}</h2><p style="color:#9aa">${ok ? "you can close this and text lexa. she can touch your ticktick now." : detail}</p></div></body>`;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return new NextResponse(page(false, "missing code"), { status: 400, headers: { "content-type": "text/html" } });
  try {
    await exchangeCode(code);
    return new NextResponse(page(true), { headers: { "content-type": "text/html" } });
  } catch (e: any) {
    return new NextResponse(page(false, e?.message || String(e)), { status: 500, headers: { "content-type": "text/html" } });
  }
}
