-- ─────────────────────────────────────────────────────────────────────────────
-- Org-unit visibility scope — "my department / team / branch / region only"
--
-- Adds the middle rung between "own" and "everyone" to the visibility ladder.
-- Pure catalog work: the org chart tables (org_units, org_unit_members,
-- org_unit_scopes) already exist from 20260807100000_ownership_platform.sql;
-- this migration only publishes the keys that read them, resolved in
-- src/lib/scope/unit-scope.ts.
--
-- NOT granted to admin designations. `scope.by_unit` and `tasks.view_by_unit`
-- are RESTRICTIONS — auto-granting them would confine every admin to their own
-- team the moment this runs. Admins bypass the catalog anyway.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('contributions', 'view_unit', 'contributions.view_unit',
   'View team contributions',
   'See the contributions of everyone in the user''s own department, team, branch or region — and every unit beneath it — instead of only their own rows. Ignored when "View all contributions" is also on.',
   32),
  ('tasks', 'view_by_unit', 'tasks.view_by_unit',
   'Restrict tasks to own team',
   'User only sees tasks belonging to their own department, team, branch or region: the clients and services those units are mapped to, plus any task the user or their unit-mates worked on.',
   18),
  ('scope', 'by_unit', 'scope.by_unit',
   'Restrict to own team',
   'User only sees their own department, team, branch or region — and every unit beneath it — across modules. Leave OFF for admin, task-manager and finance designations.',
   18)
ON CONFLICT (key) DO NOTHING;

COMMIT;
