// server-side Supabase client (service role). lexa's memory lives here.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  // don't throw at import time on Vercel build; fail loudly at first use instead.
  console.warn("[lexa] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
}

export const db = createClient(url || "", key || "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface User {
  id: string;
  phone: string;
  name: string | null;
  timezone: string;
  home_address: string | null;
  settings: Record<string, any>;
  onboarding_stage: string;
}

/** Find or create the user for a given phone number (lexa is single-tenant per number today). */
export async function resolveUser(phone: string, name?: string): Promise<User> {
  const { data: existing } = await db.from("users").select("*").eq("phone", phone).maybeSingle();
  if (existing) return existing as User;
  const { data, error } = await db
    .from("users")
    .insert({ phone, name: name ?? null })
    .select("*")
    .single();
  if (error) throw new Error(`resolveUser: ${error.message}`);
  return data as User;
}
