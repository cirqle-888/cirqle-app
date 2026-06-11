-- Internal transfers: link paired cashbook entries (outflow + inflow)
-- created by the Transfer modal.
ALTER TABLE cashbook_entries ADD COLUMN IF NOT EXISTS transfer_ref uuid;
CREATE INDEX IF NOT EXISTS cashbook_entries_transfer_ref_idx
  ON cashbook_entries(transfer_ref) WHERE transfer_ref IS NOT NULL;
