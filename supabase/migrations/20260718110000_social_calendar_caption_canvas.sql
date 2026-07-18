-- Free-drag visual canvas for a calendar item's Caption / copy.
--
-- The existing `caption` column stays exactly as it is: rich HTML that feeds
-- the designer brief, Excel and search. This adds a SEPARATE, optional visual
-- board where reference images and short text labels are positioned freely —
-- the mood-board view of the same item.
--
-- Shape (validated in src/lib/social/plan.ts, never trusted from the client):
--   {
--     "w": 640, "h": 360,
--     "blocks": [
--       { "id":"b1", "type":"image", "x":24, "y":16, "w":220, "h":160, "z":1,
--         "url":"https://…" },
--       { "id":"b2", "type":"text",  "x":24, "y":190,"w":300, "h":48,  "z":2,
--         "text":"Onam hero shot", "size":16, "bold":true,
--         "color":"#111827", "align":"left" }
--     ]
--   }
--
-- Coordinates are in a FIXED 640-wide design space, so the PDF can scale the
-- board deterministically into the plan table's Content column.

ALTER TABLE public.social_calendar_items
  ADD COLUMN IF NOT EXISTS caption_canvas JSONB;
