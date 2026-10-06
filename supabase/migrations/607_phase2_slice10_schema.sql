-- Phase 2, slice 10 (schema): tenant-scope the content/publishing domain
-- -- 7 tables. Confirmed via FK dump: news_comments/news_posts tie to
-- admin_users/portal_users (already tenant-scoped); news_ticker,
-- gallery_albums/gallery_items, video_content have no cross-domain FKs.
--
-- post_categories: PK re-keyed from (key) alone to (tenant_id, key), same
-- pattern as employee_roles in slice 9 -- this also requires
-- news_posts.category (a single-column FK into post_categories(key)) to
-- become a composite FK into (tenant_id, key).

do $$
declare
  t text;
  tables text[] := array[
    'news_posts','news_comments','news_ticker','post_categories',
    'gallery_albums','gallery_items','video_content'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I add column tenant_id uuid references tenants(id)', t);
    execute format('update %I set tenant_id = ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid where tenant_id is null', t);
    execute format('alter table %I alter column tenant_id set not null', t);
    execute format('create index %I on %I (tenant_id)', t || '_tenant_id_idx', t);
    execute format('alter table %I alter column tenant_id set default coalesce(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)', t);
  end loop;
end $$;

-- post_categories: PK re-keyed from (key) to (tenant_id, key); news_posts'
-- FK becomes composite to match.
alter table news_posts drop constraint news_posts_category_fkey;
alter table post_categories drop constraint post_categories_pkey;
alter table post_categories add primary key (tenant_id, key);
alter table news_posts add constraint news_posts_category_fkey
  foreign key (tenant_id, category) references post_categories (tenant_id, key);
