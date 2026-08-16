-- Run this in Supabase SQL Editor to set up the database

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_phone text unique not null,  -- e.g. whatsapp:+2348012345678
  business_type text,                -- shop, salon, restaurant, etc.
  pin text,                          -- 4-digit code for dashboard login
  email text,                        -- optional contact email
  created_at timestamptz default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) not null,
  type text not null check (type in ('sale', 'expense')),
  amount numeric not null,
  description text,
  raw_message text,                  -- original WhatsApp text/receipt caption
  created_at timestamptz default now()
);

create table customer_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) not null,
  customer_phone text not null,
  incoming_message text,
  agent_reply text,
  created_at timestamptz default now()
);

create table weekly_reports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) not null,
  week_start date,
  week_end date,
  total_sales numeric,
  total_expenses numeric,
  profit numeric,
  best_day text,
  summary_text text,
  created_at timestamptz default now()
);

create index on transactions (business_id, created_at);
create index on customer_messages (business_id, created_at);

-- If you already ran schema.sql before and your businesses table exists,
-- run this instead to just add the new column:
-- alter table businesses add column if not exists pin text;

-- Credit tracking: debts owed to the business, and payments against them.
-- Outstanding balance per customer = sum(debt) - sum(payment).
create table credit_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) not null,
  customer_name text not null,
  type text not null check (type in ('debt', 'payment')),
  amount numeric not null,
  description text,
  created_at timestamptz default now()
);

create index on credit_entries (business_id, customer_name);

-- If you already ran schema.sql before this feature was added, run just this:
-- create table credit_entries (
--   id uuid primary key default gen_random_uuid(),
--   business_id uuid references businesses(id) not null,
--   customer_name text not null,
--   type text not null check (type in ('debt', 'payment')),
--   amount numeric not null,
--   description text,
--   created_at timestamptz default now()
-- );
-- create index on credit_entries (business_id, customer_name);

-- Inventory: tracks stock per item per business. Adjusted automatically
-- when a sale mentions a quantity, or explicitly via a restock message.
create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) not null,
  item_name text not null,
  unit text,
  current_stock numeric not null default 0,
  low_stock_threshold numeric not null default 5,
  updated_at timestamptz default now()
);
create unique index on inventory_items (business_id, item_name);

-- Payables: money the business owes to suppliers or others. The agent
-- drafts these and only sends money after the owner explicitly confirms.
create table payables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) not null,
  payee_name text not null,
  amount numeric not null,
  reason text,
  account_number text,
  bank_name text,
  status text not null default 'pending' check (status in ('pending', 'sent')),
  created_at timestamptz default now(),
  sent_at timestamptz
);
create index on payables (business_id, status);

-- If you already ran schema.sql before, run just these two blocks:
-- create table inventory_items (
--   id uuid primary key default gen_random_uuid(),
--   business_id uuid references businesses(id) not null,
--   item_name text not null,
--   unit text,
--   current_stock numeric not null default 0,
--   low_stock_threshold numeric not null default 5,
--   updated_at timestamptz default now()
-- );
-- create unique index on inventory_items (business_id, item_name);
--
-- create table payables (
--   id uuid primary key default gen_random_uuid(),
--   business_id uuid references businesses(id) not null,
--   payee_name text not null,
--   amount numeric not null,
--   reason text,
--   account_number text,
--   bank_name text,
--   status text not null default 'pending' check (status in ('pending', 'sent')),
--   created_at timestamptz default now(),
--   sent_at timestamptz
-- );
-- create index on payables (business_id, status);

-- Optional contact email for a business, collected during onboarding.
-- alter table businesses add column if not exists email text;
