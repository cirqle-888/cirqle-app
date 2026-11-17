-- Gives `authenticated` back every column of tasks and contribution_scores.
-- This reopens the console leak of task prices and earnings.
BEGIN;
GRANT SELECT ON public.tasks TO authenticated;
GRANT SELECT ON public.contribution_scores TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
