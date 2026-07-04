// shared helpers for OAuth-based integrations: resolve the single owner user + store/read tokens.
import { db } from "../db";

export async function ownerUserId(): Promise<string | null> {
  const phone = process.env.OWNER_PHONE;
  if (phone) {
    const { data } = await db.from("users").select("id").eq("phone", phone).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data } = await db.from("users").select("id").order("created_at").limit(1).maybeSingle();
  return data?.id ?? null;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string | null;
  scope?: string | null;
  expires_at?: string | null;
}

export async function saveIntegration(userId: string, provider: string, tok: TokenSet) {
  await db.from("integrations").upsert(
    {
      user_id: userId,
      provider,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      scope: tok.scope ?? null,
      expires_at: tok.expires_at ?? null,
      status: "connected",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );
}

export async function getIntegration(userId: string, provider: string) {
  const { data } = await db
    .from("integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  return data;
}
