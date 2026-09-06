import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseServerConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseServiceRoleKey: string;
}

const required = (name: string, candidates: Array<string | undefined>): string => {
  const value = candidates.find(candidate => candidate?.trim())?.trim();
  if (!value) throw new Error(`missing-server-environment:${name}`);
  return value;
};

/** Supabase-only configuration: deliberately independent of Tradovate. */
export function readSupabaseServerConfig(): SupabaseServerConfig {
  return {
    supabaseUrl: required('SUPABASE_URL', [
      process.env.SUPABASE_URL,
      process.env.VITE_SUPABASE_URL,
    ]),
    supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY', [
      process.env.SUPABASE_PUBLISHABLE_KEY,
      process.env.SUPABASE_ANON_KEY,
      process.env.VITE_SUPABASE_ANON_KEY,
    ]),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', [
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ]),
  };
}

export function createSupabaseAdminClient(config: SupabaseServerConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireSupabaseUserId(
  authorization: string | undefined,
  config: SupabaseServerConfig,
): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) throw new Error('missing-auth-token');
  const auth = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) throw new Error('invalid-auth-token');
  return data.user.id;
}
