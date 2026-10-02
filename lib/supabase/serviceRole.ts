/**
 * SERVER ONLY — NEVER IMPORT THIS CLIENT INTO A CLIENT COMPONENT OR BROWSER BUNDLE.
 * SUPABASE_SERVICE_ROLE_KEY bypasses Row Level Security. Its possession is backend
 * authority to execute the financial/state RPCs, not permission to trust caller IDs.
 * Never expose it through NEXT_PUBLIC_*, cookies, responses, logs or Make.com.
 * Never attach a user's access token or call signIn/setSession on this client.
 * The pilot's direct table writes remain revoked; use atomic database commands.
 */
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requiredEnvironment, HttpError } from '@/lib/http/errors';
import type { Database } from './database.types';

let serviceClient: SupabaseClient<Database> | undefined;

export function getServiceRoleClient(): SupabaseClient<Database> {
  if (serviceClient) return serviceClient;
  const url = requiredEnvironment('SUPABASE_URL');
  try {
    if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error();
  } catch {
    throw new HttpError(500, 'SERVER_CONFIGURATION', 'Supabase endpoint configuration is invalid.');
  }
  serviceClient = createClient<Database>(url, requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'X-Client-Info': 'falcon-pilot-backend/0.2' } },
  });
  return serviceClient;
}
