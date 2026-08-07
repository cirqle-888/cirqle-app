-- Design handoff lock (Cirqle Studio workflow).
--
-- A campaign locks ONLY when the designer explicitly presses "Mark as
-- Designed" in the Figma plugin — ordinary plugin saves never lock. While
-- locked, client/staff edits are refused server-side ("this offer is with the
-- designer"); figma-actor saves stay allowed so designer touch-ups don't need
-- admin unlocks. The designer can self-undo within 15 minutes (checked in
-- code); after that, only an admin Unlock (dashboard) clears these columns.
--
-- design_locked_by is an employee id — never rendered as a name (privacy
-- rule: CQID only).

alter table offer_campaigns add column if not exists design_locked_at timestamptz;
alter table offer_campaigns add column if not exists design_locked_by uuid references employees(id) on delete set null;

comment on column offer_campaigns.design_locked_at is
  'Set when the designer pressed Mark as Designed in Cirqle Studio; null = editable. 15-min self-undo window, then admin-only unlock.';
