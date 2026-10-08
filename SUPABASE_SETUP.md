# Supabase Setup

## 1. Create project

1. Go to [supabase.com](https://supabase.com) and create a project.
2. Pick a region close to Myanmar (e.g. Singapore).
3. Save your database password.

## 2. Run database schema

1. Open **SQL Editor** in Supabase.
2. Paste and run the full contents of [`supabase/schema.sql`](supabase/schema.sql).

This creates tables for products, sales, purchases, credits, expenses, stock damages, stock returns, settings, and RLS policies.

## 3. Enable email auth

1. **Authentication** → **Providers** → enable **Email**.
2. For testing, disable **Confirm email** so new users can sign in immediately.

## 4. Create admin user

1. **Authentication** → **Users** → **Add user**.
2. Set email + password (this is the login for the POS).
3. Copy the user's **UUID**.
4. In SQL Editor:

```sql
insert into profiles (id, email, name, role)
values (
  'PASTE-ADMIN-UUID-HERE',
  'admin@yourshop.com',
  'Admin',
  'admin'
);
```

Without a `profiles` row, login will fail with: **User profile not found**.

## 5. Configure Netlify (keys stay on the server)

Do not put the Supabase URL or anon key in the website files.

In Netlify → **Site configuration** → **Environment variables**, add:

- `SUPABASE_URL` = Project URL from Supabase → Project Settings → API
- `SUPABASE_ANON_KEY` = the **anon public** key from the same page

Use only the anon key. Never add the service role key.

The browser calls `/supabase` on your site. The edge function in `netlify/edge-functions/supabase-proxy.js` adds the key on the server.

Redeploy after saving the variables.

## 6. Create sales users

1. Add user in Supabase Auth.
2. Insert profile with `role = 'sales'`.

```sql
insert into profiles (id, email, name, role)
values ('SALES-UUID', 'sales@yourshop.com', 'Sales Staff', 'sales');
```

## 7. Deploy to Netlify (Supabase proxy)

Browsers in Myanmar often cannot reach `*.supabase.co`. This app calls `/supabase` on your Netlify site. The edge function forwards that to Supabase and adds the key from the environment variables in section 5.

1. Publish directory: `.` — no build command needed.
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then redeploy.

### Supabase dashboard URLs

In Supabase → **Authentication** → **URL configuration**:

- Set **Site URL** to your Netlify site (e.g. `https://your-site.netlify.app`)
- Add the same URL (and any custom domain) under **Redirect URLs**

Password login does not require email redirects, but this avoids future auth URL mismatches.

### Local development

Sign-in works on the deployed Netlify site, or locally with `npx netlify-cli dev` after the same environment variables are set. Opening the files directly does not have the proxy, so login will not reach Supabase.

If login says **Unexpected token '<'** or **Cannot reach the Supabase proxy**, `/supabase` is being served as the app page. Confirm the edge function is deployed and the environment variables exist, then redeploy.

### Verify after deploy (no VPN)

1. Open the Netlify site in Myanmar without VPN.
2. Login, load products, complete a sale.
3. In DevTools → Network, confirm requests go to `yoursite/.../supabase/auth/v1/...` and `.../supabase/rest/v1/...`.
4. Confirm there are **no** requests to `*.supabase.co`, and the page source does not contain the anon key.

### Database extras for this version

If the schema was already applied, run this in the SQL Editor as well:

```sql
alter table products add column if not exists price_locked boolean default false;
```

Then run the `protect_product_prices` function and trigger from [`supabase/schema.sql`](supabase/schema.sql) so sales staff can change stock but not prices.

## Quick checklist

- [ ] Schema ran successfully in SQL Editor
- [ ] Email auth enabled (confirm email off for testing)
- [ ] Auth user created
- [ ] Matching `profiles` row with `admin` or `sales`
- [ ] Netlify has `SUPABASE_URL` and `SUPABASE_ANON_KEY` (not in the website files)
- [ ] Netlify site URL added in Supabase Auth URL settings
- [ ] Without VPN: Network tab shows `/supabase/...` only (no `supabase.co`)
- [ ] Page source has no anon key and the login form does not show a password
