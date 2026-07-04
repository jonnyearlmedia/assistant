import { NextResponse } from "next/server";
import { authUrl } from "../../../../lib/integrations/google";

export const dynamic = "force-dynamic";

// second Gmail slot (personal). Same registered redirect URI; state="google2" routes it to slot 2.
export async function GET() {
  return NextResponse.redirect(authUrl("google2"));
}
