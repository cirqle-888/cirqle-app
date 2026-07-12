-- Add Google Sheet URL to clients table
alter table clients add column if not exists offer_sheet_url text;
