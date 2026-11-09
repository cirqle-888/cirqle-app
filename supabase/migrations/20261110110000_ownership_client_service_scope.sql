-- Ownership: scope a program to ONE SERVICE OF ONE CLIENT.
--
-- "Pay Asha 5% of what Sea Star bills for Social Media Posters." A program
-- could already be scoped to a client (all of that client's work) or to a
-- service (that service for every client), but not to the two together.
--
-- ownership_programs.scope_service_id narrows a client-scoped program to one
-- of that client's services. Null keeps today's behaviour: the whole client.
--
-- Billing only. Collections are cash receipts, which carry a client but no
-- service, so a service narrowing there would measure nothing.
--
-- Safe in either order with the code: until this runs the form saves every
-- program as before, and only an attempt to pick a service is refused with a
-- "run the migration" message.

BEGIN;

ALTER TABLE public.ownership_programs
  ADD COLUMN IF NOT EXISTS scope_service_id uuid REFERENCES public.services(id) ON DELETE CASCADE;

ALTER TABLE public.ownership_programs DROP CONSTRAINT IF EXISTS ownership_programs_service_narrowing;
ALTER TABLE public.ownership_programs ADD CONSTRAINT ownership_programs_service_narrowing CHECK (
  scope_service_id IS NULL OR (scope_kind = 'client' AND basis = 'billing')
);

COMMENT ON COLUMN public.ownership_programs.scope_service_id IS
  'Client-scoped billing programs only: count just this service of that client. Null = all of the client''s work.';

COMMIT;
