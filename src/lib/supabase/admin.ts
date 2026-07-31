import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Service-role client for privileged, server-only operations (e.g. deciding a voucher
 * approval from an unauthenticated public link). Never import this from a client
 * component or any code that ships to the browser — it bypasses RLS entirely.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}
