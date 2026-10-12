-- Atomic add-if-missing for portal_users.dismissed_help_pages (migration
-- 643) -- a plain client-side array-append read-modify-write would lose a
-- concurrent dismissal from a second open tab; this does it in one
-- statement instead. SECURITY DEFINER so it can bypass the same
-- portal_users_update_own RLS check (an authenticated portal user has no
-- reason not to dismiss their own page), scoped to auth.uid() internally
-- rather than trusting a caller-supplied id.
create or replace function portal_dismiss_help_page(p_page_key text)
returns void as $$
begin
  update portal_users
  set dismissed_help_pages = (
    select array_agg(distinct k) from unnest(dismissed_help_pages || p_page_key) as k
  )
  where auth_user_id = auth.uid();
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function portal_dismiss_help_page(text) to authenticated;
