-- Reverses 20261122180000_shop_orders. DROPS EVERY SHOP ORDER: back up first.
BEGIN;
DELETE FROM public.designation_permissions
 WHERE permission_id IN (SELECT id FROM public.permissions WHERE key IN ('orders.view','orders.manage'));
DELETE FROM public.permissions WHERE key IN ('orders.view','orders.manage');
DROP TABLE IF EXISTS public.shop_orders;
DROP SEQUENCE IF EXISTS public.shop_order_no_seq;
NOTIFY pgrst, 'reload schema';
COMMIT;
