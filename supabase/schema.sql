-- Electronics Shop POS — run this in Supabase SQL Editor

-- Profiles (replaces Firebase users collection)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  role text not null check (role in ('admin', 'sales')),
  created_at timestamptz default now()
);

create table if not exists settings (
  id text primary key default 'main',
  base_fx numeric default 4500,
  current_fx numeric default 4500,
  round_to numeric default 100,
  default_margin numeric default 8,
  low_stock_threshold numeric default 5,
  margin_bands jsonb default '[{"max":10000,"margin":10},{"max":100000,"margin":5},{"max":null,"margin":4}]'::jsonb,
  updated_at timestamptz default now()
);

insert into settings (id) values ('main') on conflict (id) do nothing;

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  created_at timestamptz default now()
);

alter table suppliers add column if not exists address text;

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('HA', 'IA')),
  name text not null,
  sku text,
  barcode text unique,
  unit text default 'pcs',
  cost numeric default 0,
  cogs numeric default 0,
  margin_percent numeric,
  price numeric default 0,
  stock_qty numeric default 0,
  image_url text,
  brand text,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table products add column if not exists brand text;

create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  date timestamptz default now(),
  supplier_id uuid references suppliers(id) on delete set null,
  supplier_name text,
  product_id uuid references products(id) on delete set null,
  product_name text,
  qty numeric not null,
  unit_cost numeric default 0,
  batch_cogs numeric default 0,
  cogs_per_unit numeric default 0,
  total numeric default 0,
  payment_status text default 'paid',
  payment_type text default 'cash'
);

alter table purchases add column if not exists payment_type text default 'cash';

-- Allow deleting suppliers that still appear on old purchase rows.
do $$
begin
  alter table purchases drop constraint if exists purchases_supplier_id_fkey;
  alter table purchases
    add constraint purchases_supplier_id_fkey
    foreign key (supplier_id) references suppliers(id) on delete set null;
exception
  when duplicate_object then null;
end $$;

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  receipt_no text,
  date timestamptz default now(),
  user_id uuid references auth.users(id),
  customer_name text,
  payment_type text default 'cash',
  subtotal numeric default 0,
  discount_type text default 'none',
  discount_value numeric default 0,
  discount_amount numeric default 0,
  total numeric default 0
);

create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references sales(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  name text,
  barcode text,
  unit text,
  price numeric,
  qty numeric,
  line_total numeric,
  unit_cost numeric default 0,
  date timestamptz default now()
);

alter table sale_items add column if not exists unit_cost numeric default 0;

create table if not exists credits (
  id uuid primary key default gen_random_uuid(),
  type text check (type in ('receivable', 'payable')),
  party_name text,
  source_id uuid,
  amount numeric default 0,
  paid_amount numeric default 0,
  status text default 'open',
  date timestamptz default now()
);

create table if not exists credit_payments (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid references credits(id),
  amount numeric not null,
  payment_type text default 'cash',
  date timestamptz default now()
);

alter table credit_payments add column if not exists payment_type text default 'cash';

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  date timestamptz default now(),
  category text not null,
  amount numeric not null,
  note text,
  payment_type text default 'cash'
);

create table if not exists stock_damages (
  id uuid primary key default gen_random_uuid(),
  date timestamptz default now(),
  product_id uuid references products(id) on delete set null,
  product_name text,
  sku text,
  qty numeric not null,
  unit text,
  unit_cost numeric default 0,
  loss_value numeric default 0,
  note text,
  user_id uuid references auth.users(id)
);

create table if not exists stock_returns (
  id uuid primary key default gen_random_uuid(),
  date timestamptz default now(),
  product_id uuid references products(id) on delete set null,
  product_name text,
  sku text,
  qty numeric not null,
  unit text,
  unit_cost numeric default 0,
  refund_value numeric default 0,
  customer_name text,
  note text,
  user_id uuid references auth.users(id)
);

-- Migrations for existing deployments (safe to re-run)
alter table settings add column if not exists low_stock_threshold numeric default 5;
alter table products add column if not exists image_url text;
alter table sales add column if not exists subtotal numeric default 0;
alter table sales add column if not exists discount_type text default 'none';
alter table sales add column if not exists discount_value numeric default 0;
alter table sales add column if not exists discount_amount numeric default 0;

alter table products add column if not exists price_locked boolean default false;

alter table expenses add column if not exists payment_type text default 'cash';

create index if not exists products_name_idx on products (name);
create index if not exists sales_date_idx on sales (date desc);
create index if not exists sale_items_sale_id_idx on sale_items (sale_id);
create index if not exists purchases_date_idx on purchases (date desc);
create index if not exists credits_status_idx on credits (status);
create index if not exists expenses_date_idx on expenses (date desc);

-- Keep purchase and sale history when a product is deleted.
alter table purchases alter column product_id drop not null;
alter table sale_items alter column product_id drop not null;
alter table stock_damages alter column product_id drop not null;
alter table stock_returns alter column product_id drop not null;

alter table purchases drop constraint if exists purchases_product_id_fkey;
alter table purchases
  add constraint purchases_product_id_fkey
  foreign key (product_id) references products(id) on delete set null;

alter table sale_items drop constraint if exists sale_items_product_id_fkey;
alter table sale_items
  add constraint sale_items_product_id_fkey
  foreign key (product_id) references products(id) on delete set null;

alter table stock_damages drop constraint if exists stock_damages_product_id_fkey;
alter table stock_damages
  add constraint stock_damages_product_id_fkey
  foreign key (product_id) references products(id) on delete set null;

alter table stock_returns drop constraint if exists stock_returns_product_id_fkey;
alter table stock_returns
  add constraint stock_returns_product_id_fkey
  foreign key (product_id) references products(id) on delete set null;

-- Sales staff may change stock only. Prices and product details stay with admin.
create or replace function public.protect_product_prices()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.user_role() = 'sales' then
    new.price := old.price;
    new.cost := old.cost;
    new.cogs := old.cogs;
    new.margin_percent := old.margin_percent;
    new.name := old.name;
    new.sku := old.sku;
    new.barcode := old.barcode;
    new.type := old.type;
    new.brand := old.brand;
    new.unit := old.unit;
    new.image_url := old.image_url;
    new.active := old.active;
    new.price_locked := old.price_locked;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_product_prices on products;
create trigger protect_product_prices
before update on products
for each row execute function public.protect_product_prices();

-- Row Level Security
alter table profiles enable row level security;
alter table settings enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table suppliers enable row level security;
alter table purchases enable row level security;
alter table credits enable row level security;
alter table credit_payments enable row level security;
alter table expenses enable row level security;
alter table stock_damages enable row level security;
alter table stock_returns enable row level security;

create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid()
$$;

-- Profiles
drop policy if exists "profiles_select_own_or_admin" on profiles;
create policy "profiles_select_own_or_admin" on profiles
  for select to authenticated
  using (auth.uid() = id or user_role() = 'admin');

drop policy if exists "profiles_admin_write" on profiles;
create policy "profiles_admin_write" on profiles
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

-- Settings
drop policy if exists "settings_select_auth" on settings;
create policy "settings_select_auth" on settings
  for select to authenticated using (true);

drop policy if exists "settings_admin_write" on settings;
create policy "settings_admin_write" on settings
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

-- Products
drop policy if exists "products_select_auth" on products;
create policy "products_select_auth" on products
  for select to authenticated using (true);

drop policy if exists "products_admin_write" on products;
create policy "products_admin_write" on products
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

drop policy if exists "products_sales_update" on products;
create policy "products_sales_update" on products
  for update to authenticated
  using (user_role() = 'sales')
  with check (user_role() = 'sales');

-- Sales
drop policy if exists "sales_insert_staff" on sales;
create policy "sales_insert_staff" on sales
  for insert to authenticated with check (user_role() in ('admin', 'sales'));

drop policy if exists "sales_select_admin" on sales;
create policy "sales_select_admin" on sales
  for select to authenticated using (user_role() = 'admin');

-- Sales staff must be able to read the row they just inserted, or checkout is rejected.
drop policy if exists "sales_select_own" on sales;
create policy "sales_select_own" on sales
  for select to authenticated
  using (user_role() = 'sales' and user_id = auth.uid());

-- Sale items
drop policy if exists "sale_items_insert_staff" on sale_items;
create policy "sale_items_insert_staff" on sale_items
  for insert to authenticated with check (user_role() in ('admin', 'sales'));

drop policy if exists "sale_items_select_admin" on sale_items;
create policy "sale_items_select_admin" on sale_items
  for select to authenticated using (user_role() = 'admin');

drop policy if exists "sale_items_select_own" on sale_items;
create policy "sale_items_select_own" on sale_items
  for select to authenticated
  using (
    user_role() = 'sales'
    and exists (
      select 1 from sales
      where sales.id = sale_items.sale_id
        and sales.user_id = auth.uid()
    )
  );

drop policy if exists "sale_items_admin_update" on sale_items;
create policy "sale_items_admin_update" on sale_items
  for update to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

-- Suppliers, purchases, expenses, credit payments: admin only
drop policy if exists "suppliers_admin" on suppliers;
create policy "suppliers_admin" on suppliers
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

drop policy if exists "purchases_admin" on purchases;
create policy "purchases_admin" on purchases
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

drop policy if exists "expenses_admin" on expenses;
create policy "expenses_admin" on expenses
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

drop policy if exists "stock_damages_admin" on stock_damages;
create policy "stock_damages_admin" on stock_damages
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

drop policy if exists "stock_returns_admin" on stock_returns;
create policy "stock_returns_admin" on stock_returns
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

drop policy if exists "credit_payments_admin" on credit_payments;
create policy "credit_payments_admin" on credit_payments
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

-- Credits: admin full; sales can create receivables
drop policy if exists "credits_admin" on credits;
create policy "credits_admin" on credits
  for all to authenticated
  using (user_role() = 'admin')
  with check (user_role() = 'admin');

drop policy if exists "credits_sales_insert" on credits;
create policy "credits_sales_insert" on credits
  for insert to authenticated
  with check (user_role() = 'sales' and type = 'receivable');

drop policy if exists "credits_select_sales" on credits;
create policy "credits_select_sales" on credits
  for select to authenticated
  using (user_role() = 'sales' and type = 'receivable');
