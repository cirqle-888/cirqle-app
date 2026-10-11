-- Saying which department a client belongs to, when the services cannot.
--
-- THE EXISTING MODEL. A client's departments are DERIVED: it buys services,
-- each service has a `category_id`, and the set of those categories is the set
-- of departments the client appears under (src/app/(dashboard)/dashboard/
-- clients/page.tsx). Nothing is stored, deliberately — 20260722090000 chose
-- that axis on purpose, because "a logo is a branding job" stays true while
-- departments get reorganised.
--
-- WHERE IT FALLS SHORT. Derivation answers "what do we deliver for them",
-- which is not always the same question as "whose client is this".
--
--   · A client with no services configured yet — a new one, a draft — derives
--     to nothing at all and appears under "No department". That is precisely
--     the client somebody needs to find and own.
--   · A client that buys one Print job inside an otherwise Social Media
--     relationship derives into both, and shows up in a Print lead's list as
--     if it were theirs.
--
-- THE MODEL. One optional override on the client. NULL — the default, and the
-- state of every existing row — means "derive it, exactly as before", so
-- nothing changes for any client until somebody deliberately sets one. When
-- set, it is the client's department and the derived set is still computed and
-- shown beside it, so a disagreement between the two is visible rather than
-- silent. Which one wins is decided in the application
-- (src/lib/clients/department-filter.ts), not here.
--
-- ONE department, not many. The override exists to answer an ownership
-- question, and an ownership question with three answers has not been
-- answered. A client that genuinely spans departments should leave this NULL
-- and let the services speak.
--
-- ON DELETE SET NULL: retiring a department reverts its clients to derived
-- rather than blocking the delete or orphaning a dangling id.
--
-- Rollback: supabase/rollbacks/20261011120000_client_department_down.sql

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS department_id UUID
    REFERENCES public.service_categories(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.clients.department_id IS
  'Optional override for the client''s department. NULL (the default) means derive it from the services the client buys, which is the original behaviour. Precedence is decided in src/lib/clients/department-filter.ts, not by this column.';

-- Partial: the overwhelming majority of rows are NULL and are never looked up
-- by this column, so indexing them would be paying for the default case.
CREATE INDEX IF NOT EXISTS clients_department_id_idx
  ON public.clients (department_id)
  WHERE department_id IS NOT NULL;

COMMIT;
