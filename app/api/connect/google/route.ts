import { NextResponse } from "next/server";
import { authUrl } from "../../../../lib/integrations/google";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.redirect(authUrl("google"));
}
