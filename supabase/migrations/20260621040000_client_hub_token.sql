-- A client who has BOTH the Standard Request service and the Offer Intake
-- service today has to be sent two completely unrelated links (intake_links.token
-- for requests, clients.offer_intake_token for offers) — there was no single
-- link to share. This adds one unguessable per-client "hub" token: a public
-- landing page at /start/<token> that shows only the intake app(s) that
-- client's assigned services actually enable (single service → redirects
-- straight through, no extra click).
alter table clients add column if not exists hub_token uuid unique default gen_random_uuid();
update clients set hub_token = gen_random_uuid() where hub_token is null;
alter table clients alter column hub_token set not null, alter column hub_token set default gen_random_uuid();
