-- Social calendar items → Requests alignment: an optional service per item.
--
-- Pushed calendar items become real task_requests, but until now they arrived
-- with NO service — missing the service-based pricing, routing, and reporting
-- every other request type gets. This column lets the planner pick (or accept
-- an auto-suggestion for) the service each item's design request should carry;
-- pushItemsToRequests forwards it to createManualRequest.
--
-- Nullable + additive: existing rows and pre-migration app code keep working.

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES public.services(id) ON DELETE SET NULL;
