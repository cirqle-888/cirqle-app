-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback for 20260722090000_service_categories.sql
--
-- NOT REVERSED, deliberately: the §0 whitespace trim on services.name. That was
-- a data-quality fix ("Logo Design " → "Logo Design"), not part of the feature.
-- Re-introducing the trailing spaces would restore a bug that breaks every
-- name-matching path in the app, including CSV import.
--
-- Dropping service_categories cascades category_id to NULL on services via
-- ON DELETE SET NULL, so the column is emptied before it is dropped. Employee
-- CATEGORY assignments are lost; employee_services (individual assignments) is
-- untouched and remains the sole source of scope after this runs.
--
-- Anyone relying on category-level assignment loses that scope on rollback,
-- which WIDENS what they can see if their only assignment was a category, and
-- NARROWS it to nothing if they had no direct services. Re-check the health
-- panel after running this.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.employee_service_categories;

ALTER TABLE public.services DROP COLUMN IF EXISTS category_id;
DROP INDEX IF EXISTS public.services_category_idx;

DROP TABLE IF EXISTS public.service_categories;
