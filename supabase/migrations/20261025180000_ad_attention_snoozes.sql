-- Needs-attention snoozes for the advertising overview.
--
-- Additive. Until this is applied the overview simply hides the Snooze
-- button; every alert still shows. One row per alert key (keys are stable
-- per condition, e.g. 'overspent:<project>' or 'zero-spend:<project>:<date>'),
-- so a snooze hides that occurrence until it expires and a new occurrence
-- shows again.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_attention_snoozes (
  alert_key     TEXT PRIMARY KEY,
  snoozed_until TIMESTAMPTZ NOT NULL,
  snoozed_by    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ad_attention_snoozes_until_idx
  ON public.ad_attention_snoozes (snoozed_until);

-- Writes go through the guarded server action (admin client); signed-in
-- users may read, matching the advertising module tables.
ALTER TABLE public.ad_attention_snoozes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ad_attention_snoozes_select" ON public.ad_attention_snoozes;
CREATE POLICY "ad_attention_snoozes_select" ON public.ad_attention_snoozes
  FOR SELECT TO authenticated USING (true);

COMMIT;
