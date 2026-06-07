-- Migration to add manual override flag to contribution_scores

ALTER TABLE public.contribution_scores
ADD COLUMN is_manual_override BOOLEAN NOT NULL DEFAULT false;

-- Add a comment explaining its purpose
COMMENT ON COLUMN public.contribution_scores.is_manual_override IS 'When true, bulk recalculations will skip overwriting this score.';
