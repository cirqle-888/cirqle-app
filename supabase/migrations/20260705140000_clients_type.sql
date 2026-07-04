-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Client Individual vs Company classification                              ║
-- ║                                                                            ║
-- ║  Not all work comes through a registered business — some clients are      ║
-- ║  individuals. This is a simple display/filter tag only: it does not       ║
-- ║  change GSTIN requirements, invoice fields, or invoice workflow.          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'company'
    CHECK (client_type IN ('company', 'individual'));

COMMIT;
