-- Phase 2, slice 3 (schema): tenant-scope the shop/commerce domain -- 24
-- tables covering shop profiles, products/kits/packs/deals, orders &
-- deliveries, sales & purchases, customer invoices/payments/links, and
-- staff/wallet/lumpsum-charge tables.
--
-- Every table here has either a plain `id` primary key, or a composite/
-- single-column PK that is itself FK-based (shop_ai_settings keys off
-- shop_id; shop_customer_invoice_sales off invoice_id+sale_id) -- no
-- business-key PK like fare_bands' `flow` this time, so no manual PK
-- re-keying is needed. Likewise every UNIQUE constraint on these tables
-- (customer+portal_user, order+vehicle, shop+period, shop+portal_user) is
-- already FK-based against specific, already-tenant-scoped rows, so none
-- need re-keying either.

do $$
declare
  t text;
  tables text[] := array[
    'shop_ai_settings','shop_customer_invoice_sales','shop_customer_invoices',
    'shop_customer_link_codes','shop_customer_links','shop_customer_payments',
    'shop_customers','shop_deal_items','shop_deals','shop_delivery_invitations',
    'shop_kit_items','shop_kits','shop_lumpsum_charges','shop_order_items',
    'shop_orders','shop_product_packs','shop_products','shop_purchase_items',
    'shop_purchases','shop_sale_items','shop_sales','shop_staff',
    'shop_wallet_topups','shops'
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
