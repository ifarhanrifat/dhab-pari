import type { SupabaseClient } from '@supabase/supabase-js'

// Resolves the shop a portal user manages — either as the original owner
// (shops.portal_user_id) or as an added staff member (shop_staff table,
// migration 458's multi-owner/staff feature, full equal access once
// added). Every my-shop/* screen used to query shops.portal_user_id
// directly and nothing else — a real bug found live: a staff member
// could see the Staff page itself (the one screen already written with
// this fallback) but every OTHER screen — Dashboard, Counter, Purchase,
// Customers, Reports — came back "no shop linked" for them, despite
// having full RLS/RPC access underneath the whole time. The backend
// (user_manages_shop(), every policy/RPC retrofitted in 458/459) was
// never the gap; the client never had a way to find the shop's own id
// in the first place. One lookup now, reused everywhere instead of
// duplicated (and easy to duplicate incorrectly) per screen.
//
// Generic so each caller gets back its own Shop shape typed properly —
// every screen selects a different column list. Returns the same
// { data, error } shape a Supabase query resolves to, so existing
// `.then(({ data }) => ...)` call sites need no restructuring beyond
// the query itself.
export async function resolveMyShop<T>(supabase: SupabaseClient, userId: string, select: string): Promise<{ data: T | null; error: unknown }> {
  const owned = await supabase.from('shops').select(select).eq('portal_user_id', userId).maybeSingle()
  if (owned.data) return { data: owned.data as T, error: null }

  const staffRow = await supabase.from('shop_staff').select('shop_id').eq('portal_user_id', userId).maybeSingle()
  if (!staffRow.data) return { data: null, error: staffRow.error }

  const staffShop = await supabase.from('shops').select(select).eq('id', staffRow.data.shop_id).maybeSingle()
  return { data: (staffShop.data as T) ?? null, error: staffShop.error }
}
