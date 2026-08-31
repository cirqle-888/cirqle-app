-- ============================================================================
-- Split the portfolio position out of `billing.view_amounts`
-- ============================================================================
--
-- THE PROBLEM
-- `billing.view_amounts` answered two different questions with one grant:
--
--   1. "what is on THIS invoice?"      — its total, what is paid, what is
--                                        outstanding, the figures that go into
--                                        a client's payment reminder
--   2. "what is the company owed?"     — total outstanding across every client,
--                                        total overdue, draft value
--
-- Someone doing collections needs (1) to write a reminder at all. They do not
-- necessarily need (2), and (2) is the more sensitive of the pair: it is the
-- company's cash position, not one client's balance. With a single grant there
-- was no way to give the first without the second, so a follow-up role either
-- saw the whole portfolio or could not tell a client what they owed.
--
-- `billing.view_totals` now carries (2) alone. `billing.view_amounts` keeps (1).
--
-- ── WHY THE BACKFILL MATTERS ────────────────────────────────────────────────
--
-- The aggregates were previously ungated in the UI, so introducing a gate takes
-- them away from everyone by default — including the owner. The INSERT ... SELECT
-- below grants the new permission to every designation that already holds
-- `billing.view_amounts`, so for existing roles nothing changes at all. The new
-- key only ever means something for a designation configured after this runs.
--
-- Idempotent. Transactional.
-- Rollback: supabase/rollbacks/20260831090000_billing_view_totals_down.sql
-- ============================================================================

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES (
  'billing',
  'view_totals',
  'billing.view_totals',
  'View invoice totals across clients',
  'See the portfolio position — total outstanding, total overdue and draft value summed across every client. Separate from "View invoice amounts", which covers the figures on a single invoice.',
  66
)
ON CONFLICT (key) DO NOTHING;

-- Preserve today's behaviour: anyone who can already see invoice amounts keeps
-- seeing the totals they see now.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT dp.designation_id, new_p.id, true
FROM public.designation_permissions dp
JOIN public.permissions old_p ON old_p.id = dp.permission_id AND old_p.key = 'billing.view_amounts'
CROSS JOIN LATERAL (SELECT id FROM public.permissions WHERE key = 'billing.view_totals') new_p
WHERE dp.allowed = true
ON CONFLICT (designation_id, permission_id) DO NOTHING;

COMMIT;
