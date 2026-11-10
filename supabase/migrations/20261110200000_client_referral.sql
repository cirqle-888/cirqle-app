-- Client referral: "this client came through <staff> — pay them X% of its work".
--
-- Builds on 20261110100000_task_referral_commission (run that first). A job
-- already carries its own referral (tasks.referred_by / referral_percent) and
-- the built-in "Referral commission" program pays it. Typing that on every job
-- of a referred client is the part people forget, so the client can now carry
-- it too:
--
--   clients.referred_by       — staff member the client came through
--   clients.referral_percent  — their share of each job's billing
--   clients.referral_from     — first job date it applies to
--   clients.referral_until    — last job date it applies to (NULL = no end)
--
-- A trigger copies it onto every NEW job of that client dated inside the
-- range — whichever path creates the job (editor, request, WhatsApp, import).
-- The job keeps its own copy, so:
--   * a job can still be changed or cleared on its own in the edit window;
--   * changing the client later never rewrites a paid month.
-- Re-applying the client's referral to jobs that already exist is done by the
-- app when the client referral is saved (unpaid months only).

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_percent numeric(6,2),
  ADD COLUMN IF NOT EXISTS referral_from date,
  ADD COLUMN IF NOT EXISTS referral_until date;

-- All set or none. ON DELETE SET NULL on referred_by would leave a % behind
-- and break this check, so a deleted employee's referral is cleared whole by
-- the trigger below rather than half-cleared by the FK.
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_referral_shape;
ALTER TABLE public.clients ADD CONSTRAINT clients_referral_shape CHECK (
  (referred_by IS NULL AND referral_percent IS NULL AND referral_from IS NULL AND referral_until IS NULL)
  OR (
    referred_by IS NOT NULL AND referral_percent > 0 AND referral_percent <= 100
    AND referral_from IS NOT NULL
    AND (referral_until IS NULL OR referral_until >= referral_from)
  )
);

CREATE OR REPLACE FUNCTION public.cirqle_clear_client_referral() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.referred_by IS NULL THEN
    NEW.referral_percent := NULL;
    NEW.referral_from := NULL;
    NEW.referral_until := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS clients_referral_clear ON public.clients;
CREATE TRIGGER clients_referral_clear BEFORE UPDATE OF referred_by ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.cirqle_clear_client_referral();

COMMENT ON COLUMN public.clients.referred_by IS
  'Staff member this client came through. Copied onto each new job dated referral_from..referral_until, which the "Referral commission" program then pays.';
COMMENT ON COLUMN public.clients.referral_percent IS
  'Referrer''s share of each job''s billing, 0–100. Copied onto the job, so later changes never rewrite paid months.';

-- ── New jobs inherit the client's referral ──────────────────────────────────
-- SECURITY DEFINER: whoever creates the job may not be allowed to read the
-- client's referral columns, and the copy must happen regardless.
CREATE OR REPLACE FUNCTION public.cirqle_task_client_referral() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c record;
BEGIN
  -- The job already says something (set on purpose) — never overwrite it.
  IF NEW.client_id IS NULL OR NEW.referred_by IS NOT NULL OR NEW.referral_percent IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- On update, only a job moved to another client is (re)considered.
  IF TG_OP = 'UPDATE' AND OLD.client_id IS NOT DISTINCT FROM NEW.client_id THEN
    RETURN NEW;
  END IF;

  SELECT cl.referred_by, cl.referral_percent, cl.referral_from, cl.referral_until
    INTO c
    FROM public.clients cl
   WHERE cl.id = NEW.client_id;

  IF c.referred_by IS NULL
     OR NEW.task_date < c.referral_from
     OR (c.referral_until IS NOT NULL AND NEW.task_date > c.referral_until)
     OR NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = c.referred_by AND e.is_active)
  THEN
    RETURN NEW;
  END IF;

  NEW.referred_by := c.referred_by;
  NEW.referral_percent := c.referral_percent;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.cirqle_task_client_referral() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_client_referral ON public.tasks;
CREATE TRIGGER tasks_client_referral BEFORE INSERT OR UPDATE OF client_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.cirqle_task_client_referral();

COMMIT;
