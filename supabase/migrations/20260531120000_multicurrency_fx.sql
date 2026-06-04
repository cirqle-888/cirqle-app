-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Multi-currency / FX support                                               ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║  Additive + idempotent. Safe to run on the populated production DB.        ║
-- ║  Every column uses ADD COLUMN IF NOT EXISTS; every backfill is guarded by  ║
-- ║  a `rate_date IS NULL` / `*_inr IS NULL` sentinel so re-running is a no-op.║
-- ║                                                                            ║
-- ║  Model: invoice tracking stays in the INVOICE currency (total_amount /     ║
-- ║  paid_amount), while a parallel INR snapshot (*_inr) feeds all company     ║
-- ║  accounting/reporting. Each transaction records the rate used + its source.║
-- ║                                                                            ║
-- ║  ⚠ AUDIT BEFORE APPLYING — see the query at the bottom of this file to     ║
-- ║    confirm how many non-INR invoices exist and that their total_amount is  ║
-- ║    genuinely in the foreign currency (expected) before snapshotting INR.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

begin;

-- ─── 1. exchange_rates: where each settings rate came from + its value date ───
alter table exchange_rates add column if not exists rate_source text not null default 'manual';
alter table exchange_rates add column if not exists rate_date   date;

-- ─── 2. cashbook_entries: capture the rate used per entry ─────────────────────
--      (amount = foreign, amount_inr = INR base already exist)
alter table cashbook_entries add column if not exists exchange_rate numeric(18,6) not null default 1;
alter table cashbook_entries add column if not exists rate_source   text          not null default 'manual';
alter table cashbook_entries add column if not exists rate_date     date;

update cashbook_entries
   set exchange_rate = case
         when coalesce(currency, 'INR') = 'INR' then 1
         when coalesce(amount, 0) <> 0 then round(coalesce(amount_inr, amount)::numeric / amount, 6)
         else 1 end,
       rate_source = 'manual',
       rate_date   = coalesce(rate_date, entry_date)
 where rate_date is null;

-- ─── 3. invoices: add the INR snapshot + the creation rate ────────────────────
--      total_amount / paid_amount stay in the invoice currency (unchanged).
alter table invoices add column if not exists exchange_rate numeric(18,6) not null default 1;

-- Backfill the creation rate FIRST (foreign invoices use today's settings rate as
-- a best-effort proxy for the unknown historical rate). Must precede the generated
-- column below so it computes from the correct rate.
update invoices i
   set exchange_rate = coalesce((select er.rate_to_inr from exchange_rates er where er.currency = i.currency), 1)
 where coalesce(i.currency, 'INR') <> 'INR'
   and i.exchange_rate = 1;

-- total_amount_inr is GENERATED: it always equals total_amount × exchange_rate,
-- so it auto-tracks every line-item / tax / discount edit with zero app code at
-- those call sites. NEVER write to this column from the app.
alter table invoices add column if not exists total_amount_inr numeric(14,2)
  generated always as (round(total_amount * exchange_rate, 2)) stored;

-- paid_amount_inr is the SUM of each payment's OWN INR value (payments may settle
-- at different rates), so it cannot be generated — the app maintains it. Backfill
-- best-effort from the creation rate for historical rows.
alter table invoices add column if not exists paid_amount_inr numeric(14,2);
update invoices i
   set paid_amount_inr = round(coalesce(i.paid_amount, 0) * i.exchange_rate, 2)
 where i.paid_amount_inr is null;

-- ─── 4. payments: store the original foreign amount + rate + INR base ─────────
--      `amount` is already in the INVOICE currency (it feeds paid_amount).
alter table payments add column if not exists currency      text          not null default 'INR';
alter table payments add column if not exists exchange_rate numeric(18,6) not null default 1;
alter table payments add column if not exists amount_inr    numeric(14,2);
alter table payments add column if not exists rate_source   text          not null default 'manual';
alter table payments add column if not exists rate_date     date;

-- Backfill against the parent invoice (now carries exchange_rate from step 3).
update payments p
   set currency      = coalesce(i.currency, 'INR'),
       exchange_rate = case when coalesce(i.currency, 'INR') = 'INR' then 1 else coalesce(i.exchange_rate, 1) end,
       amount_inr    = round(coalesce(p.amount, 0) * case when coalesce(i.currency, 'INR') = 'INR' then 1 else coalesce(i.exchange_rate, 1) end, 2),
       rate_date     = coalesce(p.rate_date, p.payment_date)
  from invoices i
 where p.invoice_id = i.id
   and p.rate_date is null;

-- Orphan payments (no parent invoice) → treat as INR.
update payments
   set currency = 'INR', exchange_rate = 1,
       amount_inr = coalesce(amount_inr, amount),
       rate_date  = coalesce(rate_date, payment_date)
 where rate_date is null;

-- ─── 5. company_settings: seed FX defaults (key/value table) ──────────────────
insert into company_settings (key, value) values ('base_currency', 'INR')
  on conflict (key) do nothing;
insert into company_settings (key, value) values ('fx_auto_refresh_hours', '24')
  on conflict (key) do nothing;

commit;

-- ─── AUDIT (run separately BEFORE applying, then re-check after) ───────────────
-- Confirm non-INR invoice volume and that totals look like foreign amounts:
--   select currency, count(*), sum(total_amount), sum(paid_amount)
--     from invoices group by currency order by count(*) desc;
-- After applying, spot-check the INR snapshot for a known foreign invoice:
--   select invoice_number, currency, total_amount, exchange_rate, total_amount_inr
--     from invoices where currency <> 'INR' limit 20;
