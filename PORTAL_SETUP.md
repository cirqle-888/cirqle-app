# Employee Portal Setup

## 1. SQL Migration (run in Supabase Dashboard → SQL Editor)

Add the `portal_token` column to the `employees` table and auto-generate tokens for all existing employees:

```sql
-- Add portal_token column
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS portal_token uuid DEFAULT gen_random_uuid();

-- Backfill any NULLs (employees created before migration)
UPDATE employees
  SET portal_token = gen_random_uuid()
  WHERE portal_token IS NULL;

-- Make it NOT NULL going forward
ALTER TABLE employees
  ALTER COLUMN portal_token SET NOT NULL;

-- Add a unique index so token lookups are fast and tokens can't collide
CREATE UNIQUE INDEX IF NOT EXISTS employees_portal_token_idx ON employees (portal_token);
```

After running this, every employee will have a unique, random token that acts as their portal URL.

---

## 2. Add SUPABASE_SERVICE_ROLE_KEY to .env.local

The employee portal uses the Supabase service role key to bypass Row Level Security (so it can read employee data by token without a user session).

1. Go to your Supabase project → **Settings** → **API**
2. Copy the **service_role** secret key (NOT the anon key)
3. Open `/Users/farooq/cirqle-app/.env.local` and add:

```env
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

> **Security note:** The service role key bypasses RLS. It is only used in server-side code (Server Components and Server Actions) and is never exposed to the browser. Never set it as `NEXT_PUBLIC_`.

---

## 3. Share Portal Links with Employees

Each employee's portal URL is:
```
https://your-domain.com/portal/<portal_token>
```

**To copy a link:**
1. Go to **Dashboard → Settings → Employees**
2. Find the employee card
3. Click the **link icon** (chain link button) next to the Edit button
4. The link is copied to your clipboard — paste it into WhatsApp, email, or Slack

**What employees see:**
- Their assigned tasks organized into three sections:
  - **Needs Your Input** — tasks where they haven't submitted contribution scores yet
  - **Submitted — Awaiting Review** — tasks submitted but not yet scored by admin
  - **Scored** — tasks where admin has finalized scores and earnings are shown in ₹
- A summary bar showing pending count, submitted count, and total earned

**Employee workflow:**
1. Employee opens their portal link (no login required)
2. Expands a pending task
3. Adjusts sliders or types values (0–100%) for each contribution parameter
4. Clicks **Submit Contribution**
5. Admin reviews and finalizes scores in the main dashboard

Employees can update their submissions at any time before admin scores the task.

---

## Notes

- Portal tokens are permanent UUIDs — they don't expire unless you manually reset them
- To reset an employee's token (e.g., if a link is shared accidentally), run:
  ```sql
  UPDATE employees SET portal_token = gen_random_uuid() WHERE id = '<employee_id>';
  ```
- The portal is mobile-first and works on any device without installing anything
