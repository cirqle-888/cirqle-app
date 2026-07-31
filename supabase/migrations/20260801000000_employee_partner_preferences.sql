create table if not exists employee_partner_preferences (
  employee_id uuid references employees(id) on delete cascade,
  business_partner_id uuid references business_partners(id) on delete cascade,
  greeting_name text,
  updated_at timestamptz default now(),
  primary key (employee_id, business_partner_id)
);

alter table employee_partner_preferences enable row level security;
