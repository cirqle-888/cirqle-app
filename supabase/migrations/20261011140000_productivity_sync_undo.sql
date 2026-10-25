-- Cross-device snoozes and single-use, concurrency-checked undo receipts.
-- Only server actions may access these tables/functions, through service_role.
BEGIN;

CREATE TABLE public.employee_notification_snoozes (
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  group_key text NOT NULL CHECK (length(group_key) BETWEEN 1 AND 2048),
  until_at timestamptz NOT NULL,
  PRIMARY KEY (employee_id, group_key)
);
ALTER TABLE public.employee_notification_snoozes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_notification_snoozes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.employee_notification_snoozes TO service_role;

CREATE TABLE public.productivity_undo_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('client_department', 'task_assignment', 'request_assignment')),
  target_id uuid NOT NULL,
  before_value jsonb NOT NULL,
  expected_revision uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '10 minutes'),
  consumed_at timestamptz
);
CREATE INDEX productivity_undo_employee_idx ON public.productivity_undo_receipts(employee_id, expires_at);
ALTER TABLE public.productivity_undo_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.productivity_undo_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.productivity_undo_receipts TO service_role;

-- Every update rotates the revision, including changes made outside this app.
ALTER TABLE public.clients ADD COLUMN productivity_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.tasks ADD COLUMN productivity_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.task_requests ADD COLUMN productivity_revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION public.cirqle_rotate_productivity_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.productivity_revision := gen_random_uuid();
  RETURN NEW;
END; $$;
CREATE TRIGGER productivity_revision BEFORE UPDATE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.cirqle_rotate_productivity_revision();
CREATE TRIGGER productivity_revision BEFORE UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.cirqle_rotate_productivity_revision();
CREATE TRIGGER productivity_revision BEFORE UPDATE ON public.task_requests
FOR EACH ROW EXECUTE FUNCTION public.cirqle_rotate_productivity_revision();

-- Assignment edits also invalidate a task's receipt. Lock the parent BEFORE
-- a child write, so a concurrent writer cannot slip in after an undo check.
CREATE FUNCTION public.cirqle_assignment_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.tasks SET productivity_revision = gen_random_uuid() WHERE id = OLD.task_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    UPDATE public.tasks SET productivity_revision = gen_random_uuid() WHERE id = NEW.task_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER productivity_assignment_revision BEFORE INSERT OR UPDATE OR DELETE ON public.task_assignments
FOR EACH ROW EXECUTE FUNCTION public.cirqle_assignment_revision();

CREATE FUNCTION public.cirqle_apply_reversible_change(
  p_employee_id uuid, p_kind text, p_target_id uuid, p_value jsonb
) RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE before_value jsonb; revision uuid; receipt uuid;
BEGIN
  IF p_kind = 'client_department' THEN
    SELECT to_jsonb(c.department_id) INTO before_value FROM public.clients c WHERE c.id = p_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Record not found'; END IF;
    UPDATE public.clients SET department_id = (p_value #>> '{}')::uuid
      WHERE id = p_target_id RETURNING productivity_revision INTO revision;
  ELSIF p_kind = 'request_assignment' THEN
    SELECT to_jsonb(r.assigned_employee_id) INTO before_value FROM public.task_requests r WHERE r.id = p_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Record not found'; END IF;
    UPDATE public.task_requests SET assigned_employee_id = (p_value #>> '{}')::uuid, updated_at = clock_timestamp()
      WHERE id = p_target_id RETURNING productivity_revision INTO revision;
  ELSIF p_kind = 'task_assignment' THEN
    PERFORM 1 FROM public.tasks WHERE id = p_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Record not found'; END IF;
    IF jsonb_typeof(p_value) <> 'array' THEN RAISE EXCEPTION 'Expected employee ids'; END IF;
    SELECT coalesce(jsonb_agg(a.employee_id ORDER BY a.employee_id), '[]'::jsonb) INTO before_value
      FROM public.task_assignments a WHERE a.task_id = p_target_id;
    DELETE FROM public.task_assignments WHERE task_id = p_target_id;
    INSERT INTO public.task_assignments(task_id, employee_id)
      SELECT p_target_id, value::uuid FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(p_value)) e;
    UPDATE public.tasks SET productivity_revision = gen_random_uuid()
      WHERE id = p_target_id RETURNING productivity_revision INTO revision;
  ELSE RAISE EXCEPTION 'Unsupported action'; END IF;

  -- Bound retention; expired receipts cannot be restored anyway.
  DELETE FROM public.productivity_undo_receipts WHERE employee_id = p_employee_id AND expires_at < clock_timestamp();
  INSERT INTO public.productivity_undo_receipts(employee_id, kind, target_id, before_value, expected_revision)
    VALUES (p_employee_id, p_kind, p_target_id, coalesce(before_value, 'null'::jsonb), revision)
    RETURNING id INTO receipt;
  RETURN receipt;
END; $$;

CREATE FUNCTION public.cirqle_undo_reversible_change(p_employee_id uuid, p_receipt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE receipt public.productivity_undo_receipts; revision uuid;
BEGIN
  SELECT * INTO receipt FROM public.productivity_undo_receipts
    WHERE id = p_receipt_id AND employee_id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unavailable'); END IF;
  IF receipt.consumed_at IS NOT NULL OR receipt.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF receipt.kind = 'client_department' THEN
    SELECT productivity_revision INTO revision FROM public.clients WHERE id = receipt.target_id FOR UPDATE;
  ELSIF receipt.kind = 'request_assignment' THEN
    SELECT productivity_revision INTO revision FROM public.task_requests WHERE id = receipt.target_id FOR UPDATE;
  ELSIF receipt.kind = 'task_assignment' THEN
    SELECT productivity_revision INTO revision FROM public.tasks WHERE id = receipt.target_id FOR UPDATE;
  END IF;
  IF revision IS DISTINCT FROM receipt.expected_revision THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'changed');
  END IF;
  IF receipt.kind = 'client_department' THEN
    UPDATE public.clients SET department_id = (receipt.before_value #>> '{}')::uuid WHERE id = receipt.target_id;
  ELSIF receipt.kind = 'request_assignment' THEN
    UPDATE public.task_requests SET assigned_employee_id = (receipt.before_value #>> '{}')::uuid,
      updated_at = clock_timestamp() WHERE id = receipt.target_id;
  ELSE
    DELETE FROM public.task_assignments WHERE task_id = receipt.target_id;
    INSERT INTO public.task_assignments(task_id, employee_id)
      SELECT receipt.target_id, value::uuid FROM jsonb_array_elements_text(receipt.before_value);
    UPDATE public.tasks SET productivity_revision = gen_random_uuid() WHERE id = receipt.target_id;
  END IF;
  UPDATE public.productivity_undo_receipts SET consumed_at = clock_timestamp() WHERE id = receipt.id;
  RETURN jsonb_build_object('ok', true, 'targetId', receipt.target_id, 'kind', receipt.kind);
END; $$;

REVOKE ALL ON FUNCTION public.cirqle_rotate_productivity_revision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cirqle_assignment_revision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cirqle_apply_reversible_change(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cirqle_undo_reversible_change(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cirqle_rotate_productivity_revision() TO service_role;
GRANT EXECUTE ON FUNCTION public.cirqle_assignment_revision() TO service_role;
GRANT EXECUTE ON FUNCTION public.cirqle_apply_reversible_change(uuid, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cirqle_undo_reversible_change(uuid, uuid) TO service_role;
COMMIT;
