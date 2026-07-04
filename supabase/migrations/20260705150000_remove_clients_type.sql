-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Remove clients.client_type (reverts 20260705140000)                      ║
-- ║                                                                            ║
-- ║  Design decision: all clients are businesses. Individuals who bring work  ║
-- ║  are modeled as Business Partners (linked to the real business clients),  ║
-- ║  not as a client sub-type. Direct personal jobs simply get a normal       ║
-- ║  client row — no tag needed.                                              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

ALTER TABLE public.clients DROP COLUMN IF EXISTS client_type;

COMMIT;
