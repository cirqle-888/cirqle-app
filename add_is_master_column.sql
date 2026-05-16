-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- Adds is_master column to parameters table

ALTER TABLE parameters
  ADD COLUMN IF NOT EXISTS is_master BOOLEAN DEFAULT false;

-- Mark master parameters (Design + Products) based on weight = 1
-- Run this AFTER adding the column, or update manually via Settings
UPDATE parameters SET is_master = true WHERE weight = 1;
