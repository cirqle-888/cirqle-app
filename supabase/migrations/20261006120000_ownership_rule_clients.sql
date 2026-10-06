-- Client-handling rules choose their own clients
--
-- Several people can handle the same client. A client-handling ownership rule
-- now lists the clients its person handles (client_ids); two rules may list
-- the same client and each person earns on it. A rule with no clients falls
-- back to the client_handlers table.
--
-- Safe in either order with the code: client_ids is only written for
-- client-handling rules, which fail with a "run the migration" message until
-- this runs.

BEGIN;

ALTER TABLE public.ownership_rules ADD COLUMN IF NOT EXISTS client_ids uuid[];
COMMENT ON COLUMN public.ownership_rules.client_ids IS
  'clients_handled programs only: the clients this rule''s person handles. NULL/empty = use client_handlers.';

COMMIT;
