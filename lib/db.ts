// server-side Supabase client (lazy). lexa's memory lives here.
// IMPORTANT: the client is created lazily via a Proxy so that importing this module at BUILD
// time (when env vars aren't present) never calls createClient() — that would throw
// "supabaseUrl is required" during Next's page-data collection. It only initializes on first
// real use at runtime, where the env vars exist.
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("[lexa] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }
  _client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

// proxy so existing `db.from(...)` call sites keep working, but nothing runs until first access
export const db: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const c = getClient();
    const value = Reflect.get(c as any, prop, receiver);
    return typeof value === "function" ? value.bind(c) : value;
  },
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
