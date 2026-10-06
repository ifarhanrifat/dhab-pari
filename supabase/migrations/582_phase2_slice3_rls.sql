-- Phase 2, slice 3 (RLS): same uniform transformation as migrations
-- 568/574/578 -- prepend `tenant_id = my_tenant_id() AND` to every
-- USING/CHECK. Only shop_products and shops have a genuinely anonymous-
-- readable policy (`qual = true` for the `public` role, no auth.role() =
-- 'authenticated' guard), so those two get the one real tenant's id
-- hardcoded instead. The several *_public_read policies on shop_deal_items/
-- shop_deals/shop_kit_items/shop_kits are misleadingly named -- their role
-- list is {authenticated}, not {public} -- so they get the ordinary
-- my_tenant_id() treatment like every other authenticated policy.

alter policy "shop_ai_settings_owner_all" on shop_ai_settings
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))));

alter policy "shop_customer_invoice_sales_owner_read" on shop_customer_invoice_sales
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM (shop_customer_invoices inv
     JOIN shop_customers c ON ((c.id = inv.customer_id)))
  WHERE ((inv.id = shop_customer_invoice_sales.invoice_id) AND (user_manages_shop(c.shop_id) OR (EXISTS ( SELECT 1
           FROM shop_customer_links l
          WHERE ((l.customer_id = c.id) AND (l.portal_user_id = current_portal_user_id())))))))))));

alter policy "shop_customer_invoices_owner_read" on shop_customer_invoices
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_customers c
  WHERE ((c.id = shop_customer_invoices.customer_id) AND (user_manages_shop(c.shop_id) OR (EXISTS ( SELECT 1
           FROM shop_customer_links l
          WHERE ((l.customer_id = c.id) AND (l.portal_user_id = current_portal_user_id())))))))))));

alter policy "shop_customer_links_read" on shop_customer_links
  using ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) OR current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_customers c
  WHERE ((c.id = shop_customer_links.customer_id) AND user_manages_shop(c.shop_id)))))));

alter policy "shop_customer_payments_owner_read" on shop_customer_payments
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_customers c
  WHERE ((c.id = shop_customer_payments.customer_id) AND (user_manages_shop(c.shop_id) OR (EXISTS ( SELECT 1
           FROM shop_customer_links l
          WHERE ((l.customer_id = c.id) AND (l.portal_user_id = current_portal_user_id())))))))))));

alter policy "shop_customers_owner_read" on shop_customers
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id) OR (EXISTS ( SELECT 1
   FROM shop_customer_links l
  WHERE ((l.customer_id = l.id) AND (l.portal_user_id = current_portal_user_id())))))));

alter policy "shop_customers_owner_update" on shop_customers
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))));

alter policy "shop_customers_owner_write" on shop_customers
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))));

alter policy "shop_deal_items_owner_write" on shop_deal_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (shop_deals d
     JOIN shops s ON ((s.id = d.shop_id)))
  WHERE ((d.id = shop_deal_items.deal_id) AND (current_admin_permission('manage_parties'::character varying) OR (s.portal_user_id = current_portal_user_id())))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (shop_deals d
     JOIN shops s ON ((s.id = d.shop_id)))
  WHERE ((d.id = shop_deal_items.deal_id) AND (current_admin_permission('manage_parties'::character varying) OR (s.portal_user_id = current_portal_user_id())))))));

alter policy "shop_deal_items_public_read" on shop_deal_items
  using ((tenant_id = my_tenant_id()) AND (true));

alter policy "shop_deals_owner_write" on shop_deals
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_deals.shop_id) AND (s.portal_user_id = current_portal_user_id())))))))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_deals.shop_id) AND (s.portal_user_id = current_portal_user_id())))))));

alter policy "shop_deals_public_read" on shop_deals
  using ((tenant_id = my_tenant_id()) AND (true));

alter policy "shop_delivery_invitations_parties_read" on shop_delivery_invitations
  using ((tenant_id = my_tenant_id()) AND (is_party_to_shop_delivery(order_id)));

alter policy "shop_kit_items_owner_write" on shop_kit_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (shop_kits k
     JOIN shops s ON ((s.id = k.shop_id)))
  WHERE ((k.id = shop_kit_items.kit_id) AND (current_admin_permission('manage_parties'::character varying) OR (s.portal_user_id = current_portal_user_id())))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (shop_kits k
     JOIN shops s ON ((s.id = k.shop_id)))
  WHERE ((k.id = shop_kit_items.kit_id) AND (current_admin_permission('manage_parties'::character varying) OR (s.portal_user_id = current_portal_user_id())))))));

alter policy "shop_kit_items_public_read" on shop_kit_items
  using ((tenant_id = my_tenant_id()) AND (true));

alter policy "shop_kits_owner_write" on shop_kits
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_kits.shop_id) AND (s.portal_user_id = current_portal_user_id())))))))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_kits.shop_id) AND (s.portal_user_id = current_portal_user_id())))))));

alter policy "shop_kits_public_read" on shop_kits
  using ((tenant_id = my_tenant_id()) AND (true));

alter policy "shop_lumpsum_charges_admin_read" on shop_lumpsum_charges
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "shop_lumpsum_charges_keeper_read" on shop_lumpsum_charges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_lumpsum_charges.shop_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "shop_order_items_admin_read" on shop_order_items
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "shop_order_items_keeper_read" on shop_order_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (shop_orders o
     JOIN shops s ON ((s.id = o.shop_id)))
  WHERE ((o.id = shop_order_items.order_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "shop_order_items_portal_read_own" on shop_order_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM shop_orders o
  WHERE ((o.id = shop_order_items.order_id) AND (o.portal_user_id = current_portal_user_id()))))));

alter policy "shop_orders_admin_read" on shop_orders
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "shop_orders_keeper_read" on shop_orders
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_orders.shop_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "shop_orders_portal_read_own" on shop_orders
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "shop_product_packs_delete" on shop_product_packs
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_products p
  WHERE ((p.id = shop_product_packs.shop_product_id) AND user_manages_shop(p.shop_id)))))));

alter policy "shop_product_packs_read" on shop_product_packs
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_products p
  WHERE ((p.id = shop_product_packs.shop_product_id) AND user_manages_shop(p.shop_id)))))));

alter policy "shop_product_packs_update" on shop_product_packs
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_products p
  WHERE ((p.id = shop_product_packs.shop_product_id) AND user_manages_shop(p.shop_id)))))));

alter policy "shop_product_packs_write" on shop_product_packs
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_products p
  WHERE ((p.id = shop_product_packs.shop_product_id) AND user_manages_shop(p.shop_id)))))));

alter policy "public_read_shop_products" on shop_products
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "shop_products_delete" on shop_products
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('delete_transactions'::character varying) OR user_manages_shop(shop_id))));

alter policy "shop_products_update" on shop_products
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))));

alter policy "shop_products_write" on shop_products
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))));

alter policy "shop_purchase_items_owner_read" on shop_purchase_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM shop_purchases pu
  WHERE ((pu.id = shop_purchase_items.purchase_id) AND (current_admin_permission('manage_parties'::character varying) OR user_manages_shop(pu.shop_id)))))));

alter policy "shop_purchases_owner_read" on shop_purchases
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))));

alter policy "shop_sale_items_owner_read" on shop_sale_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM shop_sales sa
  WHERE ((sa.id = shop_sale_items.sale_id) AND (current_admin_permission('manage_parties'::character varying) OR user_manages_shop(sa.shop_id) OR (EXISTS ( SELECT 1
           FROM shop_customer_links l
          WHERE ((l.customer_id = sa.customer_id) AND (l.portal_user_id = current_portal_user_id()))))))))));

alter policy "shop_sales_owner_read" on shop_sales
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id) OR (EXISTS ( SELECT 1
   FROM shop_customer_links l
  WHERE ((l.customer_id = shop_sales.customer_id) AND (l.portal_user_id = current_portal_user_id())))))));

alter policy "shop_staff_owner_delete" on shop_staff
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_staff.shop_id) AND (s.portal_user_id = current_portal_user_id())))))));

alter policy "shop_staff_owner_read" on shop_staff
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_staff.shop_id) AND (s.portal_user_id = current_portal_user_id())))) OR (portal_user_id = current_portal_user_id()))));

alter policy "shop_staff_owner_write" on shop_staff
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_staff.shop_id) AND (s.portal_user_id = current_portal_user_id())))))));

alter policy "shop_wallet_topups_admin_read" on shop_wallet_topups
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "shop_wallet_topups_keeper_read" on shop_wallet_topups
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM shops s
  WHERE ((s.id = shop_wallet_topups.shop_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "public_read_shops" on shops
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "shops_delete" on shops
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "shops_update" on shops
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "shops_write" on shops
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('manage_parties'::character varying))));

-- 46 policies total
