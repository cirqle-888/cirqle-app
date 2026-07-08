-- Default/primary bank account: one account can be marked as the default,
-- used to pre-select the account on payment/entry forms.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- Only one account can be default at a time.
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_one_default
  ON bank_accounts ((is_default))
  WHERE is_default = true;
